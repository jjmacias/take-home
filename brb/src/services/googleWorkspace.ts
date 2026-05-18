import { google } from 'googleapis';
import type { ActionResult, OffboardingRequest } from '../types';

const DRIVE_APP_ID = '55656082996'; // Google Drive app ID in the Admin Data Transfer API
const DEPARTED_OU = process.env.GWS_DEPARTED_OU ?? '/Departed Employees';
const ADMIN_EMAIL = process.env.GWS_ADMIN_EMAIL!;

function buildAuth() {
  const raw = process.env.GWS_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error('GWS_SERVICE_ACCOUNT_KEY is not set');
  const credentials = JSON.parse(raw);

  return new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: [
      'https://www.googleapis.com/auth/admin.directory.user',
      'https://www.googleapis.com/auth/admin.directory.user.security',
      'https://www.googleapis.com/auth/admin.datatransfer',
    ],
    subject: ADMIN_EMAIL,
  });
}

function gwsErrorMessage(e: any): string {
  if (e?.code === 404) return 'Account not found';
  if (e?.code === 403) return 'Permission denied — verify service account scopes and domain-wide delegation';
  if (e?.code === 400) return `Bad request: ${e?.errors?.[0]?.message ?? e.message}`;
  if (e?.code === 429) return 'API rate limit hit — retry shortly';
  if (e?.code === 503) return 'Google Workspace API temporarily unavailable';
  return e?.message ?? 'Unknown error';
}

export async function lookupGWSUser(email: string): Promise<{ id: string; name: string } | null> {
  const auth = buildAuth();
  const directory = google.admin({ version: 'directory_v1', auth });
  try {
    const { data } = await directory.users.get({ userKey: email });
    return { id: data.id!, name: data.name?.fullName ?? email };
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

export async function offboardUser(req: OffboardingRequest): Promise<ActionResult[]> {
  const results: ActionResult[] = [];
  const auth = buildAuth();
  const directory = google.admin({ version: 'directory_v1', auth });
  const datatransfer = google.admin({ version: 'datatransfer_v1', auth });

  // ── 1. Locate the user ──────────────────────────────────────────────────────
  let employeeId: string;
  let employeeName: string;
  let alreadySuspended = false;
  let alreadyInDepartedOU = false;

  try {
    const { data: user } = await directory.users.get({ userKey: req.employeeEmail });
    employeeId = user.id!;
    employeeName = user.name?.fullName ?? req.employeeEmail;
    alreadySuspended = user.suspended === true;
    alreadyInDepartedOU = user.orgUnitPath === DEPARTED_OU;

    results.push({
      action: 'Locate user account',
      status: 'success',
      details: `Found: ${employeeName} (ID: ${employeeId})${alreadySuspended ? ' — already suspended' : ''}`,
    });
  } catch (e: any) {
    results.push({
      action: 'Locate user account',
      status: 'failed',
      error: e?.code === 404
        ? `No Google Workspace account found for ${req.employeeEmail}`
        : gwsErrorMessage(e),
    });
    // Cannot continue without a valid user
    return results;
  }

  // ── 2. Suspend the account ─────────────────────────────────────────────────
  if (alreadySuspended) {
    results.push({
      action: 'Suspend Google Workspace account',
      status: 'skipped',
      details: 'Account was already suspended before this request',
    });
  } else {
    try {
      await directory.users.update({
        userKey: req.employeeEmail,
        requestBody: { suspended: true },
      });
      results.push({ action: 'Suspend Google Workspace account', status: 'success' });
    } catch (e: any) {
      results.push({
        action: 'Suspend Google Workspace account',
        status: 'failed',
        error: gwsErrorMessage(e),
      });
    }
  }

  // ── 3. Move to Departed Employees OU ───────────────────────────────────────
  if (alreadyInDepartedOU) {
    results.push({
      action: 'Move to Departed Employees OU',
      status: 'skipped',
      details: `Already in ${DEPARTED_OU}`,
    });
  } else {
    try {
      await directory.users.update({
        userKey: req.employeeEmail,
        requestBody: { orgUnitPath: DEPARTED_OU },
      });
      results.push({
        action: 'Move to Departed Employees OU',
        status: 'success',
        details: DEPARTED_OU,
      });
    } catch (e: any) {
      const msg = e?.code === 400 && e?.message?.toLowerCase().includes('org unit')
        ? `OU path "${DEPARTED_OU}" does not exist in Google Admin — create it first`
        : gwsErrorMessage(e);
      results.push({ action: 'Move to Departed Employees OU', status: 'failed', error: msg });
    }
  }

  // ── 4. Sign out all active sessions ────────────────────────────────────────
  try {
    await directory.users.signOut({ userKey: req.employeeEmail });
    results.push({ action: 'Sign out all active sessions', status: 'success' });
  } catch (e: any) {
    // 404 just means no active sessions — not a failure
    if (e?.code === 404) {
      results.push({
        action: 'Sign out all active sessions',
        status: 'skipped',
        details: 'No active sessions found',
      });
    } else {
      results.push({
        action: 'Sign out all active sessions',
        status: 'failed',
        error: gwsErrorMessage(e),
      });
    }
  }

  // ── 5. Revoke all OAuth tokens ─────────────────────────────────────────────
  try {
    const { data } = await directory.tokens.list({ userKey: req.employeeEmail });
    const tokens = data.items ?? [];

    if (tokens.length === 0) {
      results.push({ action: 'Revoke OAuth tokens', status: 'skipped', details: 'No tokens found' });
    } else {
      const deleteErrors: string[] = [];
      await Promise.allSettled(
        tokens.map(t =>
          directory.tokens
            .delete({ userKey: req.employeeEmail, clientId: t.clientId! })
            .catch((e: any) => deleteErrors.push(`${t.displayText ?? t.clientId}: ${gwsErrorMessage(e)}`))
        )
      );

      if (deleteErrors.length === 0) {
        results.push({
          action: 'Revoke OAuth tokens',
          status: 'success',
          details: `${tokens.length} token(s) revoked`,
        });
      } else {
        results.push({
          action: 'Revoke OAuth tokens',
          status: 'partial' as any,
          details: `${tokens.length - deleteErrors.length}/${tokens.length} revoked`,
          error: deleteErrors.join('; '),
        });
      }
    }
  } catch (e: any) {
    results.push({ action: 'Revoke OAuth tokens', status: 'failed', error: gwsErrorMessage(e) });
  }

  // ── 6. Transfer Drive ownership to manager ─────────────────────────────────
  let managerId: string;
  try {
    const { data: manager } = await directory.users.get({ userKey: req.managerEmail });
    managerId = manager.id!;
  } catch (e: any) {
    results.push({
      action: 'Transfer Drive files to manager',
      status: 'failed',
      error:
        e?.code === 404
          ? `Manager account not found: ${req.managerEmail}`
          : gwsErrorMessage(e),
    });
    return results;
  }

  try {
    await datatransfer.transfers.insert({
      requestBody: {
        oldOwnerUserId: employeeId,
        newOwnerUserId: managerId,
        applicationDataTransfers: [
          {
            applicationId: DRIVE_APP_ID,
            applicationTransferParams: [
              { key: 'PRIVACY_LEVEL', value: ['PRIVATE', 'SHARED'] },
            ],
          },
        ],
      },
    });
    results.push({
      action: 'Transfer Drive files to manager',
      status: 'success',
      details: `Ownership transfer initiated → ${req.managerEmail}`,
    });
  } catch (e: any) {
    results.push({
      action: 'Transfer Drive files to manager',
      status: 'failed',
      error: gwsErrorMessage(e),
    });
  }

  return results;
}

/**
 * RBAC guard for /offboard.
 *
 * Configure via SLACK_AUTHORIZED_USER_IDS (comma-separated Slack member IDs, e.g. U01234567).
 * Leave unset in local dev; in production this must be set or the app logs a security warning
 * and blocks the command.
 */

const AUTHORIZED_IDS = new Set(
  (process.env.SLACK_AUTHORIZED_USER_IDS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);

const ENFORCE = process.env.NODE_ENV === 'production' || process.env.SLACK_ENFORCE_RBAC === 'true';

export function isAuthorized(userId: string): { ok: boolean; reason?: string } {
  if (AUTHORIZED_IDS.size === 0) {
    if (ENFORCE) {
      return {
        ok: false,
        reason:
          'SLACK_AUTHORIZED_USER_IDS is not configured. Set it to a comma-separated list of Slack user IDs allowed to run /offboard.',
      };
    }
    // Dev mode — allow but warn loudly
    console.warn(
      `[SECURITY] /offboard run by ${userId} with no SLACK_AUTHORIZED_USER_IDS configured. Set this in production.`
    );
    return { ok: true };
  }

  if (AUTHORIZED_IDS.has(userId)) {
    return { ok: true };
  }

  return {
    ok: false,
    reason:
      'You are not authorized to run `/offboard`. Contact your IT administrator to be granted access.',
  };
}

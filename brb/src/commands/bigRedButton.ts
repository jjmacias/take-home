import type { App } from '@slack/bolt';
import { buildOffboardingModal, MODAL_CALLBACK_ID } from '../views/offboardingModal';
import { offboardUser, lookupGWSUser } from '../services/googleWorkspace';
import { logToNotion } from '../services/notion';
import { generateOffboardingSummary, parseNaturalLanguageRequest } from '../services/claude';
import { buildAuditBlocks } from '../utils/formatResults';
import { isAuthorized } from '../middleware/authorize';
import type { OffboardingResult } from '../types';

export function registerBigRedButton(app: App) {
  // ── /offboard slash command ────────────────────────────────────────────────
  // Supports:
  //   /offboard                          → opens blank modal
  //   /offboard jane@co.com              → pre-fills employee email
  //   /offboard offboard jane she left   → NLP parse via Claude
  app.command('/offboard', async ({ command, ack, client, logger }) => {
    await ack();

    // ── RBAC ────────────────────────────────────────────────────────────────
    const auth = isAuthorized(command.user_id);
    if (!auth.ok) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: `🚫 ${auth.reason}`,
      });
      return;
    }

    // ── Parse command text ───────────────────────────────────────────────────
    const text = command.text.trim();
    let prefillEmail = '';

    if (text) {
      // Fast path: bare email
      const emailRe = /^[\w.+-]+@[\w-]+\.[a-zA-Z]{2,}$/i;
      if (emailRe.test(text)) {
        prefillEmail = text;
      } else {
        // Try NLP parsing via Claude
        try {
          const parsed = await parseNaturalLanguageRequest(text);
          if (parsed?.employeeEmail) prefillEmail = parsed.employeeEmail;
        } catch (e) {
          logger.warn('NLP parse failed, falling back to empty prefill', e);
        }
      }
    }

    try {
      await client.views.open({
        trigger_id: command.trigger_id,
        view: buildOffboardingModal(prefillEmail) as any,
      });
    } catch (e) {
      logger.error('Failed to open offboarding modal', e);
    }
  });

  // ── Modal submission ───────────────────────────────────────────────────────
  app.view(MODAL_CALLBACK_ID, async ({ ack, view, client, body, logger }) => {
    const values = view.state.values;
    const employeeEmail = values.employee_block.employee_email.value?.trim() ?? '';
    const managerEmail = values.manager_block.manager_email.value?.trim() ?? '';
    const reason = values.reason_block.reason.value?.trim() ?? '';

    const emailRe = /^[\w.+-]+@[\w-]+\.[a-zA-Z]{2,}$/i;
    const errors: Record<string, string> = {};

    if (!emailRe.test(employeeEmail)) {
      errors.employee_block = 'Enter a valid email address';
    }
    if (!emailRe.test(managerEmail)) {
      errors.manager_block = 'Enter a valid email address';
    } else if (employeeEmail.toLowerCase() === managerEmail.toLowerCase()) {
      errors.manager_block = 'Manager cannot be the same person as the employee being offboarded';
    }

    if (Object.keys(errors).length === 0) {
      // Validate manager exists in GWS — do this before ack() so we can return inline errors
      try {
        const manager = await lookupGWSUser(managerEmail);
        if (!manager) {
          errors.manager_block = `No Google Workspace account found for ${managerEmail}`;
        }
      } catch (e) {
        // GWS unreachable — don't block submission; the offboarding flow will surface the error
        logger.warn('Manager GWS lookup failed during modal validation', e);
      }
    }

    if (Object.keys(errors).length > 0) {
      await ack({ response_action: 'errors', errors } as any);
      return;
    }

    await ack(); // must respond within 3 s

    const triggeredBy = body.user.id;
    const triggeredByName = body.user.name;
    const triggeredAt = new Date();
    const auditChannel = process.env.SLACK_AUDIT_CHANNEL!;

    // Post "in-progress" message
    let processingMsgTs: string | undefined;
    try {
      const msg = await client.chat.postMessage({
        channel: auditChannel,
        text: `⏳ Offboarding *${employeeEmail}* — triggered by <@${triggeredBy}>. Running actions...`,
      });
      processingMsgTs = msg.ts;
    } catch (e) {
      logger.error('Failed to post processing message', e);
    }

    // ── GWS operations ────────────────────────────────────────────────────────
    const actions = await offboardUser({
      employeeEmail,
      managerEmail,
      reason,
      triggeredBy,
      triggeredByName,
      triggeredAt,
      channelId: auditChannel,
    });

    const failedCount = actions.filter(a => a.status === 'failed').length;
    const successCount = actions.filter(a => a.status === 'success').length;
    const overallStatus =
      failedCount === 0
        ? 'success'
        : successCount === 0
        ? 'failed'
        : 'partial';

    const result: OffboardingResult = {
      employeeEmail,
      managerEmail,
      reason,
      triggeredBy,
      triggeredByName,
      triggeredAt,
      channelId: auditChannel,
      actions,
      overallStatus,
    };

    // ── Claude LLM summary (runs in parallel with Notion logging) ─────────────
    const [llmSummary, notionPageId] = await Promise.allSettled([
      generateOffboardingSummary(result),
      logToNotion(result),
    ]).then(([llm, notion]) => [
      llm.status === 'fulfilled' ? llm.value : undefined,
      notion.status === 'fulfilled' ? notion.value : undefined,
    ] as const);

    if (llmSummary) result.llmSummary = llmSummary;
    if (notionPageId) result.notionPageId = notionPageId;

    let notionUrl: string | undefined;
    if (notionPageId) {
      notionUrl = `https://www.notion.so/${notionPageId.replace(/-/g, '')}`;
    }

    // ── Post audit summary ─────────────────────────────────────────────────────
    const auditBlocks = buildAuditBlocks(result, llmSummary, notionUrl);
    const fallbackText = `Offboarding ${overallStatus} for ${employeeEmail}`;

    try {
      if (processingMsgTs) {
        await client.chat.update({
          channel: auditChannel,
          ts: processingMsgTs,
          text: fallbackText,
          blocks: auditBlocks as any,
        });
      } else {
        await client.chat.postMessage({
          channel: auditChannel,
          text: fallbackText,
          blocks: auditBlocks as any,
        });
      }
    } catch (e) {
      logger.error('Failed to post audit summary', e);
    }
  });
}

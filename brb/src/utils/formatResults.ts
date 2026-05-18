import type { OffboardingResult, ActionResult, LLMSummary } from '../types';

function statusEmoji(a: ActionResult): string {
  if (a.status === 'success') return '✅';
  if (a.status === 'skipped') return '⏭️';
  return '❌';
}

function riskEmoji(level: LLMSummary['riskLevel']): string {
  return level === 'low' ? '🟢' : level === 'medium' ? '🟡' : '🔴';
}

function actionLine(a: ActionResult): string {
  const parts = [`${statusEmoji(a)} *${a.action}*`];
  if (a.details) parts.push(a.details);
  if (a.error) parts.push(`_${a.error}_`);
  return parts.join(' — ');
}

export function buildAuditBlocks(
  result: OffboardingResult,
  llmSummary?: LLMSummary,
  notionUrl?: string
) {
  const overallLabel =
    result.overallStatus === 'success'
      ? '✅ All actions completed'
      : result.overallStatus === 'partial'
      ? '⚠️ Completed with errors'
      : '❌ Failed';

  const blocks: object[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🔴 Employee Offboarding Report' },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Employee*\n${result.employeeEmail}` },
        { type: 'mrkdwn', text: `*Manager / Delegate*\n${result.managerEmail}` },
        { type: 'mrkdwn', text: `*Triggered by*\n${result.triggeredByName}` },
        {
          type: 'mrkdwn',
          text: `*Time*\n<!date^${Math.floor(result.triggeredAt.getTime() / 1000)}^{date_short_pretty} at {time}|${result.triggeredAt.toISOString()}>`,
        },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Reason:* ${result.reason}` },
    },
    { type: 'divider' },
  ];

  // ── LLM-generated summary ──────────────────────────────────────────────────
  if (llmSummary) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*AI Summary* ${riskEmoji(llmSummary.riskLevel)} _Risk: ${llmSummary.riskLevel}_`,
          llmSummary.summary,
          llmSummary.errorAnalysis ? `\n*Root cause:* ${llmSummary.errorAnalysis}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    });

    if (llmSummary.followUpActions.length > 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Recommended follow-ups:*\n${llmSummary.followUpActions.map((a, i) => `${i + 1}. ${a}`).join('\n')}`,
        },
      });
    }

    blocks.push({ type: 'divider' });
  }

  // ── Action log ─────────────────────────────────────────────────────────────
  const notionLink = notionUrl ? `\n<${notionUrl}|View full audit log in Notion>` : '';

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Action Log: ${overallLabel}*\n\n${result.actions.map(actionLine).join('\n')}${notionLink}`,
    },
  });

  return blocks;
}

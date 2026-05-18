import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { OffboardingResult, LLMSummary } from '../types';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Stable system prompt — cached via prompt caching to avoid re-tokenising on every offboarding
const SYSTEM_PROMPT = `You are an IT security and compliance specialist reviewing automated Google Workspace offboarding operations.

You receive structured data about actions performed during an employee offboarding and must produce:
1. A concise professional summary (2-3 sentences) of what happened
2. Root-cause analysis for any failures, or null if all actions succeeded
3. Ordered list of specific follow-up actions the IT team must take

Security posture: always flag when account suspension or session revocation failed, as those are the highest-risk gaps. Consider access vectors like: shared drives, API keys in code repos, external SaaS app access, hardware tokens, and third-party OAuth grants the automation could not revoke.`;

const OffboardingSummarySchema = z.object({
  summary: z.string().describe('2-3 sentence plain-English summary of the offboarding outcome'),
  errorAnalysis: z
    .string()
    .nullable()
    .describe('Root-cause analysis of failures, or null if all actions succeeded'),
  followUpActions: z
    .array(z.string())
    .describe('Ordered list of concrete follow-up actions for the IT team, most urgent first'),
  riskLevel: z
    .enum(['low', 'medium', 'high'])
    .describe('Overall risk level based on which actions succeeded vs failed'),
});

const ParsedRequestSchema = z.object({
  employeeEmail: z
    .string()
    .nullable()
    .describe('Departing employee email address, or null if not clearly identifiable'),
  managerEmail: z
    .string()
    .nullable()
    .describe('Manager or delegate email address, or null if not mentioned'),
  reason: z.string().nullable().describe('Reason for departure, or null if not mentioned'),
});

export async function generateOffboardingSummary(result: OffboardingResult): Promise<LLMSummary> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return fallbackSummary(result);
  }

  const actionLog = result.actions
    .map(
      a =>
        `[${a.status.toUpperCase()}] ${a.action}${a.details ? `: ${a.details}` : ''}${a.error ? ` — Error: ${a.error}` : ''}`
    )
    .join('\n');

  try {
    const response = await client.messages.parse({
      model: 'claude-opus-4-7',
      max_tokens: 1024,
      thinking: { type: 'adaptive' },
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          // Cache the stable system prompt — saves ~$0.005 per offboarding at scale
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: `Analyze this offboarding and respond with the structured JSON format.

Employee: ${result.employeeEmail}
Manager / delegate: ${result.managerEmail}
Triggered by: ${result.triggeredByName}
Time: ${result.triggeredAt.toISOString()}
Reason: ${result.reason}
Overall status: ${result.overallStatus}

Actions taken:
${actionLog}`,
        },
      ],
      output_config: {
        format: zodOutputFormat(OffboardingSummarySchema),
      },
    });

    return (
      response.parsed_output ?? fallbackSummary(result)
    );
  } catch (e: any) {
    console.error('[Claude] generateOffboardingSummary failed:', e.message);
    return fallbackSummary(result);
  }
}

/**
 * Attempts to extract structured offboarding parameters from a free-form Slack message.
 * Returns null if no employee email can be identified.
 */
export async function parseNaturalLanguageRequest(
  text: string
): Promise<{ employeeEmail?: string; managerEmail?: string; reason?: string } | null> {
  if (!text || text.trim().length < 5) return null;

  // Fast path: text is already a bare email address
  const bareEmail = /^[\w.+-]+@[\w-]+\.[a-zA-Z]{2,}$/i;
  if (bareEmail.test(text.trim())) {
    return { employeeEmail: text.trim() };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  try {
    const response = await client.messages.parse({
      model: 'claude-opus-4-7',
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: `Extract offboarding details from this Slack command text. Return null for any field not clearly present.

Command text: "${text}"`,
        },
      ],
      output_config: {
        format: zodOutputFormat(ParsedRequestSchema),
      },
    });

    const parsed = response.parsed_output;
    if (!parsed?.employeeEmail) return null;

    return {
      employeeEmail: parsed.employeeEmail ?? undefined,
      managerEmail: parsed.managerEmail ?? undefined,
      reason: parsed.reason ?? undefined,
    };
  } catch (e: any) {
    console.error('[Claude] parseNaturalLanguageRequest failed:', e.message);
    return null;
  }
}

function fallbackSummary(result: OffboardingResult): LLMSummary {
  const failed = result.actions.filter(a => a.status === 'failed');
  return {
    summary: `Offboarding for ${result.employeeEmail} completed with status: ${result.overallStatus}. ${failed.length} action(s) failed and require manual follow-up.`,
    errorAnalysis: failed.length > 0 ? failed.map(a => `${a.action}: ${a.error}`).join('; ') : null,
    followUpActions: [
      'Verify account suspension in Google Admin Console',
      'Check for any remaining active sessions',
      'Review shared Drive files and external app access',
      'Rotate any API keys or credentials the employee may have had',
    ],
    riskLevel: result.overallStatus === 'success' ? 'low' : result.overallStatus === 'partial' ? 'medium' : 'high',
  };
}

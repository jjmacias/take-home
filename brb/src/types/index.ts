export interface OffboardingRequest {
  employeeEmail: string;
  managerEmail: string;
  reason: string;
  triggeredBy: string;    // Slack user who ran the command
  triggeredByName: string;
  triggeredAt: Date;
  channelId: string;      // channel where command was invoked
}

export type ActionStatus = 'success' | 'failed' | 'skipped';

export interface ActionResult {
  action: string;
  status: ActionStatus;
  details?: string;
  error?: string;
}

export interface LLMSummary {
  summary: string;
  errorAnalysis: string | null;
  followUpActions: string[];
  riskLevel: 'low' | 'medium' | 'high';
}

export interface OffboardingResult extends OffboardingRequest {
  actions: ActionResult[];
  overallStatus: 'success' | 'partial' | 'failed';
  notionPageId?: string;
  llmSummary?: LLMSummary;
}

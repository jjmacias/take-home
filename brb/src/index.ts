import 'dotenv/config';
import { App, LogLevel } from '@slack/bolt';
import { registerBigRedButton } from './commands/bigRedButton';

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function warnIfMissing(key: string, hint: string) {
  if (!process.env[key]) {
    console.warn(`[WARN] ${key} is not set — ${hint}`);
  }
}

const app = new App({
  token: requireEnv('SLACK_BOT_TOKEN'),
  appToken: requireEnv('SLACK_APP_TOKEN'),
  socketMode: true,
  logLevel: LogLevel.INFO,
});

// Non-fatal warnings for optional-but-recommended config
warnIfMissing('ANTHROPIC_API_KEY', 'LLM summaries will fall back to a static template');
warnIfMissing('NOTION_DATABASE_ID', 'audit entries will not be logged to Notion');
warnIfMissing('SLACK_AUTHORIZED_USER_IDS', 'all Slack users can run /offboard (set this in production)');

registerBigRedButton(app);

(async () => {
  await app.start();
  console.log('⚡️ BRB — /offboard is live (Socket Mode)');
})();

# BRB — Big Red Button

Slack app for automated Google Workspace employee offboarding. Triggered via `/offboard`, it suspends the account, revokes sessions and OAuth tokens, moves the user to a Departed Employees OU, transfers Drive ownership to a manager, and posts a full audit report to a Slack channel — with an AI-generated summary and risk assessment powered by Claude.

---

## What it does

When `/offboard` is submitted:

1. **Suspends** the GWS account
2. **Moves** the user to the Departed Employees OU
3. **Signs out** all active sessions
4. **Revokes** all OAuth tokens
5. **Transfers** Drive file ownership to the specified manager
6. **Generates** an AI summary with risk level and follow-up recommendations (Claude)
7. **Logs** a full audit record to a Notion database
8. **Posts** the complete report to a designated Slack audit channel

Each step is recorded independently — partial failures are surfaced clearly rather than silently swallowed.

---

## Prerequisites

- Node.js 18+
- A Slack app with Socket Mode enabled
- A Google Workspace account with a service account configured for Domain-Wide Delegation
- Anthropic API key (optional — falls back to a static summary if absent)
- Notion integration (optional — audit logging is skipped if absent)

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in all values in `.env`. See [Environment variables](#environment-variables) below.

### 3. Configure your Slack app

In [api.slack.com/apps](https://api.slack.com/apps):

- **Socket Mode** → Enable, generate an App-Level Token with `connections:write` scope → `SLACK_APP_TOKEN`
- **Slash Commands** → Create `/offboard` (Request URL can be anything in Socket Mode)
- **OAuth & Permissions** → Add bot scopes: `chat:write`, `chat:write.public`, `commands`
- Install the app to your workspace → `SLACK_BOT_TOKEN`

### 4. Configure Google Workspace Domain-Wide Delegation

1. Create a service account in GCP and download the JSON key
2. Enable **Admin SDK API** and **Google Drive API** in your GCP project
3. In [Google Admin Console](https://admin.google.com) → Security → Access and data control → API controls → Domain-wide delegation → Add new:
   - **Client ID**: the numeric OAuth2 Client ID from your service account (not the email)
   - **Scopes**:
     ```
     https://www.googleapis.com/auth/admin.directory.user,https://www.googleapis.com/auth/admin.directory.user.security,https://www.googleapis.com/auth/admin.datatransfer
     ```
4. Stringify the JSON key to a single line for `.env`:
   ```bash
   cat your-key.json | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)))"
   ```

### 5. Set up Notion (optional)

Create an internal integration at [notion.so/my-integrations](https://www.notion.so/my-integrations), then run:

```bash
NOTION_PARENT_PAGE_ID=<your-page-id> npm run setup:notion
```

Copy the printed database ID into `NOTION_DATABASE_ID` in your `.env`.

### 6. Run

```bash
# Development (auto-restarts on changes)
npm run dev

# Production
npm run build && npm start
```

---

## Usage

```
/offboard                         opens the modal with blank fields
/offboard jane@company.com        pre-fills the employee email
/offboard Jane left the company   natural language — Claude extracts the email
```

The modal validates both emails against Google Workspace before submission. Once confirmed, the offboarding runs and the audit report is posted to `SLACK_AUDIT_CHANNEL`.

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `SLACK_BOT_TOKEN` | Yes | Bot token (`xoxb-...`) from OAuth & Permissions |
| `SLACK_APP_TOKEN` | Yes | App-level token (`xapp-...`) for Socket Mode |
| `SLACK_AUDIT_CHANNEL` | Yes | Channel ID where audit reports are posted |
| `SLACK_AUTHORIZED_USER_IDS` | Prod | Comma-separated Slack member IDs allowed to run `/offboard` |
| `SLACK_ENFORCE_RBAC` | No | Set `true` to block all requests when the allowlist is empty |
| `ANTHROPIC_API_KEY` | No | Enables AI summaries; falls back to static template if absent |
| `GWS_SERVICE_ACCOUNT_KEY` | Yes | Stringified service account JSON with Domain-Wide Delegation |
| `GWS_ADMIN_EMAIL` | Yes | Super-admin email used to impersonate when calling Admin SDK |
| `GWS_DEPARTED_OU` | No | OU path for departed employees (default: `/Departed Employees`) |
| `NOTION_TOKEN` | No | Notion internal integration token |
| `NOTION_DATABASE_ID` | No | Target database for audit logs |

---

## RBAC

Set `SLACK_AUTHORIZED_USER_IDS` to a comma-separated list of Slack member IDs. To find your ID: click your profile in Slack → **⋮** → **Copy member ID**.

In production, also set `SLACK_ENFORCE_RBAC=true` — this blocks all offboarding requests if the allowlist is ever accidentally cleared.

---

## Project structure

```
src/
  commands/       Slack slash command and modal handlers
  middleware/     RBAC authorization
  services/       Google Workspace, Claude, and Notion integrations
  utils/          Slack Block Kit audit message builder
  views/          Offboarding modal definition
  types/          Shared TypeScript types
scripts/
  setupNotion.ts  One-time Notion database creation
```

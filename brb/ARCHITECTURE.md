# BRB — Architecture

---

## System Overview

BRB connects four external systems. The app runs as a persistent Node.js process and communicates with Slack over an outbound WebSocket (Socket Mode) — no inbound ports or public URLs required.

```mermaid
graph TB
    subgraph Slack["Slack Workspace"]
        CMD["/offboard command"]
        MODAL["Confirmation Modal"]
        AUDIT["#audit-channel"]
    end

    subgraph BRB["BRB — Node.js / TypeScript"]
        CMD_HANDLER["Command Handler\nbigRedButton.ts"]
        RBAC["RBAC Middleware\nauthorize.ts"]
        GWS_SVC["GWS Service\ngoogleWorkspace.ts"]
        CLAUDE_SVC["Claude Service\nclaude.ts"]
        NOTION_SVC["Notion Service\nnotion.ts"]
        FORMATTER["Block Kit Formatter\nformatResults.ts"]
    end

    subgraph GWS["Google Workspace"]
        DIR["Admin Directory API v1\nUsers · Sessions · Tokens · OUs"]
        DT["Data Transfer API v1\nDrive ownership"]
    end

    subgraph Anthropic["Anthropic"]
        CLAUDE["Claude API\nclaude-opus-4-7"]
    end

    subgraph Notion["Notion"]
        DB[("Audit Log Database")]
    end

    subgraph GCP["Google Cloud Platform"]
        SA["Service Account\n+ Domain-Wide Delegation"]
    end

    CMD -->|Socket Mode WebSocket| CMD_HANDLER
    CMD_HANDLER --> RBAC
    CMD_HANDLER --> GWS_SVC
    CMD_HANDLER --> CLAUDE_SVC
    CMD_HANDLER --> NOTION_SVC
    CMD_HANDLER --> FORMATTER
    FORMATTER --> AUDIT

    GWS_SVC -->|JWT impersonation| SA
    SA -->|impersonates super-admin| DIR
    SA -->|impersonates super-admin| DT

    CLAUDE_SVC -->|Messages API| CLAUDE
    NOTION_SVC -->|Pages API| DB

    MODAL <-->|view_submission| CMD_HANDLER
```

---

## Request Lifecycle

Full sequence from slash command to audit report.

```mermaid
sequenceDiagram
    actor IT as IT Admin
    participant S as Slack
    participant BRB as BRB App
    participant GWS as Google Workspace
    participant C as Claude
    participant N as Notion

    IT->>S: /offboard [text]
    S->>BRB: slash_command event (Socket Mode)

    BRB->>BRB: RBAC check
    alt unauthorized
        BRB->>S: ephemeral error message
    end

    opt free-text input
        BRB->>C: extract email from text (NLP)
        C-->>BRB: { employeeEmail }
    end

    BRB->>S: views.open (modal)
    S->>IT: display modal

    IT->>S: submit modal
    S->>BRB: view_submission event

    BRB->>BRB: validate email format
    BRB->>BRB: check employee ≠ manager
    BRB->>GWS: users.get(managerEmail)
    GWS-->>BRB: manager record or 404

    alt validation failed
        BRB->>S: response_action: errors (inline, modal stays open)
        S->>IT: show field errors
    end

    BRB->>S: ack()
    BRB->>S: post "⏳ Offboarding in progress..."

    rect rgb(240, 245, 255)
        Note over BRB,GWS: Sequential GWS operations
        BRB->>GWS: users.get(employeeEmail)
        GWS-->>BRB: user record + ID
        BRB->>GWS: users.update → suspended: true
        BRB->>GWS: users.update → orgUnitPath: /Departed Employees
        BRB->>GWS: users.signOut(employeeEmail)
        BRB->>GWS: tokens.list + tokens.delete (each token)
        BRB->>GWS: transfers.insert (Drive → manager)
        GWS-->>BRB: action results
    end

    rect rgb(240, 255, 245)
        Note over BRB,N: Parallel — neither blocks the other
        par
            BRB->>C: generateOffboardingSummary(result)
            C-->>BRB: { summary, riskLevel, followUpActions, errorAnalysis }
        and
            BRB->>N: logToNotion(result)
            N-->>BRB: notionPageId
        end
    end

    BRB->>S: chat.update → full audit report (Block Kit)
    S->>IT: audit report in #audit-channel
```

---

## GWS Authentication

The app never stores user credentials. A GCP service account with Domain-Wide Delegation impersonates a super-admin at request time.

```mermaid
sequenceDiagram
    participant BRB as BRB App
    participant GCP as GCP / OAuth2
    participant GWS as Google Workspace Admin

    Note over BRB: buildAuth() called per request
    BRB->>BRB: Parse GWS_SERVICE_ACCOUNT_KEY from env
    BRB->>BRB: Build JWT signed with SA private key<br/>subject: GWS_ADMIN_EMAIL (super-admin)

    BRB->>GCP: Exchange JWT for access token
    Note over GCP: Validates SA identity<br/>Checks DWD grant for requested scopes
    GCP-->>BRB: access_token (short-lived)

    BRB->>GWS: API call with access_token
    Note over GWS: Request executes as the<br/>impersonated super-admin
    GWS-->>BRB: response
```

**Scopes granted via DWD:**

| Scope | Purpose |
|---|---|
| `admin.directory.user` | Read users, suspend, change OU |
| `admin.directory.user.security` | Sign out sessions, list/revoke OAuth tokens |
| `admin.datatransfer` | Initiate Drive ownership transfer |

---

## GWS Offboarding Steps

Each step is independent — a failure does not abort subsequent steps. Overall status rolls up from individual results.

```mermaid
flowchart TD
    START([Modal submitted]) --> LOCATE

    LOCATE["1 · Locate user account\nusers.get(employeeEmail)"]
    LOCATE -->|404 / error| ABORT([Abort — no user to offboard])
    LOCATE -->|found| SUSPEND

    SUSPEND{"Already\nsuspended?"}
    SUSPEND -->|yes| SKIP_SUSPEND["2 · SKIPPED"]
    SUSPEND -->|no| DO_SUSPEND["2 · Suspend account\nusers.update suspended:true"]
    SKIP_SUSPEND --> OU
    DO_SUSPEND --> OU

    OU{"Already in\nDeparted OU?"}
    OU -->|yes| SKIP_OU["3 · SKIPPED"]
    OU -->|no| DO_OU["3 · Move to Departed Employees OU\nusers.update orgUnitPath"]
    SKIP_OU --> SIGNOUT
    DO_OU --> SIGNOUT

    SIGNOUT["4 · Sign out all sessions\nusers.signOut()"]
    SIGNOUT -->|404 = no sessions| SKIP_SO["4 · SKIPPED"]
    SIGNOUT -->|ok| OK_SO["4 · SUCCESS"]
    SKIP_SO --> TOKENS
    OK_SO --> TOKENS

    TOKENS["5 · Revoke OAuth tokens\ntokens.list + tokens.delete each"]
    TOKENS --> DRIVE

    DRIVE["6 · Transfer Drive to manager\ntransfers.insert(employeeId → managerId)"]
    DRIVE --> ROLLUP

    ROLLUP{"Roll up\nstatus"}
    ROLLUP -->|all success/skipped| S([✅ success])
    ROLLUP -->|some failed| P([⚠️ partial])
    ROLLUP -->|all failed| F([❌ failed])
```

---

## Module Dependencies

```mermaid
graph LR
    subgraph Entry
        IDX["index.ts"]
    end

    subgraph Commands
        BRB["bigRedButton.ts"]
    end

    subgraph Middleware
        AUTH["authorize.ts"]
    end

    subgraph Services
        GWS_S["googleWorkspace.ts"]
        CLA_S["claude.ts"]
        NOT_S["notion.ts"]
    end

    subgraph Views
        MOD["offboardingModal.ts"]
    end

    subgraph Utils
        FMT["formatResults.ts"]
    end

    subgraph Types
        TYP["types/index.ts"]
    end

    IDX --> BRB
    BRB --> AUTH
    BRB --> GWS_S
    BRB --> CLA_S
    BRB --> NOT_S
    BRB --> MOD
    BRB --> FMT
    GWS_S --> TYP
    CLA_S --> TYP
    NOT_S --> TYP
    FMT --> TYP
```

---

## Data Model

```mermaid
erDiagram
    OffboardingRequest {
        string employeeEmail
        string managerEmail
        string reason
        string triggeredBy
        string triggeredByName
        Date triggeredAt
        string channelId
    }

    ActionResult {
        string action
        enum status
        string details
        string error
    }

    LLMSummary {
        string summary
        string errorAnalysis
        string[] followUpActions
        enum riskLevel
    }

    OffboardingResult {
        enum overallStatus
        string notionPageId
    }

    OffboardingResult ||--|| OffboardingRequest : extends
    OffboardingResult ||--o{ ActionResult : actions
    OffboardingResult ||--o| LLMSummary : llmSummary
```

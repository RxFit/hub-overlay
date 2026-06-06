# Paperclip Backend API — CEO Operational Reference

> This file documents the actual HTTP endpoints and CLI commands available to the CEO Agent for managing Paperclip workspaces autonomously. All credentials are env-var sourced. Never hardcode keys.

---

## Authentication

```
Base URL:  ${PAPERCLIP_BASE_URL}   (default: http://127.0.0.1:3100)
Header:    Authorization: Bearer ${PAPERCLIP_API_KEY}
Content:   Content-Type: application/json
```

---

## Workspace IDs (CEO — RxFit)

| Role | Workspace Name | Company ID |
|---|---|---|
| **CEO (own)** | CEO — RxFit | `8f2acc3d-f2dc-4f8c-897e-7c400e91fd85` |
| **COO** | COO — RxFit | `a9b508d7-453a-4648-8c3c-9fac040f2b72` |
| **CMO** | RxFit - Organic Growth Marketing | `829b2493-97ed-4cb9-8775-ff8298dcf650` |
| **CTO** | RxFit Technical | `be829d1d-1949-4932-9dc0-5a46948f3c77` |
| **CFO** | RxFit Revenue | `424c62f5-933c-4b5b-a9c5-2a9e98ec3bb5` |

---

## Core API Operations

### 1. Read Your Own Issue Queue

```http
GET ${PAPERCLIP_BASE_URL}/api/companies/8f2acc3d-f2dc-4f8c-897e-7c400e91fd85/issues
Authorization: Bearer ${PAPERCLIP_API_KEY}
```

Returns the current INIT issue or any issue assigned to your workspace. This is your "inbox."

---

### 2. Read an Officer Agent's Queue

```http
GET ${PAPERCLIP_BASE_URL}/api/companies/{companyId}/issues
Authorization: Bearer ${PAPERCLIP_API_KEY}
```

Replace `{companyId}` with the officer's workspace ID from the table above. Use this to check whether a CMO/CTO/CFO/COO issue is still in backlog, todo, or completed.

**Valid status values:** `backlog` | `todo` | `in_progress` | `done` | `cancelled`

---

### 3. Create a Task for an Officer Agent

Use this to delegate work to a direct report:

```http
POST ${PAPERCLIP_BASE_URL}/api/companies/{officerCompanyId}/issues
Authorization: Bearer ${PAPERCLIP_API_KEY}
Content-Type: application/json

{
  "title": "[CEO] Task title here",
  "description": "Full task description with context, expected output, and deadline.",
  "priority": "high"
}
```

**Priority values:** `low` | `medium` | `high` | `urgent`

After creating the issue, assign it to the officer's agent (get agentId from step 4):

```http
PATCH ${PAPERCLIP_BASE_URL}/api/issues/{newIssueId}
Authorization: Bearer ${PAPERCLIP_API_KEY}
Content-Type: application/json

{
  "assigneeAgentId": "{officerAgentId}",
  "status": "todo"
}
```

---

### 4. Check an Officer Agent's Status

```http
GET ${PAPERCLIP_BASE_URL}/api/companies/{companyId}/agents
Authorization: Bearer ${PAPERCLIP_API_KEY}
```

Returns agent object with `status` field:
- `idle` — agent is online and waiting for work
- `active` — agent is currently executing an issue
- `error` — agent has a problem (escalate to Antigravity)
- `paused` — agent is paused

**Known agent IDs (updated 2026-06-05 from Cloud Run audit):**
| Agent | ID |
|---|---|
| CEO (own) | `82984f59-633e-4cdf-b8a1-d0499f6c226a` |
| COO | `002a8e1c-9206-46a2-bf6e-4ffb46cbb254` |
| CMO | `360e4642-135a-493d-b500-a532d23b3714` |
| CTO | `91873c35-2586-4623-bb78-23627d3c5ca9` |
| CFO | `4f4548b7-9f7d-458b-b4ec-3b373a0fff57` |

---

### 5. Update an Issue (Change Status, Add Comment)

```http
PATCH ${PAPERCLIP_BASE_URL}/api/issues/{issueId}
Authorization: Bearer ${PAPERCLIP_API_KEY}
Content-Type: application/json

{
  "status": "done",
  "comment": "Weekly briefing delivered to Antigravity. No escalations this cycle."
}
```

Use this to:
- Mark your own INIT issue as `done` after first full briefing cycle
- Update task status as officers complete work
- Add comments to track progress notes

---

### 6. Read a Specific Issue by ID

```http
GET ${PAPERCLIP_BASE_URL}/api/issues/{issueId}
Authorization: Bearer ${PAPERCLIP_API_KEY}
```

Returns full issue object including current status, assignee, and last activity timestamp.

---

### 7. List All Companies (Orientation / Audit Only)

```http
GET ${PAPERCLIP_BASE_URL}/api/companies
Authorization: Bearer ${PAPERCLIP_API_KEY}
```

Returns all 20+ workspaces across the Antigravity portfolio. Use this only for orientation — not for cross-project interference.

---

## CLI Alternative (when HTTP is unavailable)

```bash
# Create an issue for an officer
npx paperclipai issue create \
  --api-base ${PAPERCLIP_BASE_URL} \
  --api-key ${PAPERCLIP_API_KEY} \
  --company-id {officerCompanyId} \
  --title "[CEO] Task title" \
  --description "Task description" \
  --json

# List issues in a company
npx paperclipai issue list \
  --api-base ${PAPERCLIP_BASE_URL} \
  --api-key ${PAPERCLIP_API_KEY} \
  --company-id {companyId} \
  --json

# Check agent status
npx paperclipai agent list \
  --api-base ${PAPERCLIP_BASE_URL} \
  --api-key ${PAPERCLIP_API_KEY} \
  --company-id {companyId} \
  --json
```

---

## Error Handling Rules

| HTTP Status | Meaning | Action |
|---|---|---|
| `200/201` | Success | Continue |
| `400` | Validation error (bad enum, missing field) | Check request body — common cause: invalid `status` value |
| `401` | Auth failure | Check `${PAPERCLIP_API_KEY}` env var |
| `404` | Route not found | Check endpoint path — use company-scoped paths |
| `500` | Internal server error | Check server log; may be constraint violation (e.g., duplicate issue prefix) |

---

## Escalation Triggers (Mandatory)

- Any officer agent status = `error` → flag to Antigravity immediately
- Any `500` on a create operation → do not retry more than once; escalate
- Any issue stuck in `todo` > 48 hours without activity → escalate to COO

---

## Key Failure Escalation Protocol

When any agent encounters an API key error, the agent MUST:
1. Identify the error type from the table below
2. Create an **URGENT** issue in the CEO workspace with the error code
3. Do NOT retry more than once — escalate immediately

| Error Code | Meaning | CEO Action Required |
|---|---|---|
| `KEY_EXPIRED` | Token/key has expired | Rotate key, update env var on Railway |
| `KEY_RATE_LIMITED` | API quota exhausted | Check billing, upgrade plan or wait for reset |
| `KEY_REVOKED` | Key was manually revoked | Generate new key, update env var |
| `KEY_INVALID` | Key format/value is incorrect | Verify key in provider dashboard |
| `KEY_UNAUTHORIZED` | Key lacks required permissions | Update key scopes/permissions |
| `KEY_BILLING_FAILED` | Provider payment method declined | Update billing on provider account |
| `KEY_NEEDED` | Required key not configured in workspace | Create issue with Settings > API Keys connection instructions |

**Issue Template:**
```json
{
  "title": "[KEY-FAIL] {ERROR_CODE}: {KEY_NAME} in {WORKSPACE_NAME}",
  "description": "Agent: {agent_name}\nKey: {key_name}\nError: {error_code}\nHTTP Status: {status}\nResponse: {error_body}\nTimestamp: {iso_timestamp}\nAction Required: {recommended_action}",
  "priority": "urgent"
}
```

**Key Scope Reference:** See `orchestration/secrets-manifest.json` for which keys each workspace is authorized to use.

---

*Last updated: 2026-06-06 by Antigravity — RxFit CEO workspace bootstrap — added key failure escalation protocol*

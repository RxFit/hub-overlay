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

**Known agent IDs:**
| Agent | ID |
|---|---|
| CEO (own) | `0648c755-cd93-4d9d-96d9-dd71e658b614` |
| COO | `d9986cc8-12e7-42cd-97c0-55e2608a3113` |
| CMO | `80775a1b-7252-453b-a802-77a30ff2c530` |
| CTO | `d9b1bef6-f44e-4d99-9bb8-d552df6b776f` |
| CFO | `eb0c0a52-0dc5-4104-a971-baf37dda58b3` |

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

*Last updated: 2026-05-21 by Antigravity — RxFit CEO workspace bootstrap*

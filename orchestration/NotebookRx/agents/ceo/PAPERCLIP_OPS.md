# Paperclip Backend API â€” CEO Operational Reference
# Project: NotebookRx

> All credentials via env vars. Never hardcoded. The IDs below are workspace/agent IDs (not secrets).

---

## Authentication

```
Base URL:  ${PAPERCLIP_BASE_URL}   (http://127.0.0.1:3100)
Header:    Authorization: Bearer ${PAPERCLIP_API_KEY}
Content:   Content-Type: application/json
```

---

## Workspace & Agent IDs (NotebookRx)

| Role | Workspace Name | Company ID | Agent ID |
|---|---|---|---|
| **CEO (own)** | CEO â€” NotebookRx | fed76e8a-dd28-4c86-ac90-2922e43f65e9 | 76f5148d-d680-4d5f-bc32-febaa6362c79 |
| **CMO** | NotebookRx - Marketing | `02d72e41-945d-4857-89e2-d262f3a6ee30` | `f0a67138-8f47-4830-9cce-fd4d42968a1b` |
| **CTO** | NotebookRx Technical | `32392001-bf33-463a-a244-11805a8b8f53` | `6689b913-bfde-41ee-86c1-8bdeb765bd60` |
| **CFO** | NotebookRx Revenue | `3853becb-5f6c-4b5f-a57e-69d70f944e92` | `bc0f74be-b6b7-41ff-9232-ba1c97b5d7fb` |

---

## Core API Operations

### 1. Read Your Own Issue Queue
```http
GET ${PAPERCLIP_BASE_URL}/api/companies/{YOUR_CEO_COMPANY_ID}/issues
Authorization: Bearer ${PAPERCLIP_API_KEY}
```

### 2. Read an Officer Agent's Queue
```http
GET ${PAPERCLIP_BASE_URL}/api/companies/{companyId}/issues
Authorization: Bearer ${PAPERCLIP_API_KEY}
```

**Valid status values:** `backlog` | `todo` | `done` | `cancelled`

### 3. Create a Task for an Officer Agent

**NOTEBOOKRX CEO NOTES:**
- Before creating CMO acquisition tasks, confirm primary user (coach vs. client) is resolved â€” CMO channel strategy depends entirely on this answer
- CTO tasks must include insight quality benchmarking â€” not just uptime. Generic insights = product failure
- CFO tasks must always note Stripe is active for premium tier â€” billing changes require human execution
- All health data model questions â†’ escalate before creating CTO tasks that touch data schema

```http
POST ${PAPERCLIP_BASE_URL}/api/companies/{officerCompanyId}/issues
Authorization: Bearer ${PAPERCLIP_API_KEY}
Content-Type: application/json

{
  "title": "[CEO] Task title",
  "description": "Full task description with context, expected output, deadline.",
  "priority": "high"
}
```
Then assign it:
```http
PATCH ${PAPERCLIP_BASE_URL}/api/issues/{newIssueId}
Authorization: Bearer ${PAPERCLIP_API_KEY}
Content-Type: application/json

{
  "assigneeAgentId": "{officerAgentId}",
  "status": "todo"
}
```

### 4. Check an Officer Agent's Status
```http
GET ${PAPERCLIP_BASE_URL}/api/companies/{companyId}/agents
Authorization: Bearer ${PAPERCLIP_API_KEY}
```

### 5. Update an Issue
```http
PATCH ${PAPERCLIP_BASE_URL}/api/issues/{issueId}
Authorization: Bearer ${PAPERCLIP_API_KEY}
Content-Type: application/json

{
  "status": "done",
  "comment": "Weekly briefing delivered. PMF questions status: coach/client=[X], premium tier=[X], integration=[X]."
}
```

### 6. Read a Specific Issue
```http
GET ${PAPERCLIP_BASE_URL}/api/issues/{issueId}
Authorization: Bearer ${PAPERCLIP_API_KEY}
```

---

## CLI Alternative
```bash
npx paperclipai issue create \
  --api-base ${PAPERCLIP_BASE_URL} \
  --api-key ${PAPERCLIP_API_KEY} \
  --company-id {officerCompanyId} \
  --title "[CEO] Task title" \
  --description "Task description" \
  --json
```

---

## Error Handling

| Status | Meaning | Action |
|---|---|---|
| `200/201` | Success | Continue |
| `400` | Validation error | Check request body |
| `401` | Auth failure | Check `${PAPERCLIP_API_KEY}` |
| `404` | Route not found | Use company-scoped paths |
| `500` | Internal server error | Escalate if recurring |

## Mandatory Escalation Triggers
- Any health data model change requested by CTO â†’ escalate to Antigravity before proceeding
- PMF questions (coach/client, premium tier, integrations) unresolved after 2 briefing cycles â†’ escalate to Antigravity â†’ Danny
- CTO AI recommendation framing changes â†’ escalate (legal risk)
- Stripe billing changes â†’ stage for human execution only â€” never auto-execute
- CTO `status = error` â†’ flag to Antigravity (pgvector insight pipeline at risk)

---
*Last updated: 2026-05-21 by Antigravity â€” NotebookRx CEO bootstrap*


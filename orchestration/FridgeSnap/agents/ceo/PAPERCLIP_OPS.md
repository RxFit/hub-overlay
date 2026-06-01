# Paperclip Backend API â€” CEO Operational Reference
# Project: FridgeSnap

> All credentials via env vars. Never hardcoded. The IDs below are workspace/agent IDs (not secrets).

---

## Authentication

```
Base URL:  ${PAPERCLIP_BASE_URL}   (http://127.0.0.1:3100)
Header:    Authorization: Bearer ${PAPERCLIP_API_KEY}
Content:   Content-Type: application/json
```

---

## Workspace & Agent IDs (FridgeSnap)

| Role | Workspace Name | Company ID | Agent ID |
|---|---|---|---|
| **CEO (own)** | CEO â€” FridgeSnap | f62b8673-8b69-4b1d-afcb-7e6821b8ebfc | 9f551a20-2c9e-44c7-996b-15b6c9672225 |
| **CMO** | FridgeSnap - Marketing | `9f847dd9-554f-4fca-8d79-57da9ce20f9c` | `e63aa34f-61cf-403e-8828-4d2a1587768b` |
| **CTO** | FridgeSnap Technical | `280ecdc1-3a48-4699-81d5-b9363978d77c` | `65d25752-b196-4b21-a129-412178bf4385` |
| **CFO** | FridgeSnap Revenue | `aa21fe75-e1ae-4614-9b8c-e91bef79e683` | `de388410-2925-45a0-b96c-02e7ce4b3a23` |

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
Replace `{companyId}` with the officer's Company ID from the table above.

**Valid status values:** `backlog` | `todo` | `done` | `cancelled`

### 3. Create a Task for an Officer Agent

**CRITICAL FOR FRIDGESNAP CEO:** Before creating any growth or marketing tasks for CMO, always query CTO's queue first to check the food recognition accuracy gate status.

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
**Priority values:** `low` | `medium` | `high` | `urgent`

### 4. Check an Officer Agent's Status
```http
GET ${PAPERCLIP_BASE_URL}/api/companies/{companyId}/agents
Authorization: Bearer ${PAPERCLIP_API_KEY}
```
Returns `status`: `idle` | `active` | `error` | `paused`

### 5. Update an Issue
```http
PATCH ${PAPERCLIP_BASE_URL}/api/issues/{issueId}
Authorization: Bearer ${PAPERCLIP_API_KEY}
Content-Type: application/json

{
  "status": "done",
  "comment": "Briefing cycle complete. Accuracy gate: [locked/unlocked]."
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
- CTO agent `status = error` â†’ flag to Antigravity (accuracy pipeline at risk)
- Food recognition accuracy < 90% â†’ block all CMO growth tasks immediately
- Any issue stuck in `todo` > 48h without activity â†’ escalate

---
*Last updated: 2026-05-21 by Antigravity â€” FridgeSnap CEO bootstrap*


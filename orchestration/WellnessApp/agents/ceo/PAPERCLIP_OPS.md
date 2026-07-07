# Paperclip Backend API â€” CEO Operational Reference
# Project: Client Platform

> All credentials via env vars. Never hardcoded. The IDs below are workspace/agent IDs (not secrets).

---

## Authentication

```
Base URL:  ${PAPERCLIP_BASE_URL}   (http://127.0.0.1:3100)
Header:    Authorization: Bearer ${PAPERCLIP_API_KEY}
Content:   Content-Type: application/json
```

---

## Workspace & Agent IDs (Client Platform)

| Role | Workspace Name | Company ID | Agent ID |
|---|---|---|---|
| **CEO (own)** | CEO â€” Wellness App | dc29930a-a333-4b4b-a53e-3f539ed590b3 | 79f0695c-1c7f-4593-9ada-0b58db7e2792 |
| **CMO** | Wellness App - Marketing | `e657f488-74f4-4f0e-acfa-07e8d21e5a21` | `df8e04b2-69ce-4e90-ac62-7d6f070bb88d` |
| **CTO** | Wellness Technical | `3f9303e2-8562-4cd6-8bb8-fc91d17b903e` | `6b11d382-9701-4223-a379-934a0b8258b2` |
| **CFO** | Wellness Revenue | `d3f3c593-95de-440d-904c-9663936698b0` | `07fac3b3-933d-4234-ae3e-6f51cd80a555` |

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
  "comment": "Briefing cycle complete."
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
| `400` | Validation error | Check request body â€” invalid enum is most common cause |
| `401` | Auth failure | Check `${PAPERCLIP_API_KEY}` |
| `404` | Route not found | Use company-scoped paths |
| `500` | Internal server error | Check constraint violation; escalate if recurring |

## Mandatory Escalation Triggers
- Officer agent `status = error` â†’ flag to Antigravity
- Any issue stuck in `todo` > 48h without activity â†’ escalate
- Any `500` recurring â†’ escalate to Antigravity

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
*Last updated: 2026-06-06 by Antigravity – Client Platform CEO bootstrap – added key failure escalation protocol*

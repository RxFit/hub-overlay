# Paperclip Backend API â€” CEO Operational Reference
# Project: Jade CoS

> All credentials via env vars. Never hardcoded. The IDs below are workspace/agent IDs (not secrets).

---

## Authentication

```
Base URL:  ${PAPERCLIP_BASE_URL}   (http://127.0.0.1:3100)
Header:    Authorization: Bearer ${PAPERCLIP_API_KEY}
Content:   Content-Type: application/json
```

---

## Workspace & Agent IDs (Jade CoS)

| Role | Workspace Name | Company ID | Agent ID |
|---|---|---|---|
| **CEO (own)** | CEO â€” Jade CoS | e4c98c03-ad6c-4642-a5c1-a4befa29964a | c5a7c3b8-c34f-4d8d-9ef5-3acc6cca157d |
| **CMO** | JadeCoS - Marketing | `29354ec0-d6f5-4669-bfaf-a86be88a3e23` | `04535f13-75a2-4572-af94-28cf0dff4938` |
| **CTO** | JadeCoS Technical | `ac47264a-3b52-45ff-af9f-4289292692e1` | `6b3408c4-4b89-4f08-8952-1ef25cffee43` |
| **CFO** | JadeCoS Revenue | `bd5096e3-3073-445e-90de-9a875f227a09` | `fb9c323e-2fc3-4c12-8e60-880ea9611b94` |

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

**JADE COS CEO NOTES:**
- CTO tasks = uptime, Cloudflare tunnel health, Cloud SQL connectivity, Jules audit routing
- CFO tasks = operating expense reports (Cloud Run + API costs), MoM comparison
- CMO tasks = whichever KPI Danny confirmed (Alerts Actioned vs. Webpage Traffic â€” check KPI.json for resolution)

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
  "comment": "Weekly briefing delivered. Infrastructure uptime: [X%]. Open KPI question: [resolved/pending]."
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

## Mandatory Escalation Triggers (Jade CoS is P0 Infrastructure)
- CTO `status = error` â†’ Jade service may be down â€” P0 escalation to Antigravity â†’ Danny
- Cloudflare tunnel failure reported by CTO â†’ P0 â€” Danny loses external access
- Cloud SQL connection failure â†’ P0 â€” all data pipelines broken
- Any operating cost spike > 20% MoM â†’ flag to Antigravity
- Open KPI question (Alerts Actioned vs. Webpage Traffic) unresolved after 2 briefing cycles â†’ escalate to Antigravity â†’ Danny

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
*Last updated: 2026-06-06 by Antigravity – Jade CoS CEO bootstrap – added key failure escalation protocol*

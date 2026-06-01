# Paperclip Backend API â€” CEO Operational Reference
# Project: RxFit SEO Agent

> All credentials via env vars. Never hardcoded. The IDs below are workspace/agent IDs (not secrets).

---

## Authentication

```
Base URL:  ${PAPERCLIP_BASE_URL}   (http://127.0.0.1:3100)
Header:    Authorization: Bearer ${PAPERCLIP_API_KEY}
Content:   Content-Type: application/json
```

---

## Workspace & Agent IDs (RxFit SEO Agent)

| Role | Workspace Name | Company ID | Agent ID |
|---|---|---|---|
| **CEO (own)** | CEO â€” SEO Agent | 309b5b18-c53a-482c-b1ff-60a784eb9515 | dfe8e608-42cb-4db3-b9c8-5dfdbd049113 |
| **CMO** | SEO Agent Marketing | `a4608f28-a701-4a2a-815f-1f6aad96af49` | `1cb00c8b-5a1c-4dc6-a528-2daacdc50239` |
| **CTO** | SEO Agent Technical | `15ec2739-5746-4e43-806d-2bde3a383cd9` | `40e36b6f-f7a3-4456-af5f-35b375a4a8ac` |
| **CFO** | SEO Agent Revenue | `0161e71a-fefb-40f0-8f1d-41403a6e7edb` | `93dcd4a5-dad3-4aef-b9c6-c29a09b724d9` |

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

**SEO AGENT CEO NOTE:** CFO Revenue KPI is cost efficiency, not MRR. When creating CFO tasks, frame them as cost comparison reports (actual API spend vs. Pneuma Media equivalent), not revenue reports.

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
  "comment": "Weekly briefing delivered. Autonomy status: [manual interventions this week: N]."
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
- CTO `status = error` â†’ autonomous publishing pipeline may be down â€” flag to Antigravity
- Manual intervention count > 0 for standard content cycles â†’ flag as system failure
- CFO reports cost spike > 20% MoM â†’ flag to Antigravity immediately
- Money keyword content queued â†’ route to Antigravity â†’ Danny for human review before publish

---
*Last updated: 2026-05-21 by Antigravity â€” SEO Agent CEO bootstrap*


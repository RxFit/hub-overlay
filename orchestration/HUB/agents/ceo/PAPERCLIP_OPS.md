# Paperclip Backend API — CEO Operational Reference
# Project: HUB Overlay

> All credentials via env vars. Never hardcoded. The IDs below are workspace/agent IDs (not secrets).

---

## Authentication

```
Base URL:  http://127.0.0.1:3101
Header:    Authorization: Bearer pcp_board_992cfa5aa82191e33d3614b42c4a707914d3bbe43bec008f
Content:   Content-Type: application/json
```

---

## Workspace IDs (CEO — HUB Overlay)

| Role | Workspace Name | Company ID | Agent ID |
|---|---|---|---|
| **CEO (own)** | HUB Overlay - CEO | `05787964-7240-4851-b7df-d006f0d8001c` | `a26e5555-2ce0-4eda-a5d3-fb4a15109612` |
| **COO** | HUB Overlay - COO | `05787964-7240-4851-b7df-d006f0d8001c` | `c56e5206-5d54-4fe8-95ea-6e5669a7333e` |
| **CTO** | HUB Overlay - CTO | `05787964-7240-4851-b7df-d006f0d8001c` | `9eeb28d1-b8b2-4904-8486-39d8c77da86b` |

---

## Core API Operations

### 1. Read Your Own Issue Queue

```http
GET http://127.0.0.1:3101/api/companies/05787964-7240-4851-b7df-d006f0d8001c/issues
Authorization: Bearer pcp_board_992cfa5aa82191e33d3614b42c4a707914d3bbe43bec008f
```

---

### 2. Create a Task for an Officer Agent

```http
POST http://127.0.0.1:3101/api/companies/05787964-7240-4851-b7df-d006f0d8001c/issues
Authorization: Bearer pcp_board_992cfa5aa82191e33d3614b42c4a707914d3bbe43bec008f
Content-Type: application/json

{
  "title": "[CEO] Task title here",
  "description": "Full task description with context and expected output.",
  "priority": "high"
}
```

After creating the issue, patch to assign it to the target agent:

```http
PATCH http://127.0.0.1:3101/api/issues/{newIssueId}
Authorization: Bearer pcp_board_992cfa5aa82191e33d3614b42c4a707914d3bbe43bec008f
Content-Type: application/json

{
  "assigneeAgentId": "{targetAgentId}",
  "status": "todo"
}
```

---

## Key Failure Escalation Protocol

When any agent encounters an API key error, the agent MUST:
1. Identify the error type from the table below
2. Create an **URGENT** issue in the CEO workspace with the error code
3. Do NOT retry more than once — escalate immediately

| Error Code | Meaning | CEO Action Required |
|---|---|---|
| `KEY_EXPIRED` | Token/key has expired | Rotate key, update env var |
| `KEY_RATE_LIMITED` | API quota exhausted | Check billing/quota limits |
| `KEY_REVOKED` | Key was manually revoked | Generate new key, update env var |
| `KEY_INVALID` | Key format/value is incorrect | Verify key value |
| `KEY_UNAUTHORIZED` | Key lacks required permissions | Update key scopes/permissions |
| `KEY_BILLING_FAILED` | Provider payment method declined | Update billing on provider account |

---
*Last updated: 2026-06-06 by Antigravity — HUB Overlay CEO Operational Reference*

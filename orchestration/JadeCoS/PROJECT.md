# Jade CoS — Project Brief

## What It Is

**Jade** is RxFit's AI Chief of Staff — an internal orchestration platform that acts as the company's operational command center. Running as a persistent service (port 3919) behind a Cloudflare Tunnel, Jade monitors business KPIs, delivers founder briefings, fires operational alerts to Google Chat, and connects all internal RxFit tools into a single coherent intelligence layer.

Jade is **not** a product. It is infrastructure. It is the operational brain that makes all other RxFit tools more useful.

---

## What It Does

- **Monitors KPIs** across all active RxFit projects (revenue, technical health, marketing output)
- **Sends briefings and alerts** to the founder via Google Chat (Space: `AAQAsCjZP0c`) — surfaces what matters without noise
- **Orchestrates internal tools** — interfaces with RxFit-MCP and CERBERUS_CORE volumes
- **Ingests Jules audit results** — routes `jules-audit` GitHub Issues to the correct technical workspace
- **Flags anomalies early** — financial irregularities, service outages, content gaps

---

## Why It Exists

Danny Trejo wears every hat in the company. Jade exists to reduce that cognitive load. The goal is a morning briefing that tells him exactly what needs attention today and nothing else. Every alert Jade sends should be actionable. Every report should reduce decision time, not increase it.

---

## Architecture Snapshot

```
Jade CoS (Node.js/Express, port 3919)
      │
      ├── DB ────────────────► Cloud SQL (antigravity_brain, ${CLOUD_SQL_HOST})
      │
      ├── Chat ──────────────► Google Chat webhook (${GOOGLE_CHAT_WEBHOOK_URL})
      │
      ├── Tunnel ────────────► Cloudflare (${CLOUDFLARE_TUNNEL_TOKEN})
      │
      ├── Reads from ────────► RxFit-MCP volume (ro)
      │
      └── Reads from ────────► _CERBERUS_CORE volume (ro)
```

---

## Relationship to Antigravity

```
Antigravity = Strategic Thinking Layer   (long-horizon reasoning, decisions)
Jade CoS    = Execution Layer            (monitoring, alerting, briefing, orchestration)
```

Jade executes. Antigravity decides. Jade escalates to Antigravity when something exceeds its decision authority (schema changes, security events, financial anomalies above threshold).

---

## Current Status

**DEPLOYED AND OPERATIONAL.**
- Cloudflare Tunnel: token populated and active
- Cloud SQL connection: confirmed live (db: `antigravity_brain`, user: `jade_cos_rw`)
- Google Chat webhook: configured and operational
- Docker Compose: `jade-cos` service + `cloudflared` sidecar

---

## Systems Jade Connects To

| System | Purpose |
|---|---|
| Cloud SQL (`antigravity_brain`) | Persistent state, KPI data, event log |
| Google Chat | Founder briefings, operational alerts |
| RxFit-MCP | Tool orchestration read access |
| _CERBERUS_CORE | Core secrets and configuration (read-only) |
| GitHub (all repos) | Jules audit ingestion, issue routing |
| Cloud Run | Service health monitoring |

---

## Internal-Only

Jade is exclusively internal infrastructure. It exposes no public endpoints. The Cloudflare Tunnel provides secure external access for the founder only.

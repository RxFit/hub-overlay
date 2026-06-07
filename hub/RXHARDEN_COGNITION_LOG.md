# RxHarden Cognitive Ledger - Casa Trejo Hub Chat Use Case Optimization

> This file is the externalized chain-of-thought for the RxHarden execution.
> It is APPEND-ONLY. Never delete or overwrite previous entries.
> The agent MUST append Pre-Cog outputs and Hostile Auditor findings here
> BEFORE writing any implementation code.

---

## Task 1: Fix Type Definition & Destructuring

### 3b. Context & Dependency Matrix

| Dependency | Type | Direction | Risk Level |
|---|---|---|---|
| [route.ts](file:///C:/Users/danie/Documents/antigravity/vibrant-chandrasekhar/hub/app/api/chat/route.ts) | File (TypeScript) | Modify | HIGH |
| `body` type signature | Type Schema | Modify | MEDIUM |
| `useCase` variable | Data Flow | Read/Write | LOW |

### 3c. Blast Radius Prediction
- **Data Desync:** Client-side requests omitting `useCase` might cause server-side destructuring to yield `undefined`, leading to model configuration issues.
- **Visualization Break:** TypeScript compiler error blocks production compilation.
- **System Latency:** Incorrect model names passed to Google AI SDK will cause API request failures, blocking client messages.
- **Security Vulnerability:** Malicious payload sending arbitrary `useCase` must be sanitized or mapped to safe models only.

### 3d. Explicit Mitigations
- **TypeScript Fix:** Redefine the `body` type signature in the route handler to include `useCase?: string` optional property.
- **Default value fallback:** Destructure with default value: `const { messages, useCase = 'deep_dive' } = body`.
- **Safe Model Mapping:** Ensure unknown values of `useCase` resolve to a default model.
- **Build validation:** Run `npm run build` immediately to check compilation.


---

## Task 2: Build Verification & Deploy to Railway

### 3b. Context & Dependency Matrix

| Dependency | Type | Direction | Risk Level |
|---|---|---|---|
| Railway Production Service | Hosting Server | Deploy | HIGH |
| Next.js Build Engine | Bundler | Write | MEDIUM |

### 3c. Blast Radius Prediction
- **Data Desync:** If deploy starts with stale dependencies, the client or backend may run outdated routing schemas.
- **Visualization Break:** Runtime errors in production if the bundle hydration is broken.
- **System Latency:** Slow building/deploy cycles. Missing ENV variables (e.g. `GEMINI_API_KEY`) on the cloud instance will break chat.
- **Security:** Ensure `railway up` does not leak credentials or environment configurations in build logs.

### 3d. Explicit Mitigations
- **Pre-Compile Check:** Local `npm run build` executed successfully, guaranteeing bundle compilation.
- **Service Validation:** Execute `railway status` to confirm target configuration.
- **Cloud Build Monitoring:** Track the build process on the Railway console or CLI.

---

# RxHarden Session 2: Vertex AI + pgvector Dual-Search Hardening

> Started: 2026-06-07T16:36:00-05:00
> Conversation: 26bfbe50

## Foundation Phase

### Design Decisions Locked (from /grill-me interview)
1. Vertex AI = native Google Workspace connector (kill GCS bucket)
2. pgvector = admin-curated Knowledge Base uploads only
3. Separate Discovery Engine instances per tenant (full isolation)
4. Engine config stored in `tenants` table columns
5. Silent fallback to pgvector on Vertex AI failure
6. Consolidate dual SA auth into single `google-auth.ts`
7. Single GCP project `semantic-brain-desktop`, multiple engines
8. Admin UI Vertex AI status panel on Knowledge Base page

### Current State Snapshot
- Vertex AI: LIVE in code (reinstated ~13:51 today), engine `semanticbrain_1779229063037`
- pgvector: LIVE, 1 debug chunk, HNSW index active, threshold 0.65
- Auth: TWO duplicate SA auth implementations (vertex.ts + google-auth.ts)
- Tenant config: hardcoded engine ID in vertex.ts
- GCS bucket: frozen since May 19 (366 stale docs)

---

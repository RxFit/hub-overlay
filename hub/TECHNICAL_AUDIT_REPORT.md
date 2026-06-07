# TECHNICAL AUDIT REPORT: hub.casatrejo.com

**Prepared by**: Chief Technology Officer (CTO)  
**Date**: Sunday, June 7, 2026  
**Target Codebase**: `C:\Users\danie\Documents\antigravity\vibrant-chandrasekhar\hub\`

---

## EXECUTIVE SUMMARY

This audit provides a comprehensive security, architecture, performance, and scalability review of the hub.casatrejo.com platform. Multiple high-severity vulnerabilities have been identified and analyzed, including cross-tenant data leakage via catch-all proxy routes, authorization bypasses on push webhooks, massive front-end complexity bottlenecks, and structural/resiliency improvements for the circuit breaker and retry mechanisms.

Detailed assessment, proof-of-concept conditions, and concrete actionable recommendations are presented below.

---

## 1. AUTHENTICATION & SECURITY AUDIT

### 1.1 `/api/chat` Route
- **Findings**: The route at `app/api/chat/route.ts` successfully implements robust session-based authentication using NextAuth. It verifies user sessions using `getServerSession(authOptions)` and responds with a `401 Unauthorized` status if no active session is detected. All sub-routes (`/api/chat/detect-intent` and `/api/chat/score-context`) also properly enforce this.
- **Risk**: Low. Access is correctly limited to authenticated hub users.

### 1.2 `/api/embeddings/upsert` Route
- **Findings**: This route uses service-to-service token-based authentication. It checks for a bearer token: `authHeader === `Bearer ${expectedKey}`` (where `expectedKey` is `process.env.PAPERCLIP_API_KEY`).
- **Risk**: Low. Safe against unconfigured environment variables since it fails closed (`!expectedKey` triggers `401 Unauthorized`).

### 1.3 `/api/webhooks/google` Route (CRITICAL VULNERABILITY)
- **Findings**: This endpoint handles Google push webhooks and performs an authorization check against the channel token:
  ```typescript
  const expectedToken = process.env.GOOGLE_WEBHOOK_CHANNEL_TOKEN;
  if (!channelToken || (expectedToken && channelToken !== expectedToken)) { ... }
  ```
- **Vulnerability**: If `GOOGLE_WEBHOOK_CHANNEL_TOKEN` is not explicitly set in the production environment (which is a common oversight), the logical expression `expectedToken && channelToken !== expectedToken` evaluates to `undefined` (falsy). As long as a client provides *any* non-empty `x-goog-channel-token` header, the block is skipped and the request is treated as authorized.
- **Impact**: Critical. An external attacker can spoof Google push notifications with any random token to trigger background processing, potentially resulting in resource exhaustion, fake document indexing, or unauthorized deletion of vector database chunks.
- **Actionable Recommendation**: Refactor the check to fail-closed if the expected token is missing or improperly configured:
  ```typescript
  if (!expectedToken) {
    console.error('[Google Webhook] GOOGLE_WEBHOOK_CHANNEL_TOKEN is not configured.');
    return NextResponse.json({ error: 'Internal configuration error' }, { status: 500 });
  }
  if (!channelToken || channelToken !== expectedToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  ```

---

## 2. MULTI-TENANCY & THE PAPERCLIP CATCH-ALL PROXY AUDIT

The route `app/api/paperclip/[...path]/route.ts` acts as an API gateway proxying requests to the Paperclip backend. It contains multiple multi-tenant isolation vulnerabilities.

### 2.1 Complete Bypass of Tenancy Checks on Non-Company Routes (HIGH RISK)
- **Vulnerability**: The proxy checks company access using a regex match on the path:
  ```typescript
  const companyMatch = apiPath.match(/\/api\/companies\/([a-f0-9-]+)/)
  ```
  If the route targets `/api/issues`, `/api/agents`, `/api/runs`, or `/api/projects` directly without the `/api/companies/` prefix, `companyMatch` evaluates to `null`.
- **Impact**: Critical. This completely bypasses tenancy validation! Any authenticated `staff` user assigned to Company A can query or mutate any other company's issues, runs, or agent statuses by constructing a request to the direct endpoints (e.g., `GET /api/issues/HUB-13` or `PATCH /api/issues/HUB-13`), leading to a massive cross-tenant data leak.
- **Actionable Recommendation**:
  1. Mandate that all direct resource queries or modifications (Issues, Agents, Runs, Projects) go through company-scoped parent paths (e.g. `/api/companies/[companyId]/issues/[id]`).
  2. Alternatively, if direct resource endpoints are necessary, the proxy MUST query the resource first (or maintain a cached lookup mapping) to determine its company ownership and verify it against the user's `assignedProjects` array before forwarding the request.

### 2.2 Equality Bypass on `/api/companies` List Filtering (MEDIUM RISK)
- **Vulnerability**: The proxy filters the list of returned companies at the end of execution using:
  ```typescript
  if (apiPath === '/api/companies' && role !== 'superadmin' && !assignedProjects.includes('*')) { ... }
  ```
  If a user requests `/api/companies/` (with a trailing slash), `apiPath` is resolved as `/api/companies/`. The exact string equality check `apiPath === '/api/companies'` fails, bypassing the list filter and returning the full, unfiltered company list.
- **Impact**: High. Information disclosure. Users can view metadata of all clients/workspaces on the platform.
- **Actionable Recommendation**: Sanitize the path using URL utility parsers to strip trailing slashes, or use regex matching:
  ```typescript
  const isCompaniesList = apiPath.replace(/\/$/, '') === '/api/companies';
  ```

---

## 3. CODE COMPLEXITY & FILE SIZE AUDIT

### 3.1 `app/page.tsx` (103KB, 2,119 lines)
- **Assessment**: This file is a monolithic React component holding the state for the entire main dashboard—including chat, sidebar sections, SWR mutations, overlay wizards, onboarding banners, and live KPI feeds. It mixes visual styles, polling logic, socket-like handlers, and view layouts in a single place. This causes long compilation times, difficult-to-trace bugs, state-management bloat, and poor UX frame rendering.
- **Actionable Recommendation**:
  1. Extract main sub-panels (e.g., Left Panel, Active Workspace view) into dedicated component files under `app/components/Hub/`.
  2. Implement a custom hook (e.g. `useHubState`) to encapsulate state and data-fetching (SWR) logic, keeping the render function clean.

### 3.2 `app/settings/page.tsx` (82KB, 1,746 lines)
- **Assessment**: Similar to `page.tsx`, this component combines multi-tab form states (Google settings, client settings, API key management, workspace setup) into a single gigantic component.
- **Actionable Recommendation**: Break down each settings section/tab (e.g., `WorkspaceSettings`, `IntegrationsSettings`, `ProfileSettings`) into self-contained sub-components.

### 3.3 `app/globals.css` (211KB, 7,242 lines)
- **Assessment**: At 7,242 lines of pure CSS, this represents an unmanageable custom CSS sheet. It defines a full custom design system manually instead of leaning on modern utilities or Next.js layout tools.
- **Actionable Recommendation**:
  1. Adopt Tailwind CSS or CSS Modules to scope component styling, removing global bleed-over risk.
  2. If raw CSS must be used, modularize the sheet into separate files (e.g., `variables.css`, `typography.css`, `components/button.css`, `layouts/dashboard.css`) and import them using `@import` or standard bundler imports.

---

## 4. ARCHITECTURAL & RESILIENCY AUDIT

### 4.1 Circuit Breaker (`lib/circuit-breaker.ts`)
- **Limitation 1 (In-Memory Isolation)**: The circuit breaker stores its state in an in-memory `Map`. In containerized environments (like Railway, Vercel, or multi-instance containers), circuit state is isolated per instance and is completely wiped whenever an instance recycles.
- **Limitation 2 (Probe Storm)**: In the `half-open` state, there is no throttling of probing requests. Once the `resetMs` expires, all incoming concurrent requests are allowed to pass through to the failing upstream service.
- **Limitation 3 (Memory Leak)**: The map `entries` has no expiration or TTL, meaning it will grow indefinitely as new keys are used.
- **Recommendations**:
  1. Back the circuit breaker with Redis or a fast distributed cache.
  2. Limit the number of concurrent probing requests in `half-open` to a single thread/request.

### 4.2 Retry Logic (`lib/retry.ts`)
- **Limitation (Gateway Timeout Risk)**: Retrying a request that has a 10-second timeout up to 3 times can block the server thread for 30+ seconds. Under Next.js, this often exceeds the platform gateway limits (Vercel has a 15-second default timeout, Railway has similar limits), causing the user to receive a 504 error anyway, while double/triple charging the upstream Paperclip API.
- **Recommendation**: Implement a shorter timeout for retry probing and decrease maximum retry counts under heavy API load.

### 4.3 Schema Alignment (`lib/zod-schemas.ts` & `lib/schema.ts`)
- **Alignment**: Database schemas and API schemas are well-aligned for agent memories.
- **Vulnerability**: **KPI schemas are entirely missing from Zod**. KPI creation (`POST`) and update (`PATCH`) operations in `app/api/settings/kpis/route.ts` extract properties from JSON bodies manually and cast/coerce them (e.g., `String(fields.label)`), without validation. This means invalid values for enums like `trendDirection` can be written to the database, leading to potential data corruption or frontend component crashes during rendering.
- **Recommendation**: Create a robust `KPISchema` in Zod and use `safeParse` inside the KPI settings endpoints to enforce strict validation.

### 4.4 OAuth Token Refresh Flow (`lib/auth.ts`)
- **Assessment**: Fully compliant and robust. Properly captures refresh tokens, correctly handles Google OAuth response omissions, and propagates errors safely to the client side.
- **Critique**: Requiring full read/write access to Gmail and Calendar scopes during initial sign-in violates least privilege. Consider partitioning high-privilege scopes into an optional configuration step.

### 4.5 Gemini Model Fallback Latency (`lib/gemini.ts`)
- **Critique**: If the primary model `gemini-3.5-flash` fails consistently, every single user prompt is delayed by a first attempt timeout, a 2-second hardcoded delay, and a second model connection attempt. This destroys real-time interactive streaming performance.
- **Recommendation**: Implement a dynamic, short-lived fallback cache so that if the primary model fails, the system immediately routes subsequent requests to the fallback model for a specified duration (e.g., 5-10 minutes) before probing the primary again.

---

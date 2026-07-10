# Runbook — AI provider outage ("provider configuration" chat error)

## Symptom

Every ordinary chat question answers with this bubble:

> ⚠️ The AI service is temporarily unavailable (provider configuration).
> Please try again shortly — if it persists, contact an administrator.

That string is `friendlyModelError()`'s auth/key mapping (`hub/lib/gemini.ts`).
It appears ONLY when the model rotation died with an **auth-class** failure:
a missing, rotated, or revoked API key, a permission error (401/403), or a
provider **billing** problem. It is never a transient overload (that maps to
"The AI is busy right now").

Since the cross-provider fallback (P0), a single broken provider only produces
this error when the OTHER provider is also unconfigured or failing — so seeing
it usually means a missing/broken key, possibly on both providers.

## What it means

- Default chat (`recall` / `deep_dive` without a skill) tries **Gemini first**;
  `interview` / `execute` / skill turns try **Claude first**. Either chain
  falls back to the other on a pre-stream failure.
- Auth failures fast-fail a whole chain (all models share one credential) and
  put the failed model in a 30-minute cooldown.
- The deploy workflow injects **no AI keys** — they are hand-managed on the
  runtime environment. A key that was rotated/deleted there breaks production
  even though CI is green.

## Diagnosis (2 minutes)

1. Open **/admin/ai-health** (admin/superadmin).
   - **Provider configuration** row: `Gemini` / `Claude` badges show key
     PRESENCE on the running service. A red `✗ key missing` badge is your
     answer — go straight to remediation.
   - **Errors by code**: a spike of `auth` confirms the credential class even
     when a key is present but invalid (rotated/billing-disabled).
2. Cloud Logging (query pack: `hub/docs/observability-queries.md`):

   ```text
   resource.type="cloud_run_revision"
   resource.labels.service_name="hub"
   jsonPayload.type="ai_error"
   ```

   Group by `jsonPayload.code` — look for `auth`. The raw provider message is
   in the server logs next to `[streamChat]` / `Chat stream failed` lines
   (never in the user bubble).

## Remediation

- **Gemini** (default-chat primary): set/rotate the key on the runtime env —
  Cloud Run service → Edit & deploy new revision → Variables, or the Railway
  service Variables tab. Accepted names: `GEMINI_API_KEY` (canonical),
  `GOOGLE_API_KEY`, or `GOOGLE_GENERATIVE_AI_API_KEY`.
  Check in Google AI Studio that the key exists, is unrestricted for the
  Generative Language API, and its project has billing enabled.
- **Claude** (emergency fallback for default chat; primary for interview/
  execute/skills): `ANTHROPIC_API_KEY` (canonical) — the case-variant
  fallbacks `Anthropic_API_Key` and `anthropic_token` also work
  (`hub/lib/claude.ts`). Verify the key + billing in the Anthropic Console.
- Redeploy/restart the service after changing variables (keys are read at
  runtime, but a restart clears the 30-minute auth cooldowns immediately).

## Verification

1. /admin/ai-health → both provider badges green (`✓ configured`).
2. Ask any chat question — a normal streamed answer, no ⚠️ bubble. (While only
   the backup provider is fixed you'll see a subtle "*Primary model
   unavailable*" note; that's the fallback working as designed.)
3. AI Health / Cloud Logging: `ai_complete` events resume and `errorsByCode.auth`
   stops growing over the next few requests.

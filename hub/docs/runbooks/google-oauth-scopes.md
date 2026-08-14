---
title: "Runbook — Adding & activating Google OAuth scopes"
created: 2026-07-27
tags:
  - runbook
  - oauth
  - google-workspace
  - deploy
status: active
related:
  - "[[ai-provider-outage]]"
  - "[[protected-workspaces]]"
aliases:
  - Google scopes runbook
  - OAuth consent runbook
---

# Runbook — Adding & activating Google OAuth scopes

> [!summary]
> The Hub asks Google for a fixed list of OAuth scopes at sign-in
> (`GOOGLE_SCOPES` in `hub/lib/auth.ts`). Adding a capability that touches a new
> Google API is **two-sided**: the scope goes in the code *and* the scope must be
> registered + its API enabled in the Google Cloud Console. Do the Console side
> **before** the code deploys, or sign-in can break for everyone.

## When to use this

- You added (or plan to add) a Google API capability — Docs, Sheets, Slides,
  Contacts, Directory, etc. — and need to take it live.
- Users report a feature returning **"One-time permission needed"** / a Google
  re-consent prompt, or a `MISSING_SCOPE` error.
- Sign-in suddenly fails with `invalid_scope` / `access blocked` after a deploy.

## The golden rule (deploy ordering)

```
Console (enable API + register scope)   ─►   merge code that requests the scope
        FIRST                                          SECOND
```

Merging to `master` auto-deploys to Cloud Run (see [[../../README#Deployment]]).
If the code that *requests* a scope ships before the consent screen knows about
it, Google can reject the authorization request → **broken login**. Always land
the Console change first, then flip the code PR ready.

## Code side (one place)

All scopes live in a single array — `GOOGLE_SCOPES` in **`hub/lib/auth.ts`**.
The provider is already configured for clean re-consent:

```ts
authorization: {
  params: {
    scope: GOOGLE_SCOPES,
    access_type: 'offline',        // issue a refresh token
    include_granted_scopes: 'true' // roll old grants into the new one (no drop)
    // NOTE: no static `prompt` — see below.
  }
}
```

Adding a scope = add the URL to that array. Nothing else in the auth layer
changes.

**There is deliberately no static `prompt: 'consent'` here.** It used to be, and
it forced the full consent screen on *every* authorization — including the
automatic ones the app fires to self-heal an expired token, turning a
recoverable blip into a visible "sign in again and re-approve 20 scopes"
interruption. Omitting it lets Google complete an existing grant silently. The
deliberate sign-in button (`app/login/page.tsx`) still passes `prompt: 'consent'`
**per call**, which is what guarantees a fresh `refresh_token`.

So a newly-added scope is picked up when the user next signs in through that
button (or any flow that re-prompts), with `include_granted_scopes` preserving
everything already granted. Users who don't re-consent keep working: each
capability gates on its own scope and surfaces `MISSING_SCOPE` rather than
failing the session.

## Console side (the checklist)

For **each** new scope:

1. **Enable the API** — Cloud Console → *APIs & Services → Enable APIs & services*.
   Enabling the API is **separate** from the scope; the feature 500s without it.
2. **Register the scope** — *APIs & Services → OAuth consent screen → Add or
   remove scopes* → paste the scope URL → Save.
3. **Trust the client** — Admin console → *Security → API controls → App access
   control* → mark the Hub's OAuth client **Trusted**, so a future org-wide
   "block unconfigured apps" policy can't silently break it.
4. **Check posture (decides verification)** — OAuth consent screen → **User type**
   + **Publishing status**:
   - *Internal* → no verification, ever (even restricted scopes).
   - *External + Testing* → any scope, ≤100 users, "unverified app" notice.
   - *External + In production* → **sensitive** scopes need a brand + sensitive
     review (days, **no CASA**); **restricted** scopes (full `drive`, `gmail.*`)
     need restricted review **+ annual CASA**.

> [!tip]
> Prefer **sensitive-or-lighter** scopes. `drive.file` (non-sensitive) covers
> "create a file in the user's Drive" without the restricted full-`drive` scope
> and its CASA obligation.

## Activating for existing users (re-consent)

Sessions are 30-day JWTs; a token refresh **reuses the old grant**, so existing
users don't get a new scope until they re-authenticate. This is handled
gracefully:

- Google **scope failures** surface as HTTP **401 `{ reauth: true }`** via
  `mapGoogleErrorToStatus` (`hub/lib/google-session.ts`) → the client re-runs
  `signIn('google')` automatically.
- The **new write routes** (Docs/Sheets/Slides/Contacts) return a discriminating
  **403 `{ code: 'MISSING_SCOPE' }`** (`googleWriteErrorResponse`) → the client
  re-consents **only** on that marker, never on a bare 403 (RBAC / gate-token /
  Paperclip proxy denials, which re-consent can't fix and would loop on).
- **API-not-enabled** failures — Google 403 `accessNotConfigured` /
  `SERVICE_DISABLED` ("…API has not been used in project … before or it is
  disabled") — return **403 `{ code: 'API_NOT_ENABLED', activationUrl }`**
  instead of either of the above. Google labels these `PERMISSION_DENIED`, but
  they are a *Console* problem (step 1 of the checklist above was skipped), and
  re-consent cannot fix them: mapping them to a re-auth prompt produced the
  Settings → Analytics "authorize → consent → authorize again" loop. Clients
  show "an operator must enable this API in the Cloud Console", linking
  Google's own `activationUrl`, and never a sign-in prompt.

To force it proactively: **sign out and back in once**.

**Verify a user actually has the scope:** their Google Account → *Security →
Third-party access → CT Hub*, or decode the access token via `tokeninfo`.

## Scope inventory (as of 2026-07-27)

### Pre-existing
`openid` · `email` · `profile` · `tasks` · `calendar` · `drive.readonly` ·
`gmail.readonly` · `gmail.send` · `gmail.modify` · `chat.spaces.readonly` ·
`chat.messages` · `chat.messages.create` · `chat.memberships.readonly` ·
`chat.users.readstate` · `analytics.readonly` · `webmasters.readonly`

### Added — PR #135 (Docs / Sheets / Contacts / Meet)

| Scope | API to enable | Class | Unlocks |
|---|---|---|---|
| `…/auth/documents` | Google Docs API | sensitive | Create/edit Google Docs from chat (Decision Memo, meeting notes) |
| `…/auth/spreadsheets` | Google Sheets API | sensitive | Create/edit Sheets (KPI snapshots, exports) |
| `…/auth/drive.file` | Drive API | **non-sensitive** | Lets created Docs/Sheets/Slides land in the user's Drive (per-file only) |
| `…/auth/contacts.readonly` | People API | sensitive | Resolve a name → email so "email Maria" works |
| *(Google Meet)* | *(none — existing `calendar`)* | — | Auto-attach a Meet link on scheduled meetings (`conferenceDataVersion=1`) |

### Added — PR #136 (Slides / Directory)

| Scope | API to enable | Class | Unlocks |
|---|---|---|---|
| `…/auth/presentations` | Google Slides API | sensitive | Create Google Slides decks from chat (Deck Pipeline, Gamma Deck) |
| `…/auth/admin.directory.user.readonly` | **Admin SDK API** (needs Workspace super-admin) | sensitive | Resolve a colleague → work email via the org directory (best-effort fallback after contacts) |

> [!note]
> The directory lookup is **best-effort**: if the Admin SDK isn't enabled, a
> missing-scope error is swallowed and recipient resolution falls back to
> personal contacts — nothing hard-breaks.

### Drive sharing — **no new scope** (`/api/google/share`)

Changing who can open a file is served entirely by scopes the Hub already
holds, which is why this shipped without a Console change or a re-consent:

| Operation | Drive method | Scope that authorises it | Reaches |
|---|---|---|---|
| Who has access? | `permissions.list` | `drive.readonly` | **any** file the user can see |
| Grant access | `permissions.create` | `drive.file` | files the **Hub created** |
| Revoke access | `permissions.delete` | `drive.file` | files the **Hub created** |

That asymmetry is the whole shape of the feature, and it is worth stating
plainly because it will be the first support question:

- **Reading** access works on a colleague's shared doc, a file from Gmail,
  anything. `permissions.list` accepts `drive.readonly`.
- **Changing** access does not. `permissions.create` accepts only `drive` and
  `drive.file`, and `drive.file` is per-file access to files **this app
  created**. A Doc/Sheet/deck the Hub authored is shareable; a file the user
  made in Drive last year is not.

`findShareableFiles` (`lib/google/sharing.ts`) makes that boundary visible
*before* a share is attempted: it searches Hub artifacts first (by the
`hubOverlay` appProperty, tenant-scoped) and only falls back to a plain name
search so the assistant can say "I found it, but it isn't a Hub file" instead of
surfacing a raw Drive 403.

> [!warning]
> The obvious "fix" — adding full `…/auth/drive` so any file becomes shareable —
> is the one addition this runbook tells you not to make. It is a **restricted**
> scope: ~6-week verification plus an annual CASA assessment. If sharing an
> existing user file becomes a real requirement, the cheaper routes are (a) have
> the Hub make a copy it owns, or (b) add the Google **Picker**, which grants
> `drive.file` access to a file the user explicitly selects.

## Consent screen configuration (record this)

Several downstream decisions hinge on how the OAuth app itself is configured,
and the answer isn't inferable from code. Read it at Cloud Console → project
`rxfit-automation` → **APIs & Services → OAuth consent screen**, and record:

| Field | Observed | Why it matters |
|---|---|---|
| **User type** | _(fill in)_ | Internal removes verification/CASA entirely, but only admits accounts inside the owning Workspace org |
| **Publishing status** | _(fill in)_ | Testing mode expires refresh tokens after **7 days** |
| **Verification status** | _(fill in)_ | Restricted scopes (`gmail.readonly`/`modify`) need verification once External + in production |

**Expect External.** Internal is effectively ruled out: sign-in deliberately
admits guests on consumer domains (see `ALLOWED_EMAIL_DOMAINS` handling in
`lib/auth.ts`) and the tenant roadmap spans multiple orgs — neither works under
an Internal app. Corroborating evidence: stored-refresh-token KPI sync keeps
working across weeks, which Testing mode's 7-day expiry would break.

Consequence to plan for: restricted-scope verification plus an annual CASA
assessment (Tier 2 self-scan suffices at this size) once the user count passes
the unverified cap of 100. Keeping server-side Gmail data handling minimal keeps
the assessed surface small.

## Gotchas

- **Three separate things:** enable the API ≠ register the scope ≠ build the
  feature. Miss one and it silently doesn't work.
- **Don't add full `…/auth/drive`** — the only addition here that would start a
  ~6-week restricted review + annual CASA. Use `drive.file`.
- **`drive.file` can't open *existing* arbitrary files** — fine for *creating*
  Docs/Sheets/Slides; editing an existing arbitrary doc relies on the
  `documents`/`spreadsheets` scope.
- **Bare 403 ≠ scope problem.** Only Google `insufficientPermissions` maps to
  `MISSING_SCOPE`; RBAC/gate 403s must never trigger re-consent (loop risk).

## Related

- [[ai-provider-outage]] — AI key / provider remediation
- [[protected-workspaces]] — workspace deletion guardrails
- Code: `hub/lib/auth.ts` (`GOOGLE_SCOPES`), `hub/lib/google-session.ts`
  (`googleWriteErrorResponse`, `mapGoogleErrorToStatus`), `hub/lib/google.ts`
  (API wrappers)

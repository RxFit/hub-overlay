# Chat push events — spike notes (2026-08-21)

**Status: SPIKE. Nothing here is built. The verification checklist below needs
the operator's OAuth token and GCP project access, which agent sessions do not
have. Do not start Phase B until every checklist item has a recorded answer.**

## The problem being solved

Everything in the Chat panel is pull:

| Read | Cadence | Cost driver |
|---|---|---|
| messages (open space) | 30s (`useGoogleChat.ts`) | freshness of the conversation you're looking at |
| unread badges | 60s, batched | 1 readstate + 1 filtered listing **per visible space** |
| spaces list | 120s | space/name/threading drift |

The unread read was made cheap in this change-set (server-side `createTime >`
filter + field mask — see `countChatMessagesSince` in `lib/google.ts`), but the
*shape* is still polling: a Hermes reply can sit invisible for up to 30s in the
open space and 60s in the badges, and quiet spaces are re-asked forever.

## Proposed shape (two phases)

### Phase A — events feed a version vector; the browser polls the Hub, not Google

Reuse the Drive push pattern end to end (`lib/google/watch-channels.ts`,
`lib/google/webhook-channels-db.ts`, hourly `/api/webhooks/google/renew` cron —
shipped in #172):

1. **Subscriptions.** Google Workspace Events API subscription per watched
   space, target `//chat.googleapis.com/spaces/{space}`, event types
   `google.workspace.chat.message.v1.created` (+ `.updated`, `.deleted` when we
   do edit/delete UI), payload **excluded** (we only need "something changed
   where"; excluding resource data also avoids the short-TTL tier).
2. **Delivery.** Events API delivers only to a **Pub/Sub topic**; a push
   subscription forwards to a new `POST /api/webhooks/google/chat-events`
   (OIDC-authenticated, same posture as the Drive webhook).
3. **Fan-in.** The webhook writes one row per space:
   `chat_space_activity(space_name, last_event_at)` — no Google reads at all.
4. **Client.** One tiny Hub endpoint returns the activity vector; the panel
   polls it at ~15s (cheap: one DB read, zero Google calls) and refetches
   messages/unread **only for spaces whose `last_event_at` moved**. Steady
   state on a quiet account: zero Google Chat API calls.

Phase A deliberately keeps a browser poll (against the Hub) instead of SSE:
Cloud Run holds SSE connections fine but adds lifecycle/timeout management for
marginal gain over a 15s vector poll. Revisit as Phase B only if 15s feels slow.

### Phase B (optional) — SSE to the browser

Webhook → in-process broadcast → `text/event-stream` endpoint the panel
subscribes to. Only worth it after Phase A proves the subscription lifecycle.

## Verification checklist (run with operator credentials before building)

Answers recorded here, dated, before any Phase A code:

- [ ] **Scope.** Which OAuth scope creates a Chat subscription with user
      credentials — do the already-granted `chat.messages`/`chat.spaces.readonly`
      suffice, or is a new `chat.*.readonly`-family or Events-specific scope
      required? (New scope = re-consent interruption; weigh explicitly.)
- [ ] **DM coverage.** Can a user-credential subscription target a DM space and
      a `singleUserBotDm` space (the Hermes conversation), or only named spaces?
- [ ] **TTL + renewal.** Actual max `ttl` granted for payload-excluded Chat
      subscriptions, and whether `subscriptions.update` extends expiry the way
      Drive channel re-registration does. Renewal window then mirrors
      `planChannelAction`'s bootstrap/renew/healthy split.
- [ ] **Per-space count.** Subscription quota vs. the operator's realistic
      watched-space count (visible spaces only, not all spaces).
- [ ] **Event payload.** Confirm the no-payload event still carries the space
      name (it should, in the CloudEvents `subject`/attributes) — that is all
      the fan-in needs.
- [ ] **Infra.** Pub/Sub topic + push subscription + OIDC service account in
      `rxfit-automation`; add to the same Terraform/console runbook family as
      `docs/runbooks/drive-webhook-channel` setup.

## Non-goals

- Not replacing the messages fetch itself — events say *that* something
  changed; the existing route still fetches *what* changed.
- Not subscribing to spaces the user has hidden (`resolveVisibleSpaces` is the
  watch list, same rule the AI context uses).
- No new consent screens without an explicit decision — if the scope check
  above demands one, that finding comes back to the operator before build.

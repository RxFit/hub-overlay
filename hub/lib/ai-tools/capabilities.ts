import { READ_TOOLS, roleAllows } from './registry'

/**
 * Capability manifest — telling the model what live data THIS deployment can
 * actually fetch, and whether each source is configured.
 *
 * ── The failure this fixes ──
 * The system prompt never advertised the read tools. The model only learned
 * GA4 existed when a successful result happened to be injected; when the tool
 * failed (or the planner never fired), the model had zero knowledge that
 * analytics was wired in — so it answered "I don't have access, log into
 * analytics.google.com" to an admin who had just configured their GA4
 * property in Settings. The same blind spot applies to every feature wired
 * into the app without telling the assistant about it.
 *
 * ── Why it derives from the registry ──
 * The registry is already the single source for declarations, dispatch, and
 * gating. Deriving the manifest from the same table gives new tools
 * self-advertising for free — the class of bug where a feature ships and the
 * assistant denies having it cannot recur for read tools.
 *
 * The manifest is PER-REQUEST (role- and tenant-dependent), so it belongs in
 * the DYNAMIC half of the prompt — placing it in the static prefix would
 * break the prompt-cache byte-identity contract (see buildSystemPromptParts).
 */

export interface CapabilityManifestInput {
  role: string | undefined
  /** Tenant analytics targets, when the prefs lookup succeeded. */
  ga4PropertyId?: string
  gscSiteUrl?: string
  /** False when prefs could not be read this turn — the manifest then avoids
   *  claiming anything about configuration state. */
  prefsKnown: boolean
  /** Why NO retrieval could run this turn, when that is the case. The manifest
   *  still renders: "the retrieval didn't run" and "the capability doesn't
   *  exist" are different answers, and only the first one is true. */
  unavailable?: RetrievalUnavailableReason
}

/**
 * The states in which the capability list is still true but nothing could be
 * fetched. Each was previously a manifest BLACKOUT — the exact conditions under
 * which the model is most likely to deny the capability outright.
 */
export type RetrievalUnavailableReason =
  /** No Google OAuth token resolved this turn (expired/revoked/refreshing). */
  | 'no-google-session'
  /** Read-tool resolution itself threw (planner, executor, or prefs blew up). */
  | 'resolution-failed'
  /** The EXA Search toggle is ON, which disables every read tool by design. */
  | 'exa-mode'

/** Status line for a turn where nothing could run — and what to say instead. */
function unavailableNote(reason: RetrievalUnavailableReason): string[] {
  const line = {
    'no-google-session':
      "RETRIEVAL STATUS THIS TURN: the user's Google session could not be resolved, so none of the " +
      'retrievals above ran. Tell them to reconnect Google (sign out of the Hub and back in). Do NOT ' +
      'say the capability does not exist, and do NOT invent figures.',
    'resolution-failed':
      'RETRIEVAL STATUS THIS TURN: the retrieval step itself failed, so no live data was fetched even ' +
      'though the capabilities above are wired and configured. Say the lookup failed and invite a retry. ' +
      'Do NOT deny the capability, and do NOT invent figures.',
    'exa-mode':
      'RETRIEVAL STATUS THIS TURN: EXA Search mode is ON, which disables every retrieval above by design. ' +
      'If the user wants this data, say the Hub CAN get it and that turning EXA Search off lets you run ' +
      'the lookup. Do NOT say the Hub lacks the capability, and do NOT invent figures.',
  }[reason]
  return ['', line]
}

/** First sentence of a tool description — enough for the manifest without
 *  duplicating the planner-facing detail. */
function firstSentence(text: string): string {
  const end = text.indexOf('. ')
  return end === -1 ? text : text.slice(0, end + 1)
}

/**
 * Config values are admin-entered text landing UNFENCED in the trusted half of
 * the prompt, so their shape is a security boundary: flatten to one short line
 * with no markdown-structural characters, so a stored value can never smuggle
 * instruction-shaped text. Defense in depth — the write path
 * (normalizeGscSiteUrl in lib/google/prefs.ts) rejects malformed values too.
 */
function sanitizeConfigValue(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/[<>#`[\]]/g, '').slice(0, 100)
}

/** Configuration status line for the two tenant-configured analytics tools. */
function configNote(name: string, input: CapabilityManifestInput): string {
  if (!input.prefsKnown) return ''
  if (name === 'ga4_run_report') {
    return input.ga4PropertyId
      ? ` [CONFIGURED — GA4 property ${sanitizeConfigValue(input.ga4PropertyId)}]`
      : ' [NOT configured yet — an admin can pick the property in Settings → Analytics Sources]'
  }
  if (name === 'gsc_search_analytics') {
    return input.gscSiteUrl
      ? ` [CONFIGURED — site ${sanitizeConfigValue(input.gscSiteUrl)}]`
      : ' [NOT configured yet — an admin can pick the site in Settings → Analytics Sources]'
  }
  return ''
}

/**
 * Build the manifest block for the system prompt. ALWAYS returns a block.
 *
 * It used to return undefined whenever the caller's role could run no read
 * tool — which is the DEFAULT for every new user, since `onboarding` clears no
 * tool's minRole. That blackout is the same bug the manifest exists to fix,
 * just relocated: a role-gated user asking about their GA4 got a model with no
 * idea the feature exists, and heard "the Hub can't do that". The honest answer
 * is "it can, your role can't yet" — so the tools are listed with their
 * required role instead of hidden.
 */
export function buildCapabilityManifest(input: CapabilityManifestInput): string {
  const runnable = READ_TOOLS.filter(t => roleAllows(input.role, t.minRole))
  const roleGated = runnable.length === 0

  const lines = (roleGated ? READ_TOOLS : runnable).map(t =>
    roleGated
      ? `- ${t.name}: ${firstSentence(t.description)} [requires ${t.minRole} access]`
      : `- ${t.name}: ${firstSentence(t.description)}${configNote(t.name, input)}`,
  )

  if (roleGated) {
    return [
      '## Live data capabilities (wired into this app)',
      'The Hub is wired to fetch all of the LIVE data listed below. The current user\'s role',
      `(${input.role || 'unknown'}) does not clear the access bar for any of them, so no retrieval can`,
      'run this turn. The capabilities EXIST — the gap is this user\'s permission level, not the product.',
      ...lines,
      '',
      'Rules that follow from this list:',
      '- NEVER tell the user the Hub cannot do these things, and never say you "don\'t have access to"',
      '  the source. Say plainly that their current role does not permit it yet and that an admin can',
      '  raise their access level.',
      '- Do NOT send them to an external site (analytics.google.com, drive.google.com, …) as a',
      '  substitute for a capability they simply are not cleared for yet.',
      '- Never invent figures or claim to have run a lookup you could not run.',
      '- This list does not add abilities beyond it: all other action and fabrication rules in',
      '  this prompt still apply.',
    ].join('\n')
  }

  return [
    '## Live data capabilities (wired into this app)',
    'The Hub can fetch the following LIVE data for the user. The app runs these retrievals',
    'automatically on the server before you answer — you do not call them yourself. When a',
    'question needed one, its results appear in a "LIVE DATA RETRIEVED THIS TURN" or',
    '"Live Analytics" section of this prompt.',
    ...lines,
    ...(input.unavailable ? unavailableNote(input.unavailable) : []),
    '',
    'Rules that follow from this list:',
    '- NEVER tell the user you lack access to a source listed above, and never send them to an',
    '  external site (analytics.google.com, drive.google.com, …) as the first resort — the Hub',
    '  is their interface to this data.',
    '- If a retrieval section shows a tool failed, relay what the failure note says. A',
    '  PERMISSION failure means the user\'s Google account lacks access to that source —',
    '  retrying will not help; say so and suggest getting access granted. For other failures,',
    '  invite a retry or rephrase, which often succeeds. Do NOT paper over the gap with',
    '  generic education about the product, and never invent figures.',
    // Only true when a retrieval COULD have run. When the status line above
    // says nothing could run, telling the user to rephrase sends them in a
    // loop against a lookup that is switched off for a different reason.
    ...(input.unavailable
      ? []
      : [
          '- If the user clearly wants live figures but no retrieval section is present, ask them to',
          '  restate the question with a concrete metric and time range (e.g. "sessions in the last',
          '  28 days"), which triggers the lookup.',
        ]),
    // Only meaningful when config annotations are actually shown.
    ...(input.prefsKnown
      ? [
          '- A source marked [NOT configured yet] cannot return data until an admin configures it —',
          '  say so plainly and point at Settings → Analytics Sources.',
        ]
      : []),
    '- This list does not add abilities beyond it: all other action and fabrication rules in',
    '  this prompt still apply.',
  ].join('\n')
}

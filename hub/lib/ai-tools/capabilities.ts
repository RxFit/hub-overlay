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
}

/** First sentence of a tool description — enough for the manifest without
 *  duplicating the planner-facing detail. */
function firstSentence(text: string): string {
  const end = text.indexOf('. ')
  return end === -1 ? text : text.slice(0, end + 1)
}

/** Configuration status line for the two tenant-configured analytics tools. */
function configNote(name: string, input: CapabilityManifestInput): string {
  if (!input.prefsKnown) return ''
  if (name === 'ga4_run_report') {
    return input.ga4PropertyId
      ? ` [CONFIGURED — GA4 property ${input.ga4PropertyId}]`
      : ' [NOT configured yet — an admin can pick the property in Settings → Analytics Sources]'
  }
  if (name === 'gsc_search_analytics') {
    return input.gscSiteUrl
      ? ` [CONFIGURED — site ${input.gscSiteUrl}]`
      : ' [NOT configured yet — an admin can pick the site in Settings → Analytics Sources]'
  }
  return ''
}

/**
 * Build the manifest block for the system prompt, or undefined when the
 * caller's role can run no read tools (nothing to advertise — and nothing to
 * wrongly promise).
 */
export function buildCapabilityManifest(input: CapabilityManifestInput): string | undefined {
  const tools = READ_TOOLS.filter(t => roleAllows(input.role, t.minRole))
  if (!tools.length) return undefined

  const lines = tools.map(t => `- ${t.name}: ${firstSentence(t.description)}${configNote(t.name, input)}`)

  return [
    '## Live data capabilities (wired into this app)',
    'The Hub can fetch the following LIVE data for the user. The app runs these retrievals',
    'automatically on the server before you answer — you do not call them yourself. When a',
    'question needed one, its results appear in a "LIVE DATA RETRIEVED THIS TURN" or',
    '"Live Analytics" section of this prompt.',
    ...lines,
    '',
    'Rules that follow from this list:',
    '- NEVER tell the user you lack access to a source listed above, and never send them to an',
    '  external site (analytics.google.com, drive.google.com, …) as the first resort — the Hub',
    '  is their interface to this data.',
    '- If a retrieval section shows a tool failed or did not run, say briefly what failed and',
    '  invite the user to retry or rephrase (a retry often succeeds). Do NOT paper over the gap',
    '  with generic education about the product, and never invent figures.',
    '- If the user clearly wants live figures but no retrieval section is present, ask them to',
    '  restate the question with a concrete metric and time range (e.g. "sessions in the last',
    '  28 days"), which triggers the lookup.',
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

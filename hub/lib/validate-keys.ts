/* ══════════════════════════════════════════════════════════════════════════════
   STARTUP API KEY VALIDATION
   ──────────────────────────────────────────────────────────────────────────────
   Validates AI provider API keys on cold start for quick Cloud Run debugging.
   Import this module for its side effect (logKeyStatus runs at module level).
   ══════════════════════════════════════════════════════════════════════════════ */

export interface KeyStatus {
  provider: string
  envVar: string
  status: 'valid' | 'present' | 'missing'
  formatWarning?: string
}

interface ProviderConfig {
  provider: string
  envVars: string[]
  prefix: string
}

const PROVIDERS: ProviderConfig[] = [
  {
    provider: 'anthropic',
    envVars: ['ANTHROPIC_API_KEY', 'Anthropic_API_Key', 'anthropic_token'],
    prefix: 'sk-ant-',
  },
  {
    provider: 'gemini',
    envVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
    prefix: 'AIza',
  },
]

function checkProvider(config: ProviderConfig): KeyStatus {
  for (const envVar of config.envVars) {
    const value = process.env[envVar]
    if (value) {
      if (value.startsWith(config.prefix)) {
        return { provider: config.provider, envVar, status: 'valid' }
      }
      return {
        provider: config.provider,
        envVar,
        status: 'present',
        formatWarning: `expected prefix "${config.prefix}", got "${value.slice(0, 6)}…"`,
      }
    }
  }
  return { provider: config.provider, envVar: config.envVars[0], status: 'missing' }
}

/** Returns the validation status for every configured AI provider key. */
export function getKeyStatus(): KeyStatus[] {
  return PROVIDERS.map(checkProvider)
}

/** Returns the list of providers that have a key present (valid or unrecognised format). */
export function getAvailableProviders(): string[] {
  return getKeyStatus()
    .filter(s => s.status !== 'missing')
    .map(s => s.provider)
}

/** Logs a single status line to console for Cloud Run log filtering. */
export function logKeyStatus(): void {
  const statuses = getKeyStatus()
  const parts = statuses.map(s => {
    const name = s.provider.charAt(0).toUpperCase() + s.provider.slice(1)
    if (s.status === 'valid') return `${name}=✅ valid`
    if (s.status === 'present') return `${name}=⚠️ present (unknown format)`
    return `${name}=❌ missing`
  })
  console.log(`[keys] Provider status: ${parts.join(' | ')}`)
}

// Side-effect: run on cold start when this module is first imported.
logKeyStatus()

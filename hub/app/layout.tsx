import type { Metadata, Viewport } from 'next'
import localFont from 'next/font/local'
import './globals.css'

/* ── Brand fonts, vendored (see app/fonts/README.md) ───────────────────────
 * These were `next/font/google`, which fetches from fonts.googleapis.com and
 * fonts.gstatic.com DURING `next build`. That put a live third-party network
 * call on the critical path of every production build: on 2026-09-21 the
 * fetch failed mid-build and the loader threw
 *   TypeError: Cannot read properties of null (reading '1')
 *   at @next/font/dist/google/loader.js
 * which failed CI on master, which made deploy.yml's `if:` gate skip the
 * deploy entirely. The identical tree had built green minutes earlier and
 * built green on a re-run, so nothing was wrong with the code — the build was
 * simply hostage to someone else's uptime, on the one repo where a skipped
 * deploy is invisible (deploy.yml holds traffic on the last-good revision).
 *
 * The files are now in the repo, so the build is hermetic: no network, no
 * flake, byte-identical output every time. tests/no-google-font-fetch.test.ts
 * fails CI if a `next/font/google` import ever comes back.
 *
 * One VARIABLE file per family replaces the 13 static weights the old config
 * listed — 125 KB total, and each covers the same range the app asks for.
 * `variable` exposes the same CSS custom properties the --font-* tokens in
 * globals.css already consume, so typography is unchanged. `fallback` and
 * `adjustFontFallback` keep the metric-adjusted fallback next/font/google
 * generated automatically, so the swap-in behaviour before the webfont lands
 * does not regress. */
const syne = localFont({
  src: './fonts/Syne-Variable.woff2',
  weight: '700 800',
  display: 'swap',
  variable: '--font-syne',
  fallback: ['system-ui', '-apple-system', 'sans-serif'],
})

const spaceGrotesk = localFont({
  src: './fonts/SpaceGrotesk-Variable.woff2',
  weight: '300 700',
  display: 'swap',
  variable: '--font-space-grotesk',
  fallback: ['system-ui', '-apple-system', 'sans-serif'],
})

const dmSans = localFont({
  src: './fonts/DMSans-Variable.woff2',
  weight: '300 500',
  display: 'swap',
  variable: '--font-dm-sans',
  fallback: ['system-ui', '-apple-system', 'sans-serif'],
})

const jetBrainsMono = localFont({
  src: './fonts/JetBrainsMono-Variable.woff2',
  weight: '400 700',
  display: 'swap',
  variable: '--font-jetbrains-mono',
  // Monospace metrics must fall back to a monospace face, never Arial.
  adjustFontFallback: false,
  fallback: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
})
import { getTenantConfig } from '@/lib/tenant'
import { TenantProvider } from './components/TenantProvider'
import { Providers } from './components/Providers'
import { PartialResponseBanner } from './components/PartialResponseBanner'
import { QueryProvider } from './providers'

/* ── Dynamic rendering is REQUIRED by the CSP nonce (do not remove) ──
 * middleware.ts sends `script-src 'nonce-…' 'strict-dynamic'` with a fresh
 * nonce per request, and Next only stamps that nonce onto its <script> tags
 * when the page is rendered per-request. A statically prerendered page is
 * served from the build-time cache WITHOUT nonces, so the browser blocks
 * every script — the app ships as a dead shell (no hydration, no session,
 * no working buttons; hub outage of 2026-07-13). `next dev` always renders
 * dynamically, which is why Playwright e2e cannot catch this; the
 * assert-dynamic-rendering build gate does. */
export const dynamic = 'force-dynamic'

/* Static metadata — uses default tenant at build time.
   TenantProvider updates document.title at runtime for white-label. */
const defaultTenant = getTenantConfig()

export const metadata: Metadata = {
  title: `${defaultTenant.name} Hub — ${defaultTenant.tagline}`,
  description: `${defaultTenant.tagline} — real-time project tracking, AI chat, and agent orchestration for ${defaultTenant.name}.`,
  manifest: '/site.webmanifest',
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon.ico', sizes: '32x32' },
    ],
    apple: '/apple-touch-icon.png',
  },
  openGraph: {
    title: `${defaultTenant.name} Hub — ${defaultTenant.tagline}`,
    description: `Operations intelligence hub — real-time project tracking, AI chat, and agent orchestration.`,
    siteName: `${defaultTenant.name} Hub`,
    type: 'website',
    url: `https://${defaultTenant.domain}`,
  },
  robots: {
    index: false,
    follow: false,
  },
}

export const viewport: Viewport = {
  themeColor: defaultTenant.brandColors.bgPrimary,
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html
      lang="en"
      dir="ltr"
      data-theme="dark"
      className={`${syne.variable} ${spaceGrotesk.variable} ${dmSans.variable} ${jetBrainsMono.variable}`}
    >
      <body>
        <Providers>
          <QueryProvider>
            <TenantProvider>
              <div className="hub-root-frame">
                <PartialResponseBanner />
                {children}
              </div>
            </TenantProvider>
          </QueryProvider>
        </Providers>
      </body>
    </html>
  )
}

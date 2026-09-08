import type { Metadata, Viewport } from 'next'
import { Syne, Space_Grotesk, DM_Sans, JetBrains_Mono } from 'next/font/google'
import './globals.css'

/* Self-hosted brand fonts via next/font (build-time fetch + self-host).
   Weights mirror the previous Google Fonts @import; each exposes a CSS
   variable consumed by the --font-* design tokens in globals.css. */
const syne = Syne({
  subsets: ['latin'],
  weight: ['700', '800'],
  display: 'swap',
  variable: '--font-syne',
})

const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-space-grotesk',
})

const dmSans = DM_Sans({
  subsets: ['latin'],
  weight: ['300', '400', '500'],
  display: 'swap',
  variable: '--font-dm-sans',
})

const jetBrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  display: 'swap',
  variable: '--font-jetbrains-mono',
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

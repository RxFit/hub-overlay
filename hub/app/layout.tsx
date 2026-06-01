import type { Metadata, Viewport } from 'next'
import './globals.css'
import { getTenantConfig } from '@/lib/tenant'
import { TenantProvider } from './components/TenantProvider'
import { Providers } from './components/Providers'

/* Static metadata — uses default tenant at build time.
   TenantProvider updates document.title at runtime for white-label. */
const defaultTenant = getTenantConfig()

export const metadata: Metadata = {
  title: `${defaultTenant.name} Hub — ${defaultTenant.tagline}`,
  description: `${defaultTenant.tagline} — real-time project tracking, AI chat, and agent orchestration for ${defaultTenant.name}.`,
  icons: {
    icon: '/favicon.svg',
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
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" dir="ltr" data-theme="dark">
      <body>
        <Providers>
          <TenantProvider>{children}</TenantProvider>
        </Providers>
      </body>
    </html>
  )
}

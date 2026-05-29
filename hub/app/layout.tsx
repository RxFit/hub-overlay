import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'RxFit Hub — Biological Performance Command Center',
  description: 'Biological performance intelligence hub — real-time project tracking, AI chat, and agent orchestration for RxFit Austin.',
  icons: {
    icon: '/favicon.svg',
  },
  openGraph: {
    title: 'RxFit Hub — Biological Performance Command Center',
    description: 'Operations intelligence hub for Casa Trejo — real-time project tracking, AI chat, and agent orchestration.',
    siteName: 'RxFit Hub',
    type: 'website',
    url: 'https://hub.casatrejo.com',
  },
  robots: {
    index: false,
    follow: false,
  },
}

export const viewport: Viewport = {
  themeColor: '#0a1128',
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
      <body>{children}</body>
    </html>
  )
}

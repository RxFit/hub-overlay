/** @type {import('next').NextConfig} */ // v2 deploy 2026-05-29

// Baseline security headers applied to every response.
// NOTE: the strict Content-Security-Policy lives in middleware.ts (nonce-based,
// per-request), NOT here — a static headers() entry cannot mint nonces. This
// block only covers what is safe to state once for every response, including
// the middleware-excluded paths (api/chat, api/worker, api/cron/, …).
const securityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'X-DNS-Prefetch-Control', value: 'on' },
]

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    // MANDATORY on 14.2.x for instrumentation.ts to load at all (Layer 8).
    // Without it the file is parsed and never imported — no warning, no
    // error, and every process-level handler silently no-ops. Asserted
    // alongside the file itself by scripts/assert-instrumentation.mjs.
    instrumentationHook: true,
    // Server-only source maps (ERROR_REPORTING_2026-08-24.md §5): they live in
    // the server bundle and are never served to browsers. Paired with
    // NODE_OPTIONS=--enable-source-maps in the Dockerfile so production stack
    // frames resolve to real source files — without both, the fingerprint
    // cascade's `frames` rung degrades to message grouping. Do NOT add
    // productionBrowserSourceMaps: Next auto-serves those .map files to anyone
    // who appends the extension.
    serverSourceMaps: true,
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ]
  },
}

module.exports = nextConfig

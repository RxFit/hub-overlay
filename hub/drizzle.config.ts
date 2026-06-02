import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './lib/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    // Uses DATABASE_PUBLIC_URL for local migrations (external access)
    // DATABASE_URL (internal) is used at runtime by the hub service
    url: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL || '',
  },
})

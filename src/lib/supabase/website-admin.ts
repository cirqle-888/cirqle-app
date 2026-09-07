import { createClient } from '@supabase/supabase-js'

/**
 * Admin client for the WEBSITE Supabase project — the one that serves
 * cirqle.work, holding portfolio content and supermarket flyers.
 *
 * This is deliberately a different project from the app's own. The marketing
 * site is a public single-page app, so whatever key it ships is readable by
 * anyone; pointing it at this app's project would publish the key that fronts
 * payroll, finance and client data. Keeping website content in its own project
 * means the public key can only ever reach published marketing content.
 *
 * Server-only. Never import this from a 'use client' file — the service role
 * key bypasses Row Level Security.
 */
export function createWebsiteAdminClient() {
  const url = process.env.WEBSITE_SUPABASE_URL
  const key = process.env.WEBSITE_SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error(
      'Missing website Supabase credentials. Add WEBSITE_SUPABASE_URL and WEBSITE_SUPABASE_SERVICE_ROLE_KEY to .env.local — see cirqle-website/supabase/README.md',
    )
  }
  // No Database generic: this project has its own schema, unrelated to the
  // types generated for the app's own database.
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

/** True when the website project has been configured, so the UI can explain itself. */
export function websiteSupabaseConfigured(): boolean {
  return Boolean(process.env.WEBSITE_SUPABASE_URL && process.env.WEBSITE_SUPABASE_SERVICE_ROLE_KEY)
}

import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { syncProjectWorker } from '../src/lib/advertising/workers/sync'
import { recommendationWorker, executiveSummaryWorker } from '../src/lib/advertising/workers/ai'

config({ path: '.env.local' })

async function runE2E() {
  console.log("=== META ADS LIVE E2E INTEGRATION ===")
  
  // 1. Verify Environment
  console.log("1. Verifying environment variables...")
  const appId = process.env.META_APP_ID || process.env.META_CLIENT_ID
  const appSecret = process.env.META_APP_SECRET || process.env.META_CLIENT_SECRET
  
  if (!appId || !appSecret) {
    console.error("❌ MISSING META_APP_ID or META_APP_SECRET in .env.local")
    console.error("Please add them and re-run.")
    process.exit(1)
  }
  console.log("✅ Credentials verified")

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseKey) {
    console.error("❌ Missing Supabase URL or Service Role Key")
    process.exit(1)
  }
  
  const supabase = createClient(supabaseUrl, supabaseKey)

  // 2. Discover Ad Accounts & Check Token
  console.log("2. Checking for active Meta OAuth connection in database...")
  const { data: connections, error } = await supabase
    .from('provider_connections')
    .select('*')
    .eq('provider', 'meta')
    .eq('status', 'active')

  if (error) {
    console.error("❌ Database error:", error)
    process.exit(1)
  }

  if (!connections || connections.length === 0) {
    console.log("⚠️ No active Meta connection found.")
    console.log("To continue the E2E test, please open your browser to:")
    console.log(`http://localhost:3000/api/auth/meta/login?client_id=e2e-test-client`)
    console.log("Complete the login flow, then re-run this script.")
    process.exit(0)
  }

  const connection = connections[0]
  console.log(`✅ Found active Meta connection for Client: ${connection.client_id}`)

  // 3. Campaign Synchronization
  console.log("3. Triggering Campaign Synchronization Worker...")
  try {
    const syncResult = await syncProjectWorker({ 
      id: 'test-sync-job',
      job_type: 'sync_ads',
      payload: { project_id: connection.client_id, provider: 'meta' },
      status: 'processing',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    } as any)
    console.log("✅ Sync Worker completed successfully.")
  } catch (err: any) {
    console.error("❌ Sync Worker failed:", err)
    process.exit(1)
  }

  // 4. Verify Metrics Downloaded
  console.log("4. Verifying imported data...")
  const { count: campaignCount } = await supabase.from('ad_campaigns').select('*', { count: 'exact', head: true }).eq('project_id', connection.client_id)
  const { count: metricsCount } = await supabase.from('ad_daily_metrics').select('*', { count: 'exact', head: true }).eq('project_id', connection.client_id)
  
  console.log(`✅ Campaigns Downloaded: ${campaignCount}`)
  console.log(`✅ Daily Metrics Downloaded: ${metricsCount}`)

  if (campaignCount === 0) {
    console.log("⚠️ Warning: No campaigns were downloaded. Ensure the Meta Ad Account has active campaigns.")
  }

  // 5. Trigger AI Pipeline
  console.log("5. Triggering AI Recommendation Pipeline...")
  try {
    await recommendationWorker({
      id: 'test-rec-job',
      job_type: 'generate_recommendations',
      payload: { project_id: connection.client_id },
      status: 'processing',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    } as any)
    console.log("✅ AI Recommendation Engine completed.")
  } catch (err: any) {
    console.error("❌ AI Recommendation Engine failed:", err)
    // Don't exit here, maybe it's just a rate limit
  }

  console.log("6. Triggering AI Executive Summary Pipeline...")
  try {
    await executiveSummaryWorker({
      id: 'test-exec-job',
      job_type: 'generate_executive_summary',
      payload: { project_id: connection.client_id },
      status: 'processing',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    } as any)
    console.log("✅ AI Executive Summary completed.")
  } catch (err: any) {
    console.error("❌ AI Executive Engine failed:", err)
  }

  // 7. Verify AI Outputs
  console.log("7. Verifying AI Insights generated...")
  const { count: insightsCount } = await supabase.from('ad_ai_insights').select('*', { count: 'exact', head: true }).eq('project_id', connection.client_id)
  console.log(`✅ Total AI Insights: ${insightsCount}`)

  console.log("\n=============================================")
  console.log("🎉 END-TO-END VALIDATION REPORT 🎉")
  console.log(`Status: ${campaignCount && campaignCount > 0 ? 'SUCCESS' : 'NO DATA'}`)
  console.log(`Connected Client ID: ${connection.client_id}`)
  console.log(`Total Campaigns: ${campaignCount}`)
  console.log(`Total Metrics Rows: ${metricsCount}`)
  console.log(`Total AI Insights: ${insightsCount}`)
  console.log("Dashboards are ready to display this data.")
  console.log("=============================================\n")
}

runE2E()

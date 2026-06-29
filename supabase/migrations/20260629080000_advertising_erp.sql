-- =====================================================================================
-- Phase 2A: Digital Marketing ERP Architecture (Provider-Agnostic)
-- =====================================================================================

-- 1. Authentication Layer (Provider Connections)
CREATE TABLE provider_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    provider TEXT NOT NULL, -- e.g., 'meta', 'google', 'tiktok'
    access_token TEXT,
    refresh_token TEXT,
    token_expires_at TIMESTAMPTZ,
    refresh_time TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'active', -- 'active', 'expired', 'error'
    last_auth_at TIMESTAMPTZ DEFAULT now(),
    connected_by UUID REFERENCES employees(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(client_id, provider)
);

CREATE TRIGGER update_provider_connections_modtime
BEFORE UPDATE ON provider_connections FOR EACH ROW
EXECUTE FUNCTION update_updated_at();

-- 2. Business Managers
CREATE TABLE ad_businesses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connection_id UUID NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    business_id TEXT NOT NULL, -- External business ID
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(connection_id, business_id)
);

CREATE TRIGGER update_ad_businesses_modtime
BEFORE UPDATE ON ad_businesses FOR EACH ROW
EXECUTE FUNCTION update_updated_at();

-- 3. Advertising Accounts
CREATE TABLE ad_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connection_id UUID NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
    business_id UUID REFERENCES ad_businesses(id) ON DELETE CASCADE,
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    account_id TEXT NOT NULL, -- External ID, e.g., act_12345
    name TEXT NOT NULL,
    currency TEXT,
    timezone TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(provider, account_id)
);

CREATE TRIGGER update_ad_accounts_modtime
BEFORE UPDATE ON ad_accounts FOR EACH ROW
EXECUTE FUNCTION update_updated_at();

-- 4. Generic Background Jobs Engine
CREATE TABLE system_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_type TEXT NOT NULL, -- e.g., 'advertising_sync_project', 'email_send'
    priority TEXT NOT NULL DEFAULT 'normal', -- 'high', 'normal', 'low'
    status TEXT NOT NULL DEFAULT 'waiting', -- 'waiting', 'queued', 'running', 'completed', 'failed'
    payload JSONB DEFAULT '{}'::jsonb,
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 3,
    error_log TEXT,
    queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER update_system_jobs_modtime
BEFORE UPDATE ON system_jobs FOR EACH ROW
EXECUTE FUNCTION update_updated_at();
CREATE INDEX idx_system_jobs_status_priority ON system_jobs (status, priority);

-- 5. Sync Logs
CREATE TABLE ad_sync_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider TEXT NOT NULL,
    client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
    project_id UUID REFERENCES ad_projects(id) ON DELETE CASCADE,
    job_id UUID REFERENCES system_jobs(id) ON DELETE SET NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    duration_ms INTEGER,
    status TEXT NOT NULL, -- 'success', 'partial', 'error', 'running'
    api_calls_made INTEGER DEFAULT 0,
    records_imported INTEGER DEFAULT 0,
    records_updated INTEGER DEFAULT 0,
    records_skipped INTEGER DEFAULT 0,
    failed_records INTEGER DEFAULT 0,
    error_message TEXT,
    trigger_source TEXT NOT NULL, -- 'scheduled', 'manual', 'initial', 'webhook'
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6. Modify existing ad_projects
ALTER TABLE ad_projects 
ADD COLUMN ad_account_id UUID REFERENCES ad_accounts(id) ON DELETE SET NULL,
ADD COLUMN external_campaign_id TEXT, -- Promoted from provider_metadata for indexing
ADD COLUMN provider_metadata JSONB, -- { "adset_id": "...", "campaign_objective": "..." }
ADD COLUMN tracking_config JSONB, -- { "pixel_id": "...", "utm_source": "..." }
ADD COLUMN sync_enabled BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'idle', -- 'idle', 'queued', 'running', 'error'
ADD COLUMN last_sync_at TIMESTAMPTZ,
ADD COLUMN last_sync_error TEXT;

CREATE INDEX idx_ad_projects_external_campaign ON ad_projects(external_campaign_id);

-- 7. Modify existing ad_daily_metrics
ALTER TABLE ad_daily_metrics
ADD COLUMN source TEXT NOT NULL DEFAULT 'Manual',
ADD COLUMN sync_state TEXT NOT NULL DEFAULT 'manual', -- 'imported', 'manual', 'locked'
ADD COLUMN version INTEGER NOT NULL DEFAULT 1,
ADD COLUMN base_currency TEXT DEFAULT 'INR',
ADD COLUMN ad_currency TEXT,
ADD COLUMN billing_currency TEXT,
ADD COLUMN exchange_rate_ad_to_base NUMERIC,
ADD COLUMN exchange_rate_ad_to_billing NUMERIC;

CREATE INDEX idx_ad_daily_metrics_sync_state ON ad_daily_metrics (sync_state);

-- 8. Seed Centralized Settings
INSERT INTO company_settings (key, value) VALUES
  ('advertising.notifications.budget_warning_pct', '80'),
  ('advertising.notifications.roas_min', '2.0'),
  ('advertising.notifications.ctr_min', '1.0'),
  ('advertising.sync.interval_hours', '1'),
  ('advertising.sync.auto_sync_enabled', 'true'),
  ('advertising.reporting.default_currency', 'INR')
ON CONFLICT (key) DO NOTHING;

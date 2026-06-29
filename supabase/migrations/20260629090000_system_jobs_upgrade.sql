-- system_jobs: add columns required by the enterprise background job engine.
-- These were referenced in engine.ts but missing from the initial ERP migration.

ALTER TABLE system_jobs ADD COLUMN IF NOT EXISTS parent_job_id UUID REFERENCES system_jobs(id) ON DELETE SET NULL;
ALTER TABLE system_jobs ADD COLUMN IF NOT EXISTS depends_on_job_id UUID REFERENCES system_jobs(id) ON DELETE SET NULL;
ALTER TABLE system_jobs ADD COLUMN IF NOT EXISTS retry_delay_seconds INTEGER NOT NULL DEFAULT 60;
ALTER TABLE system_jobs ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';
ALTER TABLE system_jobs ADD COLUMN IF NOT EXISTS locked_by TEXT;
ALTER TABLE system_jobs ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_system_jobs_locked ON system_jobs (locked_at) WHERE locked_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_system_jobs_parent ON system_jobs (parent_job_id) WHERE parent_job_id IS NOT NULL;

-- Atomic dequeue function for FOR UPDATE SKIP LOCKED processing.
-- Called by engine.ts dequeueJobs().
CREATE OR REPLACE FUNCTION dequeue_jobs(p_worker_id TEXT, p_max_jobs INTEGER DEFAULT 5)
RETURNS SETOF system_jobs
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
    UPDATE system_jobs
    SET
      status    = 'running',
      started_at = COALESCE(started_at, NOW()),
      locked_by = p_worker_id,
      locked_at = NOW()
    WHERE id IN (
      SELECT id FROM system_jobs
      WHERE status IN ('pending', 'queued')
        AND (locked_by IS NULL OR locked_at < NOW() - INTERVAL '5 minutes')
        AND (depends_on_job_id IS NULL OR EXISTS (
              SELECT 1 FROM system_jobs j2
              WHERE j2.id = depends_on_job_id AND j2.status = 'completed'
            ))
      ORDER BY
        CASE priority WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
        queued_at ASC
      LIMIT p_max_jobs
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *;
END;
$$;

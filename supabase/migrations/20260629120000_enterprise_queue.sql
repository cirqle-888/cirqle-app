-- Phase D: Enterprise Queue Engine
-- Expansion of system_jobs to support DAGs, atomic locking, and robust retry logic.

-- 1. Add new columns
ALTER TABLE system_jobs 
ADD COLUMN IF NOT EXISTS locked_by UUID, -- ID of the worker processing this job
ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ, -- Heartbeat timestamp
ADD COLUMN IF NOT EXISTS parent_job_id UUID REFERENCES system_jobs(id) ON DELETE SET NULL, -- DAG Parent
ADD COLUMN IF NOT EXISTS depends_on_job_id UUID REFERENCES system_jobs(id) ON DELETE SET NULL, -- Must complete before this runs
ADD COLUMN IF NOT EXISTS retry_delay_seconds INTEGER DEFAULT 60, -- Exponential backoff base
ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb; -- Worker-specific metadata/state

-- 2. Expand status constraints
-- Re-create the status constraint if it existed, otherwise just add it or rely on application logic.
-- The prompt specifies statuses: pending, running, completed, failed, retrying, cancelled, dead_letter.
-- Since the previous migration used default 'waiting', we will keep 'waiting' or map it to 'pending'.
-- Let's assume 'pending', 'queued', 'running', 'completed', 'failed', 'retrying', 'cancelled', 'dead_letter'.
-- Since there was no check constraint in the previous file, we don't need to drop one.

-- 3. Create Atomic Dequeue RPC
-- This function securely fetches up to N jobs that are eligible to run, 
-- locks them to the specified worker, and updates their status to 'running'.
CREATE OR REPLACE FUNCTION dequeue_jobs(p_worker_id UUID, p_max_jobs INT DEFAULT 5)
RETURNS SETOF system_jobs
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    WITH available_jobs AS (
        SELECT sj.id
        FROM system_jobs sj
        LEFT JOIN system_jobs dep ON sj.depends_on_job_id = dep.id
        WHERE sj.status IN ('waiting', 'pending', 'queued', 'retrying')
          AND sj.queued_at <= now()
          -- Dependency is either NULL or completed
          AND (sj.depends_on_job_id IS NULL OR dep.status = 'completed')
        ORDER BY 
          CASE priority
            WHEN 'high' THEN 1
            WHEN 'normal' THEN 2
            WHEN 'low' THEN 3
            ELSE 4
          END ASC,
          sj.queued_at ASC
        LIMIT p_max_jobs
        FOR UPDATE SKIP LOCKED
    )
    UPDATE system_jobs j
    SET 
        status = 'running',
        locked_by = p_worker_id,
        locked_at = now(),
        started_at = COALESCE(j.started_at, now()),
        updated_at = now()
    FROM available_jobs aj
    WHERE j.id = aj.id
    RETURNING j.*;
END;
$$;

-- 4. Create Requeue Stale Jobs RPC
-- Releases jobs that have been locked but haven't pulsed a heartbeat in X minutes.
CREATE OR REPLACE FUNCTION requeue_stale_jobs(p_timeout_minutes INT DEFAULT 5)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_count INTEGER;
BEGIN
    UPDATE system_jobs
    SET 
        status = 'retrying',
        locked_by = NULL,
        locked_at = NULL,
        error_log = COALESCE(error_log || E'\n', '') || '[' || now()::text || '] Worker crashed or timed out.',
        attempts = attempts + 1,
        queued_at = now() + (retry_delay_seconds * power(2, attempts)) * interval '1 second',
        updated_at = now()
    WHERE status = 'running'
      AND locked_at < now() - (p_timeout_minutes || ' minutes')::interval;
      
    GET DIAGNOSTICS v_count = ROW_COUNT;
    
    -- Handle dead letters for stale jobs that exceeded max attempts
    UPDATE system_jobs
    SET status = 'dead_letter', locked_by = NULL, locked_at = NULL
    WHERE status = 'retrying' AND attempts >= max_attempts;
    
    RETURN v_count;
END;
$$;


-- phase3_allocations.sql

BEGIN;

-- 1. Create Allocation Table
CREATE TABLE IF NOT EXISTS cashbook_invoice_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cashbook_entry_id UUID NOT NULL REFERENCES cashbook_entries(id) ON DELETE RESTRICT,
    invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
    allocated_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    deleted_at TIMESTAMP WITH TIME ZONE
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_allocations_cashbook_entry_id ON cashbook_invoice_allocations(cashbook_entry_id);
CREATE INDEX IF NOT EXISTS idx_allocations_invoice_id ON cashbook_invoice_allocations(invoice_id);
CREATE INDEX IF NOT EXISTS idx_allocations_created_at ON cashbook_invoice_allocations(created_at);
CREATE INDEX IF NOT EXISTS idx_allocations_deleted_at ON cashbook_invoice_allocations(deleted_at);

-- Add triggers for updated_at
CREATE OR REPLACE FUNCTION update_allocations_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = NOW();
   RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_cashbook_invoice_allocations_modtime ON cashbook_invoice_allocations;
CREATE OR REPLACE TRIGGER update_cashbook_invoice_allocations_modtime
    BEFORE UPDATE ON cashbook_invoice_allocations
    FOR EACH ROW
    EXECUTE FUNCTION update_allocations_updated_at_column();

-- 2. Create Allocation Audit Log Table
CREATE TABLE IF NOT EXISTS allocation_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    allocation_id UUID, -- Not a strict foreign key to allow keeping logs for deleted allocations
    cashbook_entry_id UUID NOT NULL,
    old_invoice_id UUID,
    new_invoice_id UUID,
    old_amount DECIMAL(12,2),
    new_amount DECIMAL(12,2),
    action VARCHAR(50) NOT NULL, -- 'CREATED', 'UPDATED', 'DELETED', 'REASSIGNED'
    operator VARCHAR(255) DEFAULT 'system',
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_alloc_audit_cashbook_entry_id ON allocation_audit_log(cashbook_entry_id);
CREATE INDEX IF NOT EXISTS idx_alloc_audit_allocation_id ON allocation_audit_log(allocation_id);

-- Enable RLS (Assuming typical authenticated access, adjust if necessary)
ALTER TABLE cashbook_invoice_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE allocation_audit_log ENABLE ROW LEVEL SECURITY;

-- Base RLS policies (allow authenticated access)
DROP POLICY IF EXISTS "Enable read access for all users" ON cashbook_invoice_allocations;
CREATE POLICY "Enable read access for all users" ON cashbook_invoice_allocations FOR SELECT USING (true);
DROP POLICY IF EXISTS "Enable insert access for authenticated users" ON cashbook_invoice_allocations;
CREATE POLICY "Enable insert access for authenticated users" ON cashbook_invoice_allocations FOR INSERT TO authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "Enable update access for authenticated users" ON cashbook_invoice_allocations;
CREATE POLICY "Enable update access for authenticated users" ON cashbook_invoice_allocations FOR UPDATE TO authenticated USING (true);
DROP POLICY IF EXISTS "Enable delete access for authenticated users" ON cashbook_invoice_allocations;
CREATE POLICY "Enable delete access for authenticated users" ON cashbook_invoice_allocations FOR DELETE TO authenticated USING (true);

DROP POLICY IF EXISTS "Enable read access for all users" ON allocation_audit_log;
CREATE POLICY "Enable read access for all users" ON allocation_audit_log FOR SELECT USING (true);
DROP POLICY IF EXISTS "Enable insert access for authenticated users" ON allocation_audit_log;
CREATE POLICY "Enable insert access for authenticated users" ON allocation_audit_log FOR INSERT TO authenticated WITH CHECK (true);

COMMIT;

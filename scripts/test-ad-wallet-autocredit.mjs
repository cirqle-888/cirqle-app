// Isolated PostgreSQL integration test. Does not read .env or touch Supabase.
// npm install --prefix /tmp/cirqle-wallet-sql-test @electric-sql/pglite
// PGLITE_MODULE=/tmp/cirqle-wallet-sql-test/node_modules/@electric-sql/pglite/dist/index.js node scripts/test-ad-wallet-autocredit.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')
const db = new PGlite()
await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE cashbook_entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), type text, amount numeric, amount_inr numeric,
 client_id uuid, ad_account_id uuid, bank_account_id uuid, currency text DEFAULT 'INR',
 deleted_at timestamptz, reversal_of uuid, description text
);
CREATE TABLE ad_wallet_ledger (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid, direction text, kind text,
 cashbook_entry_id uuid REFERENCES cashbook_entries(id), amount numeric, amount_inr numeric,
 notes text, created_by uuid, deleted_at timestamptz
);`)
await db.exec(await readFile(new URL('../supabase/migrations/20260714095000_wallet_credit_rpc.sql', import.meta.url), 'utf8'))
await db.exec(await readFile(new URL('../supabase/migrations/20261028170000_cashbook_ad_wallet_autocredit.sql', import.meta.url), 'utf8'))
const client = '00000000-0000-0000-0000-000000000001'
const account = '00000000-0000-0000-0000-000000000002'
const bank = '00000000-0000-0000-0000-000000000003'
async function insert(amount = 800, type = 'outflow', clientId = client, inr = amount) {
 return (await db.query(`INSERT INTO cashbook_entries(type,amount,amount_inr,client_id,ad_account_id,bank_account_id)
 VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,[type,amount,inr,clientId,account,bank])).rows[0].id
}
async function totals(id) {
 const r=(await db.query(`SELECT count(*)::int n, coalesce(sum(amount),0)::float8 amount,
 coalesce(sum(amount_inr),0)::float8 inr FROM ad_wallet_ledger WHERE cashbook_entry_id=$1 AND deleted_at IS NULL`,[id])).rows[0]
 return r
}
const id=await insert()
assert.deepEqual(await totals(id),{n:1,amount:800,inr:800})
await db.query('SELECT reconcile_cashbook_ad_wallet($1)',[id])
assert.deepEqual(await totals(id),{n:1,amount:800,inr:800})
await db.query('UPDATE cashbook_entries SET description=$2 WHERE id=$1',[id,'repeat save'])
assert.deepEqual(await totals(id),{n:1,amount:800,inr:800})
await db.query('UPDATE cashbook_entries SET amount=900,amount_inr=900 WHERE id=$1',[id])
assert.deepEqual(await totals(id),{n:1,amount:900,inr:900})
await assert.rejects(db.query('SELECT credit_ad_wallet($1,$2,100)',[client,id]),/still unassigned/)
await assert.rejects(db.query('UPDATE cashbook_entries SET client_id=$2 WHERE id=$1',[id,bank]),/Release/)
await db.query('UPDATE cashbook_entries SET deleted_at=now() WHERE id=$1',[id])
assert.equal((await totals(id)).amount,0)
await db.query('UPDATE cashbook_entries SET deleted_at=null WHERE id=$1',[id])
assert.deepEqual(await totals(id),{n:1,amount:900,inr:900})
assert.equal((await totals(await insert(800,'inflow'))).amount,0)
assert.equal((await totals(await insert(800,'outflow',null))).amount,0)
assert.deepEqual(await totals(await insert(100,'outflow',client,2200)),{n:1,amount:100,inr:2200})
await assert.rejects(db.query('UPDATE cashbook_entries SET bank_account_id=null WHERE id=$1',[id]),/bank account/)
await assert.rejects(db.query('UPDATE cashbook_entries SET amount=0 WHERE id=$1',[id]),/positive amount/)
// Simulate a legacy entry already partly / fully credited by the old RPC.
for(const manual of [200,800]) {
 await db.exec('ALTER TABLE cashbook_entries DISABLE TRIGGER cashbook_ad_wallet_autocredit')
 const legacy=await insert()
 await db.query('SELECT credit_ad_wallet($1,$2,$3)',[client,legacy,manual])
 await db.exec('ALTER TABLE cashbook_entries ENABLE TRIGGER cashbook_ad_wallet_autocredit')
 await db.query('UPDATE cashbook_entries SET description=$2 WHERE id=$1',[legacy,'legacy reconciliation'])
 assert.deepEqual(await totals(legacy),{n:manual===800?1:2,amount:800,inr:800})
 await db.query('UPDATE cashbook_entries SET description=$2 WHERE id=$1',[legacy,'retry'])
 assert.equal((await totals(legacy)).amount,800)
 await assert.rejects(db.query('UPDATE cashbook_entries SET amount=100,amount_inr=100 WHERE id=$1',[legacy]),/manual wallet credits/)
 assert.equal((await totals(legacy)).amount,800)
 if(manual===800) await assert.rejects(db.query('UPDATE cashbook_entries SET amount_inr=900 WHERE id=$1',[legacy]),/currency totals/)
}
// Reversed funding may not be revived by a later note edit.
await db.query(`INSERT INTO cashbook_entries(type,amount,amount_inr,reversal_of) VALUES('inflow',900,900,$1)`,[id])
await db.query('UPDATE cashbook_entries SET description=$2 WHERE id=$1',[id,'reversed'])
assert.equal((await totals(id)).amount,0)
assert.equal((await db.query('SELECT count(*)::int n FROM cashbook_entries WHERE description LIKE $1',['%service%'])).rows[0].n,0)
console.log('PASS: wallet auto-credit, repeat-save, edits, legacy partial/full credits, rollback, FX, deletion/restore and reversal checks')
await db.close()

'use client'

/**
 * Recurring expenses — rent, internet, subscriptions.
 *
 * Deliberately one screen, one list, one primary action. A single owner wants
 * to answer "what goes out automatically, and when" at a glance, then get out.
 * Everything optional (currency, bank account, end date, notes) is folded away,
 * so adding rent is four fields: name, category, amount, day of month.
 *
 * The nightly cron posts each due rule into the Cash Book. Nothing here writes
 * a Cash Book entry directly — this only manages the rules.
 */

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import Header from '@/components/layout/header'
import AppSelect from '@/components/ui/app-select'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { OverflowMenu } from '@/components/ui/overflow-menu'
import { useToast, ToastContainer } from '@/components/ui/toast'
import { formatDate } from '@/lib/utils/format-date'
import {
  saveRecurringExpense, setRecurringExpenseActive, deleteRecurringExpense,
  type RecurringExpenseRow,
} from '../recurring-actions'
import {
  Plus, ChevronDown, Repeat, Pencil, Trash2, Pause, Play, ArrowLeft, Loader2,
} from 'lucide-react'

const inr = (v: number) => `₹${Math.round(v).toLocaleString('en-IN')}`
const today = () => new Date().toISOString().slice(0, 10)

/** "1st", "2nd", "3rd", "21st" — reads like a person wrote it. */
function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

interface FormState {
  id?: string
  name: string
  categoryId: string
  amount: string
  dayOfMonth: string
  frequency: 'monthly' | 'yearly'
  startDate: string
  endDate: string
  bankAccountId: string
  notes: string
}

const emptyForm = (): FormState => ({
  name: '', categoryId: '', amount: '', dayOfMonth: '1', frequency: 'monthly',
  startDate: today(), endDate: '', bankAccountId: '', notes: '',
})

const fromRow = (r: RecurringExpenseRow): FormState => ({
  id: r.id,
  name: r.name,
  categoryId: r.category_id,
  amount: String(r.amount ?? ''),
  dayOfMonth: String(r.day_of_month ?? 1),
  frequency: r.frequency,
  startDate: r.start_date,
  endDate: r.end_date ?? '',
  bankAccountId: r.bank_account_id ?? '',
  notes: r.notes ?? '',
})

export default function RecurringClient({
  initialRules, loadError, categories, bankAccounts, canEdit,
}: {
  initialRules: RecurringExpenseRow[]
  loadError: string | null
  categories: { id: string; name: string }[]
  bankAccounts: { id: string; name: string }[]
  canEdit: boolean
}) {
  const router = useRouter()
  const { toasts, dismiss, success, error: toastError } = useToast()
  const [, startTransition] = useTransition()
  const [form, setForm] = useState<FormState | null>(null)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<RecurringExpenseRow | null>(null)

  const rules = initialRules
  const active = rules.filter(r => r.is_active)
  const monthlyTotal = useMemo(
    () => active.filter(r => r.frequency === 'monthly').reduce((s, r) => s + (r.amount_inr || 0), 0),
    [active],
  )

  const refresh = () => startTransition(() => router.refresh())

  async function handleSave() {
    if (!form) return
    const amount = Number(form.amount)
    const day = Number(form.dayOfMonth)
    if (!form.name.trim()) { toastError('Give it a name', 'e.g. Office rent'); return }
    if (!form.categoryId) { toastError('Pick a category'); return }
    if (!(amount > 0)) { toastError('Enter an amount greater than 0'); return }
    if (!(day >= 1 && day <= 31)) { toastError('Day of month must be between 1 and 31'); return }

    setSaving(true)
    const res = await saveRecurringExpense({
      id: form.id,
      name: form.name.trim(),
      categoryId: form.categoryId,
      amount,
      // Rules are entered in rupees on this screen, so the INR snapshot the
      // engine stores is the same number. A future multi-currency rule would
      // convert here rather than in the action.
      amountInr: amount,
      currency: 'INR',
      dayOfMonth: day,
      frequency: form.frequency,
      startDate: form.startDate,
      endDate: form.endDate || null,
      bankAccountId: form.bankAccountId || null,
      notes: form.notes.trim() || null,
    })
    setSaving(false)
    if (res.ok) {
      success(form.id ? 'Recurring expense updated' : 'Recurring expense added',
        `${form.name.trim()} — ${inr(amount)} on the ${ordinal(day)}`)
      setForm(null)
      refresh()
    } else {
      toastError('Could not save', res.error)
    }
  }

  async function toggleActive(r: RecurringExpenseRow) {
    setBusyId(r.id)
    const res = await setRecurringExpenseActive(r.id, !r.is_active)
    setBusyId(null)
    if (res.ok) { success(r.is_active ? `${r.name} paused` : `${r.name} resumed`); refresh() }
    else toastError('Could not update', res.error)
  }

  async function applyDelete(r: RecurringExpenseRow) {
    setBusyId(r.id)
    const res = await deleteRecurringExpense(r.id)
    setBusyId(null)
    if (res.ok) { success(`${r.name} deleted`); refresh() }
    else toastError('Could not delete', res.error)
  }

  const field = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm'
  const labelCls = 'block text-xs font-medium text-muted-foreground mb-1.5'

  return (
    <>
      <Header
        title="Recurring Expenses"
        subtitle={
          active.length > 0
            ? `${active.length} active · ${inr(monthlyTotal)} a month, posted automatically`
            : 'Bills that repeat — posted to the Cash Book automatically'
        }
        // Short label: a long one competes with the page title for header
        // width and truncates it — the mistake the Tasks toolbar made.
        actions={canEdit ? (
          <button onClick={() => setForm(emptyForm())}
            className="flex items-center gap-1.5 gradient-bg text-white text-sm font-medium px-4 py-2 rounded-lg hover:opacity-90 transition-opacity whitespace-nowrap">
            <Plus className="w-4 h-4" /> Add
          </button>
        ) : undefined}
      />

      <div className="p-4 md:p-6 space-y-4 max-w-3xl">
        <Link href="/dashboard/cashbook"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-4 h-4" /> Back to Cash Book
        </Link>

        {loadError && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
            Couldn&rsquo;t load recurring expenses. {loadError}
          </div>
        )}

        {rules.length === 0 ? (
          <div className="rounded-xl border border-border bg-card">
            <EmptyState
              icon={Repeat}
              title="No recurring expenses yet"
              body="Add the bills that repeat every month — rent, internet, software subscriptions. Each one posts itself into the Cash Book on the day you choose, so you never record it by hand."
              action={canEdit ? { label: 'Add recurring expense', onClick: () => setForm(emptyForm()) } : undefined}
            />
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden">
            {rules.map(r => (
              <div key={r.id} className={`flex items-center gap-3 px-4 py-3 ${r.is_active ? '' : 'opacity-60'}`}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-medium text-sm truncate">{r.name}</span>
                    {!r.is_active && (
                      <span className="shrink-0 text-[10px] rounded-full bg-foreground/10 text-muted-foreground px-1.5 py-0.5 font-medium">
                        Paused
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 truncate">
                    {r.category_name ?? 'Uncategorised'} ·{' '}
                    {r.frequency === 'monthly'
                      ? `${ordinal(r.day_of_month)} of every month`
                      : `${ordinal(r.day_of_month)}, once a year`}
                    {r.is_active && r.next_due && <> · next {formatDate(r.next_due)}</>}
                    {r.last_posted && <> · last posted {formatDate(r.last_posted)}</>}
                  </p>
                </div>
                <span className="shrink-0 text-sm font-semibold tabular-nums">{inr(r.amount_inr)}</span>
                {canEdit && (
                  busyId === r.id
                    ? <Loader2 className="w-4 h-4 animate-spin text-muted-foreground shrink-0" />
                    : (
                      <OverflowMenu
                        items={[
                          { label: 'Edit', icon: Pencil, onClick: () => setForm(fromRow(r)) },
                          {
                            label: r.is_active ? 'Pause' : 'Resume',
                            icon: r.is_active ? Pause : Play,
                            onClick: () => { void toggleActive(r) },
                          },
                          { label: 'Delete', icon: Trash2, danger: true, separatorBefore: true, onClick: () => setDeleteTarget(r) },
                        ]}
                      />
                    )
                )}
              </div>
            ))}
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          Entries are created automatically each day the rule falls due. Pausing stops future
          entries; entries already posted to the Cash Book stay exactly as they are.
        </p>
      </div>

      {/* ── Add / edit ─────────────────────────────────────────────────────── */}
      {form && (
        <ModalOverlay onClose={() => setForm(null)} sheetOnMobile>
          <div className="w-full sm:max-w-md bg-card border border-border rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[90dvh] overflow-y-auto">
            <div className="px-6 py-4 border-b border-border">
              <h2 className="font-semibold">{form.id ? 'Edit recurring expense' : 'Add recurring expense'}</h2>
            </div>

            <div className="p-6 space-y-4">
              <div>
                <label className={labelCls}>What is it?</label>
                <input value={form.name} autoFocus
                  onChange={e => setForm(f => f && ({ ...f, name: e.target.value }))}
                  className={field} placeholder="e.g. Office rent, Internet, Adobe" />
              </div>

              <div>
                <label className={labelCls}>Category</label>
                <AppSelect value={form.categoryId}
                  onChange={e => setForm(f => f && ({ ...f, categoryId: e.target.value }))}>
                  <option value="">— select —</option>
                  {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </AppSelect>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Amount (₹)</label>
                  <input type="number" min={0} step="0.01" value={form.amount}
                    onChange={e => setForm(f => f && ({ ...f, amount: e.target.value }))}
                    className={field} placeholder="15000" />
                </div>
                <div>
                  <label className={labelCls}>Day of month</label>
                  <input type="number" min={1} max={31} value={form.dayOfMonth}
                    onChange={e => setForm(f => f && ({ ...f, dayOfMonth: e.target.value }))}
                    className={field} />
                </div>
              </div>

              {/* Everything below is rarely changed: monthly on the chosen day,
                  starting today, forever, from the default account. Folded so
                  the common case is four fields — but it opens itself when an
                  existing rule already uses any of it. */}
              {(() => {
                const advCount =
                  (form.frequency !== 'monthly' ? 1 : 0) +
                  (form.endDate ? 1 : 0) +
                  (form.bankAccountId ? 1 : 0) +
                  (form.notes ? 1 : 0) +
                  (form.startDate !== today() && !form.id ? 1 : 0)
                return (
                  <details open={advCount > 0} className="group rounded-xl border border-border bg-secondary/20">
                    <summary className="flex items-center justify-between gap-2 px-3 py-2.5 cursor-pointer select-none list-none">
                      <span className="text-xs font-medium text-foreground">
                        More options
                        <span className="text-muted-foreground font-normal ml-1.5">
                          {advCount > 0 ? `· ${advCount} set` : '· yearly, end date, account, notes'}
                        </span>
                      </span>
                      <ChevronDown className="w-4 h-4 text-muted-foreground group-open:rotate-180 transition-transform" />
                    </summary>
                    <div className="px-3 pb-3 space-y-4">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className={labelCls}>Repeats</label>
                          <AppSelect value={form.frequency}
                            onChange={e => setForm(f => f && ({ ...f, frequency: e.target.value as 'monthly' | 'yearly' }))}>
                            <option value="monthly">Every month</option>
                            <option value="yearly">Once a year</option>
                          </AppSelect>
                        </div>
                        <div>
                          <label className={labelCls}>Starts</label>
                          <input type="date" value={form.startDate}
                            onChange={e => setForm(f => f && ({ ...f, startDate: e.target.value }))}
                            className={field} />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className={labelCls}>Stops after <span className="opacity-60">(optional)</span></label>
                          <input type="date" value={form.endDate}
                            onChange={e => setForm(f => f && ({ ...f, endDate: e.target.value }))}
                            className={field} />
                        </div>
                        <div>
                          <label className={labelCls}>Paid from</label>
                          <AppSelect value={form.bankAccountId}
                            onChange={e => setForm(f => f && ({ ...f, bankAccountId: e.target.value }))}>
                            <option value="">Default account</option>
                            {bankAccounts.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                          </AppSelect>
                        </div>
                      </div>
                      <div>
                        <label className={labelCls}>Notes</label>
                        <input value={form.notes}
                          onChange={e => setForm(f => f && ({ ...f, notes: e.target.value }))}
                          className={field} placeholder="Optional" />
                      </div>
                    </div>
                  </details>
                )
              })()}

              {Number(form.amount) > 0 && Number(form.dayOfMonth) >= 1 && (
                <p className="text-xs text-muted-foreground">
                  Posts {inr(Number(form.amount))} to the Cash Book on the {ordinal(Number(form.dayOfMonth))}
                  {form.frequency === 'monthly' ? ' of every month' : ' once a year'}
                  {form.endDate ? `, until ${formatDate(form.endDate)}` : ''}.
                </p>
              )}
            </div>

            <div className="flex gap-3 px-6 py-4 border-t border-border">
              <button onClick={() => setForm(null)}
                className="flex-1 bg-secondary text-sm font-medium py-2.5 rounded-lg hover:bg-secondary/80">
                Cancel
              </button>
              <button onClick={() => { void handleSave() }} disabled={saving}
                className="flex-1 gradient-bg text-white text-sm font-medium py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50">
                {saving ? 'Saving…' : form.id ? 'Save changes' : 'Add expense'}
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title={`Delete "${deleteTarget.name}"?`}
          body="No more entries will be created from it. Entries already posted to the Cash Book stay where they are — delete those individually if you need to. Pause instead if you only want to stop it for a while."
          confirmLabel="Delete"
          danger
          onConfirm={() => { const r = deleteTarget; setDeleteTarget(null); void applyDelete(r) }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </>
  )
}

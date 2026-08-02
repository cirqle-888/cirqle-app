import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { saveCampaign, type ProductInput } from '@/app/intake/offer/[token]/actions'

/**
 * POST /api/figma/campaign — save an offer parsed in the Cirqle Studio plugin
 * back into Cirqle, BEFORE any cards are built in Figma.
 *
 * Why save-then-build rather than build-from-paste:
 * a list that only ever existed inside a Figma file has no change log, no
 * catalog mirroring, no price history, and is invisible to the rest of the
 * team. Cirqle stays the single source of truth; Figma stays the design
 * surface. The plugin builds from what was saved, so the flyer can always be
 * traced back to a campaign.
 *
 * This route deliberately delegates the whole write to the EXISTING
 * `saveCampaign` server action rather than reimplementing it. That one call
 * carries: product upsert, badge join rows, per-field change logs, client and
 * global catalog mirroring, one-active-campaign-per-client enforcement, and
 * the Google Sheet sync trigger — all behaviour the Offer Intake form already
 * relies on. Duplicating any of it here would create a second, divergent
 * write path.
 *
 * Auth: workspace `offer_sheet_secret` (same as the other figma routes).
 * The client is addressed by `clientId`; its intake token is resolved
 * server-side and never travels to the plugin.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

interface IncomingProduct {
  name?: string
  price?: number | null
  mrp?: number | null
  weight?: string | null
  badge?: string | null
  offerType?: string | null
  page?: number | null
}

interface IncomingBody {
  clientId?: string
  title?: string
  dateType?: 'single' | 'range'
  offerDate?: string
  offerDateFrom?: string
  offerDateTo?: string
  campaignId?: string
  products?: IncomingProduct[]
  /** The signed-in employee (from /api/figma/login) — used to attribute the
   * task this save creates on the Tasks page. CQID only, never a name. */
  createdBy?: { id?: string | null; cqid?: string | null }
}

const MAX_PRODUCTS = 300

export async function POST(req: NextRequest) {
  try {
    const admin = createAdminClient()

    const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim()
    const { data: secretRow } = await admin
      .from('company_settings')
      .select('value')
      .eq('key', 'offer_sheet_secret')
      .maybeSingle()
    const secret = (secretRow?.value || '').trim()
    if (!secret || !bearer || bearer !== secret) {
      return NextResponse.json(
        { ok: false, error: 'Unauthorized. Paste the shared secret from Apps → Offer Intake → Shared sync script.' },
        { status: 401, headers: CORS_HEADERS },
      )
    }

    const body = (await req.json().catch(() => null)) as IncomingBody | null
    const clientId = (body?.clientId || '').trim()
    const products = body?.products || []

    if (!clientId) {
      return NextResponse.json(
        { ok: false, error: 'No client selected. Pick a client in the plugin before saving.' },
        { status: 400, headers: CORS_HEADERS },
      )
    }
    if (!products.length) {
      return NextResponse.json(
        { ok: false, error: 'No products to save — parse a list first.' },
        { status: 400, headers: CORS_HEADERS },
      )
    }
    if (products.length > MAX_PRODUCTS) {
      return NextResponse.json(
        { ok: false, error: `${products.length} products exceeds the ${MAX_PRODUCTS} limit for one campaign.` },
        { status: 413, headers: CORS_HEADERS },
      )
    }

    // saveCampaign is addressed by the client's intake token (it is the shared
    // entry point for the public form and the staff editor alike). Resolve it
    // from the id the plugin already holds; the token itself stays server-side.
    const { data: client, error: clientError } = await admin
      .from('clients')
      .select('id, name, offer_intake_token, is_active')
      .eq('id', clientId)
      .maybeSingle()

    if (clientError) {
      return NextResponse.json({ ok: false, error: clientError.message }, { status: 500, headers: CORS_HEADERS })
    }
    if (!client || client.is_active === false) {
      return NextResponse.json(
        { ok: false, error: 'That client no longer exists or is inactive. Press Refresh in the plugin.' },
        { status: 404, headers: CORS_HEADERS },
      )
    }
    if (!client.offer_intake_token) {
      return NextResponse.json(
        {
          ok: false,
          error: `${client.name} has no Offer Intake link yet. Open Apps → Offer Intake in Cirqle and create one for this client, then try again.`,
        },
        { status: 409, headers: CORS_HEADERS },
      )
    }

    const isOfferType = (v: unknown): v is ProductInput['offer_type'] =>
      v === 'price' || v === 'percent' || v === 'bogo' || v === 'other'

    const productInputs: ProductInput[] = products.map((p, index) => {
      const badge = (p.badge || '').trim()
      const offerType = isOfferType(p.offerType) ? p.offerType : 'price'
      return {
        name: (p.name || '').trim() || `Product ${index + 1}`,
        weight: (p.weight || '').trim() || undefined,
        offer_type: offerType,
        price: typeof p.price === 'number' ? p.price : null,
        mrp: typeof p.mrp === 'number' ? p.mrp : null,
        // Free-text badge: the plugin sends a label, not an id, because the
        // client's message says "B1G1", not a badge uuid. saveCampaign accepts
        // custom_label for exactly this case.
        badges: badge ? [{ custom_label: badge, color: 'amber' }] : [],
        page: typeof p.page === 'number' && p.page > 0 ? p.page : 1,
        display_order: index,
      }
    })

    const today = new Date().toISOString().slice(0, 10)
    const dateType = body?.dateType === 'range' ? 'range' : 'single'

    // Snapshot what this save is about to replace — the client's active
    // campaign — so per-field edit counts (price/name changes) can be
    // attributed to the employee who made them (see the contribution
    // section after the save).
    type PrevProduct = { name: string | null; price: number | null; mrp: number | null; display_order: number | null }
    let prevProducts: PrevProduct[] = []
    try {
      const { data: activeCampaign } = await admin
        .from('offer_campaigns')
        .select('id')
        .eq('client_id', clientId)
        .eq('status', 'active')
        .maybeSingle()
      const activeId = (activeCampaign as { id?: string } | null)?.id
      if (activeId) {
        const { data: prevRows } = await admin
          .from('offer_products')
          .select('name, price, mrp, display_order')
          .eq('campaign_id', activeId)
          .order('display_order')
        prevProducts = (prevRows as PrevProduct[] | null) || []
      }
    } catch {
      prevProducts = []
    }

    const result = await saveCampaign(
      client.offer_intake_token,
      {
        title: body?.title?.trim() || undefined,
        date_type: dateType,
        offer_date: dateType === 'single' ? (body?.offerDate || today) : undefined,
        offer_date_from: dateType === 'range' ? (body?.offerDateFrom || today) : undefined,
        offer_date_to: dateType === 'range' ? (body?.offerDateTo || today) : undefined,
        client_note: 'Created from Cirqle Studio (Figma).',
        products: productInputs,
      },
      body?.campaignId,
    )

    if (!result.ok || !result.data) {
      return NextResponse.json(
        { ok: false, error: result.error || 'Could not save the offer.' },
        { status: 500, headers: CORS_HEADERS },
      )
    }

    // Every offer saved from Figma also lands on the Tasks page — ONE task
    // per campaign (re-saves reuse it via the [figma:cmp:…] marker), titled
    // with the offer title, assigned to everyone who worked on it, and with
    // contribution counts filled in automatically:
    //   · "Products" count      → total products in the offer
    //   · "Price Updating"      → prices/MRPs this save changed
    //   · "Product Name Updating" → names this save changed
    // The contribution panel stays the manual override — anything written
    // here can be corrected by hand. Best-effort by design: none of this
    // may ever fail the offer save.
    let taskNumber: number | null = null
    try {
      const campaignId = result.data.campaignId
      const offerTitle = body?.title?.trim() || 'Offer ' + today
      const marker = `[figma:cmp:${campaignId}]`
      const employeeId = body?.createdBy?.id || null
      // CQID, not a name — the task is already assigned to the employee row,
      // so the description only needs a staff identifier.
      const byName = (body?.createdBy?.cqid || '').trim()

      // Edit deltas: same row position, different value.
      let nameChanges = 0
      let priceChanges = 0
      for (let i = 0; i < Math.min(prevProducts.length, productInputs.length); i++) {
        const oldP = prevProducts[i]
        const newP = productInputs[i]
        if ((oldP.name || '').trim() !== newP.name.trim()) nameChanges++
        if ((oldP.price ?? null) !== (newP.price ?? null) || (oldP.mrp ?? null) !== (newP.mrp ?? null)) priceChanges++
      }
      const addedProducts = Math.max(0, productInputs.length - prevProducts.length)
      const isUpdate = prevProducts.length > 0

      // One task per campaign — find before creating.
      const { data: existingTask } = await admin
        .from('tasks')
        .select('id, task_number')
        .ilike('description', `%${marker}%`)
        .is('deleted_at', null)
        .maybeSingle()
      let taskId = (existingTask as { id?: string } | null)?.id || null
      taskNumber = (existingTask as { task_number?: number } | null)?.task_number ?? null

      if (taskId) {
        // Same offer re-saved — keep the task, refresh the title.
        await admin.from('tasks').update({ title: offerTitle }).eq('id', taskId)
      } else {
        const { data: maxRow } = await admin
          .from('tasks')
          .select('task_number')
          .order('task_number', { ascending: false, nullsFirst: false })
          .limit(1)
          .maybeSingle()
        taskNumber = (((maxRow as { task_number?: number } | null)?.task_number) ?? 0) + 1
        const { data: taskRow } = await admin
          .from('tasks')
          .insert({
            task_number: taskNumber,
            title: offerTitle,
            description:
              `Offer flyer saved from Figma (Cirqle Studio)${byName ? ' by ' + byName : ''} — ` +
              `${productInputs.length} products. ${marker}`,
            client_id: client.id,
            status: 'pending',
            task_date: today,
            quantity: 1,
          })
          .select('id')
          .single()
        taskId = (taskRow as { id?: string } | null)?.id || null
      }

      if (taskId && employeeId) {
        // Everyone who saved this offer is on the task (idempotent add).
        const { data: existingAssign } = await admin
          .from('task_assignments')
          .select('task_id')
          .eq('task_id', taskId)
          .eq('employee_id', employeeId)
          .maybeSingle()
        if (!existingAssign) {
          await admin.from('task_assignments').insert({ task_id: taskId, employee_id: employeeId })
        }

        // Auto contribution counts. Parameters are matched by name so this
        // adapts to the workspace's own contribution setup; anything not
        // found is simply skipped.
        const { data: paramRows } = await admin.from('parameters').select('id, name, input_type')
        const params = (paramRows as { id: string; name: string | null; input_type: string | null }[] | null) || []
        const flat = (s: string | null) => String(s || '').toLowerCase().replace(/[^a-z]/g, '')
        const findParam = (test: (n: string) => boolean) =>
          params.find(p => (p.input_type || 'count') === 'count' && test(flat(p.name)))?.id || null
        const productsParam = findParam(n => n === 'products' || n === 'productcount' || n === 'product')
        const priceParam = findParam(n => n.includes('price') && n.includes('updat'))
        const nameParam = findParam(n => n.includes('name') && n.includes('updat'))

        const bump = async (parameterId: string | null, delta: number, setTo?: number) => {
          if (!parameterId || (delta <= 0 && setTo == null)) return
          const { data: row } = await admin
            .from('contributions')
            .select('value')
            .eq('task_id', taskId)
            .eq('employee_id', employeeId)
            .eq('parameter_id', parameterId)
            .maybeSingle()
          const current = Number((row as { value?: number } | null)?.value ?? NaN)
          if (Number.isFinite(current)) {
            const next = setTo != null ? setTo : current + delta
            await admin.from('contributions').update({ value: next })
              .eq('task_id', taskId).eq('employee_id', employeeId).eq('parameter_id', parameterId)
          } else {
            await admin.from('contributions').insert({
              task_id: taskId, employee_id: employeeId, parameter_id: parameterId,
              value: setTo != null ? setTo : delta,
            })
          }
        }

        if (!isUpdate) {
          // First save: the whole product list is this employee's work.
          await bump(productsParam, productInputs.length)
        } else {
          await bump(productsParam, addedProducts)
          await bump(priceParam, priceChanges)
          await bump(nameParam, nameChanges)
        }
      }
    } catch {
      taskNumber = null
    }

    return NextResponse.json(
      {
        ok: true,
        campaignId: result.data.campaignId,
        productCount: productInputs.length,
        clientName: client.name,
        taskNumber,
        // saveCampaign fires the Google Sheet sync in the background, so a
        // client still on the sheet pipeline stays in step automatically.
        message: `Saved ${productInputs.length} products to ${client.name} in Cirqle.`,
      },
      { headers: CORS_HEADERS },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown server error'
    return NextResponse.json({ ok: false, error: message }, { status: 500, headers: CORS_HEADERS })
  }
}

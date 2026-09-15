import { NextRequest, NextResponse } from 'next/server'
import { FIGMA_CORS_HEADERS as CORS_HEADERS, figmaOptions, verifyFigmaAuth, logFigmaEvent } from '../_lib/auth'
import { saveCampaign, type ProductInput } from '@/app/intake/offer/[token]/actions'
import { todayISO } from '@/lib/utils/local-date'
import { autoLinkTaskPackage } from '@/lib/packages/auto-link'
import { resolveFlyerService } from '../_lib/flyer-department'
import { bumpContribution, diffProducts, parametersForService, resolveFlyerParameters } from '../_lib/contributions'

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
 * Auth + CORS + plugin-version gate: see ../_lib/auth.ts.
 * The client is addressed by `clientId`; its intake token is resolved
 * server-side and never travels to the plugin.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export const OPTIONS = figmaOptions

interface IncomingProduct {
  /** Existing offer_products.id — sent on updates so saveCampaign diffs
   * fields instead of logging remove+add for every row. Absent = new row. */
  id?: string | null
  name?: string
  price?: number | null
  mrp?: number | null
  weight?: string | null
  badge?: string | null
  /** Full badge label list, for products that carry more than one badge —
   * `badge` (single) stays supported for old plugins and fresh pastes. */
  badges?: (string | null)[] | null
  offerType?: string | null
  page?: number | null
  /** Carried through on updates so a plugin round-trip never wipes the
   * product photo the client/app attached. Also how Figma-side uploads
   * attach a cleaned shot. */
  imageUrl?: string | null
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
  /** Service for that task, chosen in the plugin. Falls back to the
   * workspace's "Offer Flyer" service when absent. */
  serviceId?: string | null
  /**
   * Optimistic concurrency: the campaign `updated_at` the plugin loaded.
   * On update, a campaign that moved past this returns 409 {conflict:true}
   * instead of silently replacing someone else's edits; `force:true`
   * overwrites after the designer explicitly chose to.
   */
  baseUpdatedAt?: string
  force?: boolean
  /** Set by the plugin when this request is a RETRY of a save that never
   * reached the server (offline recovery) — logged as a save_failed event
   * for the health panel, since the original attempt left no server trace. */
  priorFailure?: { at?: number; error?: string }
}

const MAX_PRODUCTS = 300

export async function POST(req: NextRequest) {
  const startedAt = Date.now()
  try {
    const auth = await verifyFigmaAuth(req)
    if (!auth.ok) return auth.response
    const admin = auth.admin

    const body = (await req.json().catch(() => null)) as IncomingBody | null

    // The original attempt never reached the server, so its failure can only
    // be recorded now, from the retry.
    if (body?.priorFailure) {
      void logFigmaEvent(admin, 'save_failed', {
        campaignId: body?.campaignId || null,
        plugin: auth.plugin,
        detail: body.priorFailure.error || 'transport failure (reported on retry)',
      })
    }
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

    // ── Optimistic concurrency (updates only) ─────────────────────────────
    // The plugin sends the `updated_at` it loaded; if the campaign moved on
    // since (client edited from their phone, another designer saved), refuse
    // with 409 so the plugin can offer Reload / Overwrite instead of silently
    // replacing those edits. `force:true` is the explicit overwrite.
    if (body?.campaignId && body?.baseUpdatedAt && body?.force !== true) {
      const { data: currentRow } = await admin
        .from('offer_campaigns')
        .select('updated_at')
        .eq('id', body.campaignId)
        .maybeSingle()
      const currentUpdatedAt = (currentRow as { updated_at?: string } | null)?.updated_at || null
      if (currentUpdatedAt && new Date(currentUpdatedAt).getTime() > new Date(body.baseUpdatedAt).getTime()) {
        void logFigmaEvent(admin, 'save_conflict', { campaignId: body.campaignId, plugin: auth.plugin })
        return NextResponse.json(
          {
            ok: false,
            conflict: true,
            currentUpdatedAt,
            error: 'This offer changed since you loaded it.',
          },
          { status: 409, headers: CORS_HEADERS },
        )
      }
    }

    const isOfferType = (v: unknown): v is ProductInput['offer_type'] =>
      v === 'price' || v === 'percent' || v === 'bogo' || v === 'other'

    // Labels that match a predefined badge re-link to it (id + its colour)
    // instead of becoming a custom amber copy — otherwise every plugin
    // round-trip would silently strip the badge's colour and identity.
    const { data: badgeRows } = await admin
      .from('offer_badges')
      .select('id, label, color')
      .eq('is_active', true)
    const predefinedByLabel = new Map(
      ((badgeRows as { id: string; label: string | null; color: string | null }[] | null) || [])
        .filter(b => b.label)
        .map(b => [String(b.label).trim().toLowerCase(), b]),
    )

    const productInputs: ProductInput[] = products.map((p, index) => {
      const offerType = isOfferType(p.offerType) ? p.offerType : 'price'
      const imageUrl = (p.imageUrl || '').trim()
      // Free-text badges: the plugin sends labels, not ids, because the
      // client's message says "B1G1", not a badge uuid. saveCampaign accepts
      // custom_label for exactly this case. `badges` (plural) preserves
      // multi-badge products on updates; `badge` covers fresh pastes.
      const badgeLabels = (Array.isArray(p.badges) && p.badges.length ? p.badges : [p.badge])
        .map(b => (b || '').trim())
        .filter(Boolean)
      return {
        id: p.id || undefined,
        name: (p.name || '').trim() || `Product ${index + 1}`,
        weight: (p.weight || '').trim() || undefined,
        image_url: imageUrl || undefined,
        offer_type: offerType,
        price: typeof p.price === 'number' ? p.price : null,
        mrp: typeof p.mrp === 'number' ? p.mrp : null,
        badges: badgeLabels.map(label => {
          const predefined = predefinedByLabel.get(label.toLowerCase())
          return predefined
            ? { badge_id: predefined.id, color: predefined.color || 'amber' }
            : { custom_label: label, color: 'amber' }
        }),
        page: typeof p.page === 'number' && p.page > 0 ? p.page : 1,
        display_order: index,
      }
    })

    const today = todayISO()
    const dateType = body?.dateType === 'range' ? 'range' : 'single'

    // Snapshot what this save is about to replace — the client's active
    // campaign — so per-field edit counts (price/name changes) can be
    // attributed to the employee who made them (see the contribution
    // section after the save).
    type PrevProduct = {
      name: string | null; price: number | null; mrp: number | null; display_order: number | null
      // Carried so a save can count the edits the team currently types by
      // hand: Photo Updating, Limit Updating, Add Special Tags, Layout Change.
      weight: string | null; page: number | null; image_url: string | null
      // `offer_products` has no `badges` column — a single `badge_id` plus the
      // `offer_product_badges` join table. `badgeCount` flattens both into the
      // only thing the diff asks: did this row carry a tag?
      id?: string; badge_id?: string | null; badgeCount?: number
    }
    type PrevCampaign = { offer_date: string | null; offer_date_from: string | null; offer_date_to: string | null }
    let prevProducts: PrevProduct[] = []
    let prevCampaign: PrevCampaign | null = null
    try {
      const { data: activeCampaign } = await admin
        .from('offer_campaigns')
        .select('id, offer_date, offer_date_from, offer_date_to')
        .eq('client_id', clientId)
        .eq('status', 'active')
        .maybeSingle()
      const activeRow = activeCampaign as ({ id?: string } & PrevCampaign) | null
      const activeId = activeRow?.id
      if (activeId) {
        prevCampaign = {
          offer_date: activeRow?.offer_date ?? null,
          offer_date_from: activeRow?.offer_date_from ?? null,
          offer_date_to: activeRow?.offer_date_to ?? null,
        }
        const { data: prevRows } = await admin
          .from('offer_products')
          .select('id, name, price, mrp, display_order, weight, badge_id, page, image_url')
          .eq('campaign_id', activeId)
          .order('display_order')
        prevProducts = (prevRows as PrevProduct[] | null) || []

        // Multi-badge rows live in a join table; one query for the lot.
        const productIds = prevProducts.map(r => r.id).filter((id): id is string => !!id)
        if (productIds.length) {
          const { data: badgeRows } = await admin
            .from('offer_product_badges')
            .select('product_id')
            .in('product_id', productIds)
          const counts = new Map<string, number>()
          for (const b of ((badgeRows as { product_id: string | null }[] | null) || [])) {
            if (b.product_id) counts.set(b.product_id, (counts.get(b.product_id) || 0) + 1)
          }
          for (const r of prevProducts) r.badgeCount = (r.id && counts.get(r.id)) || 0
        }
      }
    } catch {
      prevProducts = []
      prevCampaign = null
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
      // Figma saves stay allowed while the campaign is design-locked —
      // designer touch-ups must not require an admin unlock.
      { actor: 'figma' },
    )

    if (!result.ok || !result.data) {
      return NextResponse.json(
        { ok: false, error: result.error || 'Could not save the offer.' },
        { status: 500, headers: CORS_HEADERS },
      )
    }

    void logFigmaEvent(admin, 'save_ok', {
      campaignId: result.data.campaignId,
      plugin: auth.plugin,
      durationMs: Date.now() - startedAt,
    })

    // Plugin metadata — debugging/support only, never fails the save. Which
    // plugin build saved what turns "the flyer looks wrong" support calls
    // into a version lookup. log_type 'system' is the schema's existing
    // catch-all (adding a new enum value would need a migration for a log line).
    try {
      const plugin = auth.plugin
      const byCqid = (body?.createdBy?.cqid || '').trim()
      await admin.from('offer_change_logs').insert({
        campaign_id: result.data.campaignId,
        log_type: 'system',
        // History, not an actionable change — pre-acknowledged (see
        // logCampaignEvent). Written directly (not via the flagged timeline
        // helper) because the version info is support forensics that should
        // survive the timeline flag being off.
        acknowledged: true,
        note:
          `${body?.campaignId ? 'Updated' : 'Created'} from Cirqle Studio` +
          (plugin ? ` ${plugin.version}${plugin.build ? '+' + plugin.build : ''}${plugin.platform ? ' (' + plugin.platform + ')' : ''}` : '') +
          (byCqid ? ` by ${byCqid}` : '') +
          (body?.force ? ' — overwrote a newer version after conflict review' : ''),
      })
    } catch { /* observability, not availability */ }

    // Every offer saved from Figma or Offer Studio also lands on the Tasks
    // page — ONE task per campaign (re-saves reuse it via the [figma:cmp:…]
    // marker), titled with the offer title, assigned to everyone who worked
    // on it, and with contribution counts filled in automatically.
    //
    // WHAT IS COUNTED, and why this list grew:
    // The team was already recording every one of these by hand in the
    // contribution panel — 102 "Photo Updating" rows, 48 "Limit Updating",
    // 19 "Add Special Tags", 19 "Sheet Updating", 8 "Layout Change" — while a
    // save that knew all of it wrote only three. Each count below is a
    // difference this save can see for itself:
    //   · Products               → products added (the whole list on a first save)
    //   · Price Updating         → rows whose price or MRP changed
    //   · Product Name Updating  → rows whose name changed
    //   · Photo Updating         → rows whose photo changed or arrived
    //   · Limit Updating         → rows whose weight/limit changed
    //   · Add Special Tags       → rows that gained a badge
    //   · Layout Change          → rows that moved to a different page
    //   · Sheet Updating         → 1 per save that changed anything at all
    //   · Date Change            → 1 when the offer's dates moved
    //
    // Parameters are resolved through the TASK'S SERVICE (see
    // _lib/contributions.ts): only the Flyer Design / Flyer Products groups
    // are candidates, so a name that matches nothing scores nothing instead
    // of landing in a paid-advertising parameter that happened to match.
    //
    // The contribution panel stays the manual override — anything written
    // here can be corrected by hand. Best-effort by design: none of this may
    // ever fail the offer save. What it may NOT do any more is fail in
    // silence, so the reason comes back in the response.
    let taskNumber: number | null = null
    let taskId: string | null = null
    let taskWarning: string | null = null
    let scoring: { written: Record<string, number>; missing: string[]; scoped: boolean } | null = null
    try {
      const campaignId = result.data.campaignId
      const offerTitle = body?.title?.trim() || 'Offer ' + today
      const marker = `[figma:cmp:${campaignId}]`
      const employeeId = body?.createdBy?.id || null
      // CQID, not a name — the task is already assigned to the employee row,
      // so the description only needs a staff identifier.
      const byName = (body?.createdBy?.cqid || '').trim()

      // What this save changed, row by row. See diffProducts — position is
      // the identity a pasted list has, and Offer Studio's read-back is what
      // upgrades the next save to real product ids.
      const norm = (v: string | null | undefined) => String(v ?? '').trim()
      const delta = diffProducts(
        prevProducts.map(r => ({
          name: r.name, price: r.price, mrp: r.mrp, weight: r.weight, page: r.page,
          image_url: r.image_url,
          hasBadge: !!r.badge_id || (r.badgeCount ?? 0) > 0,
        })),
        productInputs.map(p => ({
          name: p.name, price: p.price, mrp: p.mrp, weight: p.weight ?? null, page: p.page,
          image_url: p.image_url ?? null,
          badgeCount: p.badges?.length ?? 0,
        })),
      )
      const addedProducts = delta.added
      const isUpdate = prevProducts.length > 0

      // Did the offer's dates move? Only meaningful on an update — the first
      // save is not a "Date Change", it is the date being set.
      const dateChanged = isUpdate && !!prevCampaign && (
        dateType === 'single'
          ? norm(prevCampaign.offer_date) !== norm(body?.offerDate || today)
          : norm(prevCampaign.offer_date_from) !== norm(body?.offerDateFrom) ||
            norm(prevCampaign.offer_date_to) !== norm(body?.offerDateTo)
      )

      // Which service this flyer is. The caller's choice wins when it really
      // belongs to the offer-flyer department; anything else falls back to
      // "Offer Flyer" rather than filing a supermarket flyer as "Video
      // Editing". Without this the task lands with an empty Service.
      const { serviceId, substituted } = await resolveFlyerService(admin, body?.serviceId)
      if (substituted) {
        taskWarning = 'The service sent with this offer is not an offer-flyer service; filed as the default instead.'
      }

      // One task per campaign — find before creating. `limit(1)` rather than
      // maybeSingle(): a workspace that somehow has two tasks carrying the
      // same marker should reuse the older one, not throw and lose the task
      // and every contribution with it.
      const { data: existingTasks } = await admin
        .from('tasks')
        .select('id, task_number')
        .ilike('description', `%${marker}%`)
        .is('deleted_at', null)
        .order('task_number', { ascending: true, nullsFirst: false })
        .limit(1)
      const existingTask = ((existingTasks as { id: string; task_number: number | null }[] | null) || [])[0] || null
      taskId = existingTask?.id || null
      taskNumber = existingTask?.task_number ?? null

      if (taskId) {
        // Same offer re-saved — keep the task, refresh the title, and follow
        // a service the designer changed (an offer that turned into "Offer
        // Flyer Updating" should say so). Never clears a service someone set
        // by hand in Cirqle.
        const patch: Record<string, unknown> = { title: offerTitle }
        if (serviceId) patch.service_id = serviceId
        await admin.from('tasks').update(patch).eq('id', taskId)
      } else {
        // task_number is `max + 1` under a unique index, so two saves landing
        // together race. Retry on the collision rather than losing the task:
        // the loser simply takes the next number.
        const description =
          `Offer flyer saved from Figma (Cirqle Studio)${byName ? ' by ' + byName : ''} — ` +
          `${productInputs.length} products. ${marker}`
        for (let attempt = 0; attempt < 5 && !taskId; attempt++) {
          const { data: maxRow } = await admin
            .from('tasks')
            .select('task_number')
            .order('task_number', { ascending: false, nullsFirst: false })
            .limit(1)
            .maybeSingle()
          const candidate = (((maxRow as { task_number?: number } | null)?.task_number) ?? 0) + 1 + attempt
          const { data: taskRow, error: insertError } = await admin
            .from('tasks')
            .insert({
              task_number: candidate,
              title: offerTitle,
              description,
              client_id: client.id,
              service_id: serviceId,
              status: 'pending',
              task_date: today,
              quantity: 1,
            })
            .select('id')
            .single()
          if (!insertError) {
            taskId = (taskRow as { id?: string } | null)?.id || null
            taskNumber = candidate
            break
          }
          // 23505 = unique violation: somebody else took this number.
          if ((insertError as { code?: string }).code !== '23505') throw insertError
        }
        if (taskId) await autoLinkTaskPackage(admin, taskId)
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

        const parameterSet = await parametersForService(admin, serviceId)
        const p = resolveFlyerParameters(parameterSet)
        const written: Record<string, number> = {}
        const add = async (label: string, parameterId: string | null, delta: number) => {
          if (!parameterId || delta <= 0) return
          await bumpContribution(admin, { taskId: taskId as string, employeeId, parameterId, delta })
          written[label] = (written[label] || 0) + delta
        }

        if (!isUpdate) {
          // First save: the whole product list is this employee's work, and
          // nothing was "changed" — it did not exist a moment ago.
          await add('Products', p.products, productInputs.length)
        } else {
          await add('Products', p.products, addedProducts)
          await add('Price Updating', p.price, delta.price)
          await add('Product Name Updating', p.productName, delta.name)
          await add('Photo Updating', p.photo, delta.photo)
          await add('Limit Updating', p.limit, delta.limit)
          await add('Add Special Tags', p.specialTags, delta.specialTags)
          await add('Layout Change', p.layout, delta.layout)
          await add('Date Change', p.date, dateChanged ? 1 : 0)
          // One per save that actually moved something — the act of working
          // the sheet, which is what the team records by hand today.
          await add('Sheet Updating', p.sheet, delta.touched ? 1 : 0)
        }

        scoring = { written, missing: p.missing, scoped: p.scoped }
        if (!p.scoped) {
          taskWarning = (taskWarning ? taskWarning + ' ' : '') +
            'Contribution parameters could not be narrowed to this service\'s groups ' +
            '(link the Flyer groups to it in Settings → Services), so counts were matched workspace-wide.'
        }
      }
    } catch (err) {
      // The offer IS saved. Say what did not happen rather than letting the
      // designer believe a task and their contribution counts exist.
      taskNumber = null
      taskWarning = 'The offer was saved, but its task or contribution counts could not be written: ' +
        (err instanceof Error ? err.message : String(err))
      void logFigmaEvent(admin, 'save_failed', {
        campaignId: result.data.campaignId,
        plugin: auth.plugin,
        detail: 'task/contributions: ' + (err instanceof Error ? err.message : String(err)),
      })
    }

    // Fresh updated_at so the plugin can rebase its conflict check without a
    // second round-trip.
    let updatedAt: string | null = null
    try {
      const { data: savedRow } = await admin
        .from('offer_campaigns')
        .select('updated_at')
        .eq('id', result.data.campaignId)
        .maybeSingle()
      updatedAt = (savedRow as { updated_at?: string } | null)?.updated_at || null
    } catch { /* non-essential */ }

    return NextResponse.json(
      {
        ok: true,
        campaignId: result.data.campaignId,
        updatedAt,
        productCount: productInputs.length,
        clientName: client.name,
        taskId,
        taskNumber,
        // Everything that did not go to plan while filing the task, and what
        // the save actually scored. A client that shows these is a client
        // whose user can fix the cause.
        taskWarning,
        scoring,
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

import { NextRequest, NextResponse } from 'next/server'
import { FIGMA_CORS_HEADERS as CORS_HEADERS, figmaOptions, verifyFigmaAuth } from '../_lib/auth'
import { bumpContribution, findParameter, parametersForService } from '../_lib/contributions'

/**
 * POST /api/figma/build-report — the plugin reports a finished flyer build.
 *
 * The offer save (../campaign) already created ONE task per campaign with a
 * `[figma:cmp:<id>]` marker and auto-filled the product/edit contribution
 * counts. This route completes the picture with what only the BUILD knows:
 * how many pages and how many creatives (cards) were actually produced, per
 * employee. Values are SET, not incremented — designers rebuild the same
 * flyer many times, and ten rebuilds of a 2-page flyer are still 2 pages.
 *
 * PARAMETERS ARE SCOPED TO THE TASK'S SERVICE, and that is a fix, not a
 * refinement. This route used to search all 64 parameters in the workspace
 * for one whose name contains "creative" — and the first hit is **Ad Creative
 * Setup**, which belongs to the Ad Campaign Management Group. Every build
 * report would have written a flyer's card count into a paid-advertising
 * metric. Narrowing the candidates to the groups linked to the task's own
 * service (see ../_lib/contributions) makes that impossible: within the Flyer
 * groups nothing matches "creative", so nothing is written.
 *
 * Which is the second half of the fix: a count with nowhere correct to go is
 * now REPORTED rather than dropped. `skipped` names each one and says what to
 * create, so a workspace that wants page counts scored can add the parameter
 * and have it start working with no deployment.
 *
 * WHERE THE NUMBERS COME FROM: both are counted in the Figma file, never
 * derived from the product list. A CREATIVE is one artboard the build
 * produced or filled; a PAGE is a creative laid out with more than one
 * product — a printed side. See artboardOf/countArtboards in each plugin's
 * code.ts. The plugin used to send `Math.ceil(products / perPage)` and, in
 * card mode, the page number typed into the SHEET; a designer who drew an
 * extra artboard or stopped after one page was scored for neither.
 */

export const dynamic = 'force-dynamic'

export const OPTIONS = figmaOptions

export async function POST(req: NextRequest) {
  try {
    const auth = await verifyFigmaAuth(req)
    if (!auth.ok) return auth.response
    const admin = auth.admin

    const body = (await req.json().catch(() => null)) as {
      campaignId?: string
      createdBy?: { id?: string | null; cqid?: string | null }
      pages?: number
      /** Artboards produced. `cards` is the older plugins' name for it. */
      creatives?: number
      cards?: number
    } | null
    const campaignId = (body?.campaignId || '').trim()
    const employeeId = body?.createdBy?.id || null
    const pages = Math.max(0, Math.round(Number(body?.pages) || 0))
    // `creatives` is the counted number of artboards; `cards` is what plugins
    // before this change sent (product cards). Same slot, newer name wins.
    const cards = Math.max(0, Math.round(Number(body?.creatives ?? body?.cards) || 0))
    if (!campaignId || !employeeId || (!pages && !cards)) {
      // Nothing attributable — fine, the build itself already succeeded.
      return NextResponse.json({ ok: true, recorded: false }, { headers: CORS_HEADERS })
    }

    // `limit(1)`, not maybeSingle(): two tasks carrying the same marker is a
    // data problem, not a reason to throw away a build report.
    const { data: taskRows } = await admin
      .from('tasks')
      .select('id, task_number, service_id')
      .ilike('description', `%[figma:cmp:${campaignId}]%`)
      .is('deleted_at', null)
      .order('task_number', { ascending: true, nullsFirst: false })
      .limit(1)
    const taskRow = ((taskRows as { id: string; task_number: number | null; service_id: string | null }[] | null) || [])[0]
    const taskId = taskRow?.id
    if (!taskId) {
      return NextResponse.json(
        {
          ok: true,
          recorded: false,
          reason: 'No task for this campaign yet — save the offer before reporting a build.',
        },
        { headers: CORS_HEADERS },
      )
    }

    const parameterSet = await parametersForService(admin, taskRow?.service_id ?? null)
    const pagesParam = findParameter(parameterSet, n =>
      n === 'pages' || n === 'page' || n === 'pagesdone' || n === 'flyerpages' || n === 'pagecount')
    const creativeParam = findParameter(parameterSet, n =>
      n.includes('creative') || n === 'designs' || n === 'cards' || n === 'flyercards')

    const written: Record<string, number> = {}
    const skipped: string[] = []

    if (pages > 0) {
      if (pagesParam) {
        await bumpContribution(admin, { taskId, employeeId, parameterId: pagesParam, setTo: pages })
        written.pages = pages
      } else {
        skipped.push(
          `${pages} page${pages === 1 ? '' : 's'} not scored: this service's contribution groups have no ` +
          `"Pages" parameter. Add one (e.g. "Flyer Pages") to the Flyer Design Group to record it.`,
        )
      }
    }
    if (cards > 0) {
      if (creativeParam) {
        await bumpContribution(admin, { taskId, employeeId, parameterId: creativeParam, setTo: cards })
        written.creatives = cards
      } else {
        skipped.push(
          `${cards} creative${cards === 1 ? '' : 's'} not scored: this service's contribution groups have no ` +
          `"Creatives" parameter. Add one (e.g. "Flyer Creatives") to the Flyer Design Group to record it.`,
        )
      }
    }
    if (!parameterSet.scoped) {
      skipped.push(
        'Parameters could not be narrowed to this task\'s service, so workspace-wide names were used. ' +
        'Link the Flyer contribution groups to the service in Settings → Services.',
      )
    }

    return NextResponse.json(
      {
        ok: true,
        recorded: Object.keys(written).length > 0,
        taskNumber: taskRow?.task_number ?? null,
        written,
        skipped,
      },
      { headers: CORS_HEADERS },
    )
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Report failed.' },
      { status: 500, headers: CORS_HEADERS },
    )
  }
}

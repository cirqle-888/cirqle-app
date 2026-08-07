import { NextRequest, NextResponse } from 'next/server'
import { FIGMA_CORS_HEADERS as CORS_HEADERS, figmaOptions, verifyFigmaAuth } from '../../../_lib/auth'
import { logCampaignEvent } from '@/lib/offer-events'

/**
 * POST /api/figma/campaign/[id]/designed — the EXPLICIT design-completion
 * action ("Mark as Designed" in Cirqle Studio).
 *
 * This — and only this — sets the design lock. Ordinary plugin saves and
 * build reports never lock, so designers save as often as they like without
 * ever needing an admin to unlock mid-work.
 *
 * body {createdBy:{id,cqid}}            → lock (design_locked_at/by = now/me)
 * body {createdBy, undo:true}           → self-service unlock, allowed only
 *   for the same employee within UNDO_WINDOW_MS of locking (a mis-click fix,
 *   not a workflow). Past the window → {adminRequired:true}; the dashboard's
 *   admin Unlock is the way from there.
 */

export const dynamic = 'force-dynamic'

export const OPTIONS = figmaOptions

const UNDO_WINDOW_MS = 15 * 60 * 1000

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await verifyFigmaAuth(req)
    if (!auth.ok) return auth.response
    const admin = auth.admin

    const { id } = await params
    const body = (await req.json().catch(() => null)) as {
      createdBy?: { id?: string | null; cqid?: string | null }
      undo?: boolean
    } | null
    const employeeId = body?.createdBy?.id || null
    const cqid = (body?.createdBy?.cqid || '').trim()

    const { data: row } = await admin
      .from('offer_campaigns')
      .select('id, status, design_locked_at, design_locked_by')
      .eq('id', id)
      .maybeSingle()
    const campaign = row as {
      id: string
      status: string
      design_locked_at: string | null
      design_locked_by: string | null
    } | null
    if (!campaign) {
      return NextResponse.json({ ok: false, error: 'Offer not found. Press Refresh in the plugin.' }, { status: 404, headers: CORS_HEADERS })
    }

    if (body?.undo) {
      if (!campaign.design_locked_at) {
        return NextResponse.json({ ok: true, locked: false, message: 'Already unlocked.' }, { headers: CORS_HEADERS })
      }
      const withinWindow = Date.now() - new Date(campaign.design_locked_at).getTime() <= UNDO_WINDOW_MS
      const sameDesigner = !!employeeId && campaign.design_locked_by === employeeId
      if (!withinWindow || !sameDesigner) {
        return NextResponse.json(
          {
            ok: false,
            adminRequired: true,
            error: sameDesigner
              ? 'The undo window has passed — ask an admin to unlock this offer in Cirqle.'
              : 'Someone else marked this as designed — ask an admin to unlock it in Cirqle.',
          },
          { status: 403, headers: CORS_HEADERS },
        )
      }
      await admin.from('offer_campaigns')
        .update({ design_locked_at: null, design_locked_by: null })
        .eq('id', id)
      void logCampaignEvent(admin, id, `"Mark as Designed" undone${cqid ? ` by ${cqid}` : ''} (within the self-undo window).`)
      return NextResponse.json({ ok: true, locked: false, message: 'Unlocked — the offer is editable again.' }, { headers: CORS_HEADERS })
    }

    if (campaign.design_locked_at) {
      return NextResponse.json(
        { ok: true, locked: true, lockedAt: campaign.design_locked_at, message: 'Already marked as designed.' },
        { headers: CORS_HEADERS },
      )
    }

    const lockedAt = new Date().toISOString()
    const { error } = await admin.from('offer_campaigns')
      .update({ design_locked_at: lockedAt, design_locked_by: employeeId })
      .eq('id', id)
    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500, headers: CORS_HEADERS })
    }
    void logCampaignEvent(admin, id, `Marked as designed${cqid ? ` by ${cqid}` : ''} — client and staff edits are now locked.`)

    return NextResponse.json(
      {
        ok: true,
        locked: true,
        lockedAt,
        undoWindowMs: UNDO_WINDOW_MS,
        message: 'Marked as designed. The offer is locked for client/staff edits.',
      },
      { headers: CORS_HEADERS },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown server error'
    return NextResponse.json({ ok: false, error: message }, { status: 500, headers: CORS_HEADERS })
  }
}

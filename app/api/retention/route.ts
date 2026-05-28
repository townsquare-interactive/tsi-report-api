// TSI Retention Brief API — POST /api/retention
//
// Triggered by the Admin Portal when an agent submits a cancellation.
// The Admin Portal fires a Freshdesk-shaped webhook — the ticket already
// exists in Freshdesk by the time this runs.
//
// Expected webhook payload (Freshdesk ticket object):
//   {
//     "id": 1132061,                          ← Freshdesk ticket ID (Agent 5 writes back here)
//     "type": "Cancellation Request",
//     "custom_fields": {
//       "cf_gf_gpid": "TI HDHAUL001",         ← GPID (required)
//       "cf_created_by": "agent@tsi.com",     ← submitting agent (optional)
//       "cf_market": "Out of Market"           ← market (optional)
//     },
//     "description_text": "...",              ← agent's cancellation notes (optional)
//     "days": 90                              ← override period (optional, default 90)
//   }
//
// Also supports GET ?gpid=... for Postman testing (no Freshdesk write).
//
// Pipeline:
//   Agent 1: Fetcher     (no model)  — resolves GPID → raw data
//   [Freshdesk conversation fetch]   — pulls first 5 conversation entries from cancel ticket
//   Agent 2: Analyst     (Sonnet)    — reasons about retention case
//   Agent 4: Gap Auditor (Sonnet)    — scores platform gaps  [parallel with Agent 2]
//   Agent 3: Formatter   (Sonnet)    — structures CSR brief (Section 1 quality matters)
//   Agent 5: Note Writer (Haiku)     — formats + posts internal note to Freshdesk ticket
//   MongoDB write                    — persists full event
//
// Auth: x-api-key header (admin key only — verifyAdminKey from lib/auth.ts)

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminKey } from '@/lib/auth';

export const maxDuration = 300; // 5 minutes — pipeline runs 3 Sonnet calls in ~2-3 min
import { fetchClientData } from '@/lib/retention/fetcher';
import { runAnalyst } from '@/lib/retention/analyst';
import { runFormatter } from '@/lib/retention/formatter';
import { runGapAuditor } from '@/lib/retention/gap-auditor';
import { writeRetentionNote } from '@/lib/retention/note-writer';
import { writeRetentionEvent, getRecentRetentionEvent, noteAlreadyPostedForTicket, type RetentionEventDoc } from '@/lib/retention/store';
import { getTicketConversations } from '@/lib/platforms/freshdesk';

const DEFAULT_DAYS = 90;

export async function POST(request: NextRequest) {
  return handleRetention(request);
}

export async function GET(request: NextRequest) {
  return handleRetention(request);
}

async function handleRetention(request: NextRequest) {
  const authError = verifyAdminKey(request);
  if (authError) return authError;

  // ── Parse payload ──────────────────────────────────────────────────────────
  let gpid: string | null = null;
  let days = DEFAULT_DAYS;
  let freshdeskTicketId: number | null = null;
  let agentNotes = '';
  let cancelType: string | null = null;
  let forceRefresh = false;

  if (request.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    // Support both Freshdesk webhook shape and simple { gpid, days }
    const customFields = body.custom_fields as Record<string, unknown> | undefined;
    gpid = (customFields?.cf_gf_gpid as string | null)
      ?? (body.gpid as string | null)
      ?? null;

    freshdeskTicketId = (body.id as number | null) ?? null;
    agentNotes = (body.description_text as string | null) ?? '';
    cancelType = (customFields?.cf_cancel_type as string | null)
      ?? (body.cancelType as string | null)
      ?? null;

    // Non-live cancels are excluded from auto-trigger — not enough data to brief against
    if (cancelType === 'non_live') {
      return NextResponse.json(
        { error: 'Non-live cancels are excluded from the retention pipeline. Insufficient platform data.' },
        { status: 422 }
      );
    }

    if (body.days && !isNaN(Number(body.days))) days = Number(body.days);
    if (body.forceRefresh === true) forceRefresh = true;

  } else {
    // GET — Postman / manual testing. No Freshdesk write.
    const { searchParams } = request.nextUrl;
    gpid = searchParams.get('gpid');
    const daysParam = searchParams.get('days');
    if (daysParam) days = parseInt(daysParam, 10);
    if (searchParams.get('forceRefresh') === 'true') forceRefresh = true;
  }

  if (!gpid) {
    return NextResponse.json(
      { error: 'GPID is required. Webhook: custom_fields.cf_gf_gpid. GET: ?gpid=TI+HDHAUL001' },
      { status: 400 }
    );
  }
  if (isNaN(days) || days < 1 || days > 365) {
    return NextResponse.json({ error: 'days must be between 1 and 365' }, { status: 400 });
  }

  const triggeredAt = new Date().toISOString();
  const t0 = Date.now();
  const lap = (label: string) => console.log(`[TIMING] ${label}: +${Date.now() - t0}ms`);

  // ── Dedup gate: return cached brief if one exists within the last 7 days ──
  // Bypassed when forceRefresh=true (ad-hoc agent requests) or for GET/manual testing
  if (request.method === 'POST' && !forceRefresh) {
    try {
      const recent = await getRecentRetentionEvent(gpid, 7);
      if (recent) {
        return NextResponse.json(
          {
            meta: {
              gpid,
              generatedAt: recent.triggeredAt,
              periodDays: recent.periodDays,
              trigger: 'cached',
              cachedEventId: (recent as unknown as { _id?: { toString(): string } })._id?.toString() ?? null,
              freshdeskTicketId,
              freshdeskNoteId: null,
              freshdeskNoteUrl: null,
              pipeline: ['dedup_gate: returned cached result — brief was generated within last 7 days'],
              note: 'A brief for this client was generated within the last 7 days. Pass forceRefresh=true to generate a new one.',
            },
            client: recent.client,
            retention: recent.retentionBrief,
            gapAudit: recent.gapAudit,
          },
          { headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' } }
        );
      }
    } catch {
      // Dedup check failure is non-fatal — proceed with fresh generation
    }
  }

  // ── Agent 1 + Freshdesk conversations — run in parallel ───────────────────
  // fetchClientData (Agent 1) and getTicketConversations both only need data already
  // parsed above (gpid and freshdeskTicketId), so they can run concurrently.
  // Conversations fall back to null silently — never fatal.
  lap('start → fetcher + freshdesk conversations (parallel)');
  const [fetcherResult, conversationsResult] = await Promise.allSettled([
    fetchClientData(gpid, days),
    (freshdeskTicketId && request.method === 'POST')
      ? getTicketConversations(freshdeskTicketId).catch(() => null)
      : Promise.resolve(null),
  ]);

  if (fetcherResult.status === 'rejected') {
    return NextResponse.json(
      { error: `Data fetch failed: ${fetcherResult.reason instanceof Error ? fetcherResult.reason.message : String(fetcherResult.reason)}` },
      { status: 502 }
    );
  }
  const rawData = fetcherResult.value;
  const ticketConversations = conversationsResult.status === 'fulfilled' ? conversationsResult.value : null;
  lap('fetcher + freshdesk conversations done');

  // Build enriched context string for the analyst.
  // Combines the webhook description_text with live conversation entries.
  const enrichedAgentNotes = [
    agentNotes ? `TICKET DESCRIPTION (submitted by agent at ticket creation):\n${agentNotes}` : null,
    ticketConversations ? `TICKET CONVERSATIONS (first 5 entries, oldest first):\n${ticketConversations}` : null,
  ].filter(Boolean).join('\n\n---\n\n') || '';

  // ── Agents 2 + 4: Analyst and Gap Auditor run in parallel ─────────────────
  lap('start → analyst + gap-auditor (parallel)');
  const [analystResult, gapAuditResult] = await Promise.allSettled([
    runAnalyst(rawData, days, enrichedAgentNotes),
    runGapAuditor(rawData, days),
  ]);

  const analystOutput = analystResult.status === 'fulfilled' ? analystResult.value : null;
  const gapAudit = gapAuditResult.status === 'fulfilled' ? gapAuditResult.value : null;

  lap('analyst + gap-auditor done');
  const agentErrors: Record<string, string> = { ...rawData.errors };
  if (analystResult.status === 'rejected') {
    agentErrors.analyst = analystResult.reason instanceof Error
      ? analystResult.reason.message : String(analystResult.reason);
  }
  if (gapAuditResult.status === 'rejected') {
    agentErrors.gapAuditor = gapAuditResult.reason instanceof Error
      ? gapAuditResult.reason.message : String(gapAuditResult.reason);
  }

  // ── Agent 3: Formatter ─────────────────────────────────────────────────────
  lap('start → formatter');
  let retentionBrief = null;
  if (analystOutput) {
    try {
      retentionBrief = await runFormatter(
        analystOutput,
        rawData.client.name,
        gapAudit,
        rawData.client.subscription?.commitmentTerms ?? null,
        rawData.client.subscription?.scheduledCancellation ?? null,
        rawData.client.billingEvents ?? []
      );
    } catch (err) {
      agentErrors.formatter = err instanceof Error ? err.message : String(err);
    }
  }

  lap('formatter done');
  // ── Agent 5: Freshdesk Note Writer ────────────────────────────────────────
  // GATED: only fires when FRESHDESK_WRITE_ENABLED=true is set in Vercel env vars.
  // Do NOT enable until production go-live is confirmed.
  //
  // Idempotency check: before posting, verify no note has already been written for
  // this ticket ID. Prevents duplicate notes when Vercel retries a timed-out invocation
  // that actually completed on the first attempt.
  const freshdeskWriteEnabled = process.env.FRESHDESK_WRITE_ENABLED === 'true';
  let freshdeskNote: { noteId: number; noteUrl: string } | null = null;
  if (freshdeskWriteEnabled && retentionBrief && freshdeskTicketId) {
    try {
      // forceRefresh=true bypasses idempotency — use when re-posting after manually deleting a note
      const alreadyPosted = !forceRefresh && await noteAlreadyPostedForTicket(freshdeskTicketId).catch(() => false);
      if (alreadyPosted) {
        agentErrors.freshdeskNote = `Note already posted for ticket ${freshdeskTicketId} — skipped to prevent duplicate`;
      } else {
        freshdeskNote = await writeRetentionNote(
          freshdeskTicketId,
          retentionBrief,
          gapAudit,
          rawData.client.name,
          agentNotes,
          rawData.client.subscription?.serviceKeys ?? [],
          rawData.client.price ?? null
        );
      }
    } catch (err) {
      agentErrors.freshdeskNote = err instanceof Error ? err.message : String(err);
    }
  }

  lap('note-writer done');
  // ── Persist to MongoDB ─────────────────────────────────────────────────────
  lap('start → mongo write');
  let mongoId: string | null = null;
  try {
    const doc: RetentionEventDoc = {
      gpid,
      triggeredAt,
      periodDays: days,
      cancelType: cancelType ?? null,
      freshdeskTicketId: freshdeskTicketId ?? null,
      freshdeskNoteId: freshdeskNote?.noteId ?? null,
      client: {
        id: rawData.meta.clientId,
        name: rawData.client.name,
        market: rawData.client.tsiMarket ?? null,
        monthlyPrice: rawData.client.price ?? null,
        tenureMonths: analystOutput?.tenureMonths ?? 0,
      },
      rawData: {
        gbp: rawData.gbp,
        gbpReviews: rawData.gbpReviews,
        duda: rawData.duda,
        yext: rawData.yext,
        vcita: rawData.vcita,
        activities: rawData.activities,
      },
      analystOutput,
      retentionBrief,
      gapAudit,
      errors: agentErrors,
      pipelineAtRisk: analystOutput?.pipelineAtRisk ?? 0,
      competitors: retentionBrief?.competitors ?? [],
    };
    mongoId = await writeRetentionEvent(doc);
  } catch (err) {
    agentErrors.storage = err instanceof Error ? err.message : String(err);
  }
  lap('mongo done → returning response');

  return NextResponse.json(
    {
      meta: {
        gpid,
        generatedAt: triggeredAt,
        periodDays: days,
        trigger: freshdeskTicketId ? 'cancellation_request_webhook' : 'manual',
        freshdeskTicketId,
        freshdeskNoteId: freshdeskNote?.noteId ?? null,
        freshdeskNoteUrl: freshdeskNote?.noteUrl ?? null,
        pipeline: [
          'fetcher (no-model)',
          'analyst (sonnet) + gap-auditor (sonnet) [parallel]',
          'formatter (sonnet)',
          freshdeskWriteEnabled && freshdeskTicketId ? 'note-writer (haiku) → freshdesk' : 'note-writer DISABLED (set FRESHDESK_WRITE_ENABLED=true to enable)',
        ],
        storedEventId: mongoId,
      },
      client: rawData.client,
      rawData: {
        gbp: rawData.gbp,
        gbpReviews: rawData.gbpReviews,
        duda: rawData.duda,
        yext: rawData.yext,
        vcita: rawData.vcita,
        activities: rawData.activities,
      },
      retention: retentionBrief,
      gapAudit,
      errors: Object.keys(agentErrors).length > 0 ? agentErrors : undefined,
    },
    { headers: { 'Cache-Control': 'no-s
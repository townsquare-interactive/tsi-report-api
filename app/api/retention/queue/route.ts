// TSI Retention Brief API — POST /api/retention/queue
//
// Async variant of /api/retention. Returns 202 immediately, runs the full pipeline
// in the background using Next.js after(). Solves the 200-240s pipeline duration
// problem for callers with short HTTP timeouts (e.g., the Cowork sandbox).
//
// Use this endpoint for all batch test runs. Use /api/retention directly only
// for interactive Postman testing where you want to see the response inline.
//
// Same payload shape as /api/retention. Same auth, same pipeline, same Freshdesk write gate.

import { after } from 'next/server';
import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminKey } from '@/lib/auth';
import { fetchClientData } from '@/lib/retention/fetcher';
import { runAnalyst } from '@/lib/retention/analyst';
import { runFormatter } from '@/lib/retention/formatter';
import { runGapAuditor } from '@/lib/retention/gap-auditor';
import { writeRetentionNote } from '@/lib/retention/note-writer';
import { writeRetentionEvent, getRecentRetentionEvent, noteAlreadyPostedForTicket, type RetentionEventDoc } from '@/lib/retention/store';
import { getTicketConversations } from '@/lib/platforms/freshdesk';
import { getFreshdeskCredentials } from '@/lib/secrets';

export const maxDuration = 300;

const DEFAULT_DAYS = 90;

export async function POST(request: NextRequest) {
  const authError = verifyAdminKey(request);
  if (authError) return authError;

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const customFields = body.custom_fields as Record<string, unknown> | undefined;
  const gpid = (customFields?.cf_gf_gpid as string | null)
    ?? (body.gpid as string | null)
    ?? null;

  if (!gpid) {
    return NextResponse.json(
      { error: 'GPID is required. Webhook: custom_fields.cf_gf_gpid. Body: gpid.' },
      { status: 400 }
    );
  }

  const freshdeskTicketId = (body.id as number | null) ?? null;
  const agentNotes = (body.description_text as string | null) ?? '';
  const cancelType = (customFields?.cf_cancel_type as string | null)
    ?? (body.cancelType as string | null)
    ?? null;
  const days = (body.days && !isNaN(Number(body.days))) ? Number(body.days) : DEFAULT_DAYS;
  const forceRefresh = body.forceRefresh === true;

  if (cancelType === 'non_live') {
    return NextResponse.json(
      { error: 'Non-live cancels are excluded from the retention pipeline.' },
      { status: 422 }
    );
  }

  // Return 202 immediately — pipeline runs after response is flushed
  after(async () => {
    const triggeredAt = new Date().toISOString();
    const t0 = Date.now();
    const lap = (label: string) => console.log(`[QUEUE:TIMING] ${label}: +${Date.now() - t0}ms`);

    // Dedup gate
    if (!forceRefresh) {
      try {
        const recent = await getRecentRetentionEvent(gpid, 7);
        if (recent) {
          console.log(`[QUEUE] ${gpid}: cached result found, skipping pipeline`);
          return;
        }
      } catch { /* non-fatal */ }
    }

    lap('start → fetcher + freshdesk conversations (parallel)');
    const [fetcherResult, conversationsResult] = await Promise.allSettled([
      fetchClientData(gpid, days),
      (freshdeskTicketId)
        ? getTicketConversations(freshdeskTicketId).catch(() => null)
        : Promise.resolve(null),
    ]);

    if (fetcherResult.status === 'rejected') {
      console.error(`[QUEUE] ${gpid}: fetchClientData failed:`, fetcherResult.reason);
      return;
    }
    const rawData = fetcherResult.value;
    const ticketConversations = conversationsResult.status === 'fulfilled' ? conversationsResult.value : null;
    lap('fetcher + freshdesk conversations done');

    const enrichedAgentNotes = [
      agentNotes ? `TICKET DESCRIPTION (submitted by agent at ticket creation):\n${agentNotes}` : null,
      ticketConversations ? `TICKET CONVERSATIONS (first 5 entries, oldest first):\n${ticketConversations}` : null,
    ].filter(Boolean).join('\n\n---\n\n') || '';

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
      agentErrors.analyst = analystResult.reason instanceof Error ? analystResult.reason.message : String(analystResult.reason);
    }
    if (gapAuditResult.status === 'rejected') {
      agentErrors.gapAuditor = gapAuditResult.reason instanceof Error ? gapAuditResult.reason.message : String(gapAuditResult.reason);
    }

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
    const freshdeskWriteEnabled = process.env.FRESHDESK_WRITE_ENABLED === 'true';

    // Formatter failure fallback note
    if (!retentionBrief && freshdeskWriteEnabled && freshdeskTicketId) {
      const errorSummary = Object.entries(agentErrors).map(([k, v]) => `${k}: ${v}`).join('; ');
      const fallbackNote = `<b>⚠️ RETENTION BRIEF GENERATION FAILED</b><br>The AI pipeline could not generate a brief for this ticket. Manual brief required.<br><i>Errors: ${errorSummary}</i>`;
      try {
        const creds = await getFreshdeskCredentials();
        const auth = Buffer.from(`${creds.apiKey}:X`).toString('base64');
        await fetch(`https://${creds.domain}/api/v2/tickets/${freshdeskTicketId}/notes`, {
          method: 'POST',
          headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: fallbackNote, private: true }),
          signal: AbortSignal.timeout(10000),
        });
      } catch { /* fallback note failure is non-fatal */ }
    }

    let freshdeskNote: { noteId: number; noteUrl: string } | null = null;
    if (freshdeskWriteEnabled && retentionBrief && freshdeskTicketId) {
      try {
        const alreadyPosted = !forceRefresh && await noteAlreadyPostedForTicket(freshdeskTicketId).catch(() => false);
        if (alreadyPosted) {
          console.log(`[QUEUE] ${gpid}: note already posted for ticket ${freshdeskTicketId}, skipped`);
        } else {
          freshdeskNote = await writeRetentionNote(
            freshdeskTicketId,
            retentionBrief,
            gapAudit,
            rawData.client.name,
            agentNotes,
            rawData.client.subscription?.serviceKeys ?? [],
            rawData.client.price ?? null,
            enrichedAgentNotes
          );
        }
      } catch (err) {
        agentErrors.freshdeskNote = err instanceof Error ? err.message : String(err);
        console.error(`[QUEUE] ${gpid}: Freshdesk note write failed:`, err);
      }
    }

    lap('note-writer done');

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
      await writeRetentionEvent(doc);
      lap('mongo done');
    } catch (err) {
      console.error(`[QUEUE] ${gpid}: MongoDB write failed:`, err);
    }

    console.log(`[QUEUE] ${gpid}: pipeline complete. noteId=${freshdeskNote?.noteId ?? null}`);
  });

  return NextResponse.json(
    {
      status: 'queued',
      gpid,
      freshdeskTicketId,
      message: 'Pipeline running asynchronously. Note will be written to Freshdesk within ~4 minutes if FRESHDESK_WRITE_ENABLED=true.',
    },
    { status: 202 }
  );
}

// TSI Gap Audit API — GET /api/gap-audit?gpid=...
//
// Proactive client health scan. Runs the Gap Auditor agent (Haiku) against
// any client and persists the result to gap_snapshots in MongoDB.
//
// Unlike /api/retention (triggered by cancellation), this endpoint is designed
// for scheduled proactive scanning — run it nightly, weekly, or on-demand
// to build a ranked list of at-risk clients before they cancel.
//
// Auth: x-api-key header (same key as /api/report and /api/retention)
//
// Usage:
//   GET  /api/gap-audit?gpid=TI+CASAED001
//   POST /api/gap-audit  { "gpids": ["TI CASAED001", "TI BIGESS001"] }  ← batch (max 10)

import { NextRequest, NextResponse } from 'next/server';
import { verifyKey } from '@/lib/auth';
import { fetchClientData } from '@/lib/retention/fetcher';
import { runGapAuditor } from '@/lib/retention/gap-auditor';
import { writeGapSnapshot, type GapSnapshotDoc } from '@/lib/retention/store';

const DEFAULT_DAYS = 30; // shorter window for gap scans — looking at current state, not history

export async function GET(request: NextRequest) {
  return handleGapAudit(request);
}

export async function POST(request: NextRequest) {
  return handleGapAudit(request);
}

async function handleGapAudit(request: NextRequest) {
  const authError = verifyKey(request);
  if (authError) return authError;

  // Single GPID (GET) or batch (POST)
  if (request.method === 'GET') {
    const gpid = request.nextUrl.searchParams.get('gpid');
    if (!gpid) {
      return NextResponse.json(
        { error: 'gpid is required. GET ?gpid=TI+CASAED001 or POST { "gpids": [...] }' },
        { status: 400 }
      );
    }
    const result = await auditOne(gpid, DEFAULT_DAYS);
    return NextResponse.json(result, {
      status: result.error ? 502 : 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  // POST — batch mode
  let body: { gpids?: string[]; days?: number };
  try {
    body = await request.json() as { gpids?: string[]; days?: number };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { gpids, days = DEFAULT_DAYS } = body;
  if (!gpids || !Array.isArray(gpids) || gpids.length === 0) {
    return NextResponse.json({ error: 'gpids must be a non-empty array' }, { status: 400 });
  }
  if (gpids.length > 10) {
    return NextResponse.json({ error: 'Batch limit is 10 GPIDs per request' }, { status: 400 });
  }

  // Run all audits in parallel
  const results = await Promise.all(gpids.map(gpid => auditOne(gpid, days)));
  const succeeded = results.filter(r => !r.error).length;

  return NextResponse.json(
    {
      summary: { total: gpids.length, succeeded, failed: gpids.length - succeeded },
      results,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

async function auditOne(gpid: string, days: number) {
  const scannedAt = new Date().toISOString();

  // Fetch platform data
  let rawData;
  try {
    rawData = await fetchClientData(gpid, days);
  } catch (err) {
    return {
      gpid,
      error: `Data fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      gapAudit: null,
      storedSnapshotId: null,
    };
  }

  // Run gap auditor
  let gapAudit;
  try {
    gapAudit = await runGapAuditor(rawData);
  } catch (err) {
    return {
      gpid,
      client: { id: rawData.meta.clientId, name: rawData.client.name },
      error: `Gap auditor failed: ${err instanceof Error ? err.message : String(err)}`,
      gapAudit: null,
      storedSnapshotId: null,
    };
  }

  // Persist to MongoDB
  let storedSnapshotId: string | null = null;
  let storageError: string | undefined;
  try {
    const doc: GapSnapshotDoc = {
      gpid,
      scannedAt,
      client: {
        id: rawData.meta.clientId,
        name: rawData.client.name,
        market: rawData.client.tsiMarket ?? null,
      },
      gapAudit,
      workflowState: {
        status: 'pending',
        updatedAt: scannedAt,
      },
    };
    storedSnapshotId = await writeGapSnapshot(doc);
  } catch (err) {
    storageError = err instanceof Error ? err.message : String(err);
  }

  return {
    gpid,
    client: { id: rawData.meta.clientId, name: rawData.client.name, market: rawData.client.tsiMarket },
    scannedAt,
    gapAudit,
    storedSnapshotId,
    ...(storageError ? { storageError } : {}),
    dataErrors: Object.keys(rawData.errors).length > 0 ? rawData.errors : undefined,
  };
}

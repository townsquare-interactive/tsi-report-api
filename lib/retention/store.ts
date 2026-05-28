// MongoDB persistence for the retention pipeline
//
// Two collections:
//   retention_events   — one document per cancellation trigger. Permanent record.
//                        Includes raw data, analyst reasoning, formatter brief, and gap audit.
//   gap_snapshots      — proactive scans (not triggered by cancellation).
//                        Includes workflow state for future automation.
//
// Connection pooling: MongoClient is cached on the module-level global to survive
// Vercel serverless warm starts. Standard Next.js/Vercel pattern.

import { MongoClient, type Db, type Collection } from 'mongodb';
import type { FetchedData, AnalystOutput, RetentionBrief, GapAuditResult } from './types';

// ── Connection pooling ────────────────────────────────────────────────────────
// Promise singleton prevents concurrent cold-start requests from each creating
// their own MongoClient — all callers await the same in-flight connection promise.
let connectionPromise: Promise<Db> | null = null;

async function connect(): Promise<Db> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI env var is not set');

  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
  });

  await client.connect();
  const db = client.db('tsi_client_intelligence');
  await ensureIndexes(db);
  return db;
}

function getDb(): Promise<Db> {
  if (!connectionPromise) connectionPromise = connect();
  return connectionPromise;
}

async function ensureIndexes(db: Db): Promise<void> {
  const events = db.collection('retention_events');
  const snapshots = db.collection('gap_snapshots');

  await Promise.all([
    events.createIndex({ gpid: 1 }),
    events.createIndex({ triggeredAt: -1 }),
    events.createIndex({ 'client.name': 1 }),
    // Sparse unique index — prevents two runs from posting notes to the same Freshdesk ticket
    events.createIndex({ freshdeskTicketId: 1 }, { sparse: true }),
    snapshots.createIndex({ gpid: 1 }),
    snapshots.createIndex({ scannedAt: -1 }),
    snapshots.createIndex({ 'workflowState.status': 1 }),
  ]);
}

// ── Document shapes ───────────────────────────────────────────────────────────
export interface RetentionEventDoc {
  gpid: string;
  triggeredAt: string;       // ISO timestamp from webhook
  periodDays: number;
  cancelType?: string | null;
  freshdeskTicketId?: number | null;  // used as idempotency key — prevents duplicate notes
  freshdeskNoteId?: number | null;    // set after successful note write
  client: {
    id: string;
    name: string;
    market?: string | null;
    monthlyPrice?: number | null;
    tenureMonths: number;
  };
  rawData: {
    gbp: FetchedData['gbp'];
    gbpReviews: FetchedData['gbpReviews'];
    duda: FetchedData['duda'];
    yext: FetchedData['yext'];
    vcita: FetchedData['vcita'];
    activities: FetchedData['activities'];
  };
  analystOutput: AnalystOutput | null;
  retentionBrief: RetentionBrief | null;
  gapAudit: GapAuditResult | null;
  errors: Record<string, string>;
  pipelineAtRisk: number;
  competitors?: string[];  // named competitors extracted from cancel reason — for future competitive intel
}

export interface GapSnapshotDoc {
  gpid: string;
  scannedAt: string;         // ISO timestamp
  client: {
    id: string;
    name: string;
    market?: string | null;
  };
  gapAudit: GapAuditResult;
  workflowState: {
    status: 'pending' | 'outreach_sent' | 'resolved' | 'ignored';
    updatedAt: string;
    notes?: string;
  };
}

// ── Write functions ────────────────────────────────────────────────────────────
export async function writeRetentionEvent(doc: RetentionEventDoc): Promise<string> {
  const db = await getDb();
  const col: Collection<RetentionEventDoc> = db.collection('retention_events');
  const result = await col.insertOne(doc);
  return result.insertedId.toString();
}

export async function writeGapSnapshot(doc: GapSnapshotDoc): Promise<string> {
  const db = await getDb();
  const col: Collection<GapSnapshotDoc> = db.collection('gap_snapshots');
  const result = await col.insertOne(doc);
  return result.insertedId.toString();
}

// ── Read helpers ──────────────────────────────────────────────────────────────
export async function getRetentionHistory(
  gpid: string,
  limit = 5
): Promise<RetentionEventDoc[]> {
  const db = await getDb();
  return (await db
    .collection<RetentionEventDoc>('retention_events')
    .find({ gpid })
    .sort({ triggeredAt: -1 })
    .limit(limit)
    .toArray()) as RetentionEventDoc[];
}

// Returns true if a Freshdesk note has already been posted for this ticket ID.
// Called before writeRetentionNote to prevent duplicate notes on Vercel retries.
export async function noteAlreadyPostedForTicket(ticketId: number): Promise<boolean> {
  const db = await getDb();
  const result = await db
    .collection<RetentionEventDoc>('retention_events')
    .findOne({ freshdeskTicketId: ticketId, freshdeskNoteId: { $ne: null } });
  return result !== null;
}

// Returns the most recent retention event for this GPID if one was generated
// within the dedup window (default: 7 days). Returns null if no recent event.
export async function getRecentRetentionEvent(
  gpid: string,
  dedupWindowDays = 7
): Promise<RetentionEventDoc | null> {
  const db = await getDb();
  const cutoff = new Date(Date.now() - dedupWindowDays * 24 * 60 * 60 * 1000).toISOString();
  const result = await db
    .collection<RetentionEventDoc>('retention_events')
    .findOne(
      { gpid, triggeredAt: { $gte: cutoff } },
      { sort: { triggeredAt: -1 } }
    );
  return result as RetentionEventDoc | null;

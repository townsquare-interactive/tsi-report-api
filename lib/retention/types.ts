// Shared types for the retention multi-agent pipeline

import type { ReportData } from '@/types/report';

// ── Agent 1: Data Fetcher output ─────────────────────────────────────────────
export type FetchedData = ReportData;

// ── Agent 2: Analyst output ──────────────────────────────────────────────────
// Raw reasoning from Sonnet — what IS the retention case for this client?
// Intentionally verbose so the formatter has everything it needs.
export interface RetentionInsight {
  section: 'website' | 'pipeline' | 'listings' | 'gbp' | 'reputation';
  coreArgument: string;       // 1-2 sentences: the fundamental "you'd lose X" argument
  keyDataPoints: string[];    // specific numbers/stats from the raw data
  urgencyLevel: 'high' | 'medium' | 'low';
  urgencyReason: string;      // why this section is high/medium/low urgency
}

export interface LossAsset {
  asset: string;              // what it is: "TSI-hosted website", "Yext directory sync", etc.
  disappearsBy: string;       // timing: "Day 1", "Within 30 days", "Within 90 days"
  impact: string;             // specific consequence for this client
}

export interface OpportunityAction {
  title: string;              // short label: "Activate review request sequence"
  description: string;        // specific action TSI can take to improve performance
  expectedImpact: string;     // what improvement to expect and roughly when
}

export interface AnalystOutput {
  clientProfile: string;      // 1 paragraph: who is this client, how long with TSI, what drives their business
  cancellationRisk: string;   // analyst's read on why they might be canceling (inferred from data)
  cancelReasonAnchor: string | null; // if cancel reason was provided, how it should frame the entire pitch
  topRetentionHook: string;   // the single strongest argument to lead with
  verticalContext: string;    // vertical/industry analysis — what matters most for this business type
  seasonalContext: string;    // seasonal intelligence — is this a seasonal dip or a real trend?
  opportunityActions: OpportunityAction[]; // 1-4 specific things TSI can do to improve performance (Section 1 feed)
  lossAssets: LossAsset[];    // what disappears at cancellation and when (Section 2 feed)
  insights: RetentionInsight[]; // section-level reasoning for subscribed products only
  pipelineAtRisk: number;     // total $ on platform — 0 for Z clients (no payments product)
  tenureMonths: number;
  monthlyPrice: number;       // monthly subscription price — pass-through for free month cap check in formatter
  serviceKeys: string[];      // pass-through for formatter
}

// ── Agent 3: Formatter output ────────────────────────────────────────────────
// Three-section conversation framework + agent pre-call brief

// Pre-call brief — agent reads this BEFORE dialing
export interface AgentBrief {
  clientSnapshot: string;       // 2-3 sentences: who is this, how long with TSI, what's at stake
  contractNote: string | null;  // commitment terms — contract length, end date, days remaining, or null if M2M
  cancelReasonRead: string;     // analyst's best read on why they're actually canceling
  leadWith: string;             // the single strongest opening argument — first 30 seconds
  verticalNote: string;         // vertical/seasonal/geographic context for this specific client
  tsiServiceNote: string | null; // if TSI has dropped the ball (open tickets, no calls), say so here
}

// Section 1 — Opportunity / Greed
// "If I could get you more business in the next 30-60 days, would you keep it?"
export interface Section1Opportunity {
  headline: string;             // opening question/hook
  commitments: Array<{
    title: string;              // "We'll publish 2 new geo pages this week"
    description: string;        // what specifically we'll do
    expectedImpact: string;     // what the client should expect and when
  }>;
  agentScript: string;          // verbatim talking points for the agent — conversational, persuasive
  emailVersion: string;         // customer-facing version for follow-up email if no answer
}

// Section 2 — Fear / Loss
// "Before you go, here's exactly what you'd lose and when"
export interface LossItem {
  asset: string;                // specific asset: "847 Google impressions/month"
  disappearsBy: string;         // "Day 1", "Within 30 days", etc.
  impact: string;               // specific consequence for this business
}

export interface Section2FearLoss {
  headline: string;             // opening question/hook
  lossTimeline: LossItem[];     // ordered by timing
  yearsOfWorkStatement: string; // "You've built X months of Google authority. That took X months."
  agentScript: string;          // verbatim talking points
  emailVersion: string;         // customer-facing follow-up version
}

// Section 3 — Economics / Downgrade
// LAST RESORT ONLY — offered only after client has explicitly declined S1 and S2
// Financial options exist at the bottom of the escalation ladder. Do not surface them early.
export interface FinancialOption {
  type: 'agent_discount' | 'manager_discount' | 'free_month' | 'downgrade' | 'credit';
  requiresManager: boolean;     // true = agent must loop in manager before offering
  label: string;                // plain-English name: "One-time 10% discount"
  eligibility: string;          // specific conditions for this client based on their data
  script: string;               // 1-2 sentences agent says to client when offering this option
}

export interface Section3Economics {
  headline: string;             // final framing — signals reluctant final door, not easy offer
  openingCondition: string;     // internal agent signal: when to open this section (not before S1+S2 rejected)
  eligibilityNotes: string;     // client-specific constraints: past due flag, free month cap, 2x/yr limit
  escalationSequence: FinancialOption[]; // ordered: agent_discount → manager_discount → free_month → downgrade → credit
  agentScript: string;          // how agent opens Section 3 — reluctant, measured, no specific prices
  emailVersion: string;         // follow-up email — leads with value recap, financial options in paragraph 2
}

export interface RetentionBrief {
  agentBrief: AgentBrief;
  section1: Section1Opportunity;
  section2: Section2FearLoss;
  section3: Section3Economics;
  // Pass-through metadata
  pipelineAtRisk: number;
  tenureMonths: number;
}

// ── Agent 4: Gap Auditor output ───────────────────────────────────────────────

export type TenureTier = 'onboarding' | 'growth' | 'mature' | 'veteran';
export type GapScore = 'A' | 'B' | 'C' | 'D' | 'F' | 'N/A';
export type GapStatus = 'healthy' | 'watch' | 'gap' | 'critical' | 'no_data' | 'not_applicable';
export type GapSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface GapAuditDimension {
  score: GapScore;
  status: GapStatus;
  // Key metrics with their actual values — e.g. { impressions: 847, callClicks: 4 }
  actual: Record<string, string | number | null>;
  // What "healthy" looks like at this client's tenure tier
  benchmark: string;
  // Plain-English interpretation of the delta between actual and benchmark
  narrative: string;
  // True when the gap is primarily TSI's responsibility (service failure, setup gap, etc.)
  tsiOwned: boolean;
  // Specific next step for a CSM or CSR
  action: string | null;
}

export interface PrioritizedGap {
  dimension: 'gbp' | 'website' | 'listings' | 'reputation' | 'pipeline' | 'service' | 'financial' | 'structural' | 'cancellation_history' | 'social';
  severity: GapSeverity;
  // One punchy sentence naming the specific number and what it means
  summary: string;
  // True if TSI is responsible for closing this gap
  tsiOwned: boolean;
}

export interface GapAuditResult {
  overallScore: GapScore;
  // Client's tenure bracket — determines which benchmark tier applies
  tenureTier: TenureTier;
  // 2-3 sentence plain-English summary of the account's overall health
  accountHealth: string;
  // True if any dimension has tsiOwned: true — flags for CSM review before the cancel call
  tsiServiceGap: boolean;
  dimensions: {
    gbp: GapAuditDimension;
    website: GapAuditDimension;
    listings: GapAuditDimension;
    reputation: GapAuditDimension;
    pipeline: GapAuditDimension;
    // TSI service quality — calls, open tickets, days since last touchpoint
    service: GapAuditDimension;
    // Financial health — billing events, contract type, discount history, payment cadence
    financial: GapAuditDimension;
    // Structural completeness — website published, GBP resolved, social connected, pages, posts live
    structural: GapAuditDimension;
    // Cancellation history — past cancel attempts, save outcomes, competitor data, current status
    cancellation_history: GapAuditDimension;
    // Social media performance — scored dimension (N/A if not subscribed)
    social: GapAuditDimension;
  };
  // Ranked by severity — top items for the CSR to address
  prioritizedGaps: PrioritizedGap[];
  // The single most important gap or risk, in one sentence
  topGap: string;
}

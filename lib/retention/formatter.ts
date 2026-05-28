// Agent 3: Retention Formatter
//
// Model: claude-sonnet-4-6
//
// Transforms the analyst's reasoning into the three-section conversation framework
// plus an agent pre-call brief. Upgraded from Haiku — Section 1 agent scripts and
// email copy are the primary client-facing deliverable and benefit materially from
// Sonnet's writing quality. The gap auditor and analyst set up the reasoning;
// the formatter is where that reasoning becomes something an agent can actually say.
//
// Output structure:
//   agentBrief     — agent reads this BEFORE dialing (snapshot, cancel read, lead-with, notes)
//   section1       — Opportunity: "If I could get you more business, would you stay?"
//   section2       — Fear/Loss: "Here's exactly what you'd lose and when"
//   section3       — Economics: "If I could make it cheaper, would that change things?"
//
// Section 3 uses Kendal Bledsoe's financial guidelines (integrated 2026-05-20).
// BEHAVIORAL CONSTRAINT: Financial options are LAST RESORT. The brief must structurally
// reinforce that agents offer them only after S1 and S2 have both been explicitly rejected.
// Each section includes: agent talking points + customer-facing email version.

import type { AnalystOutput, RetentionBrief, GapAuditResult } from './types';
import type { CommitmentTerms, ScheduledCancellation, FalconBillingEvent } from '@/types/report';
import { getAnthropicApiKey } from '@/lib/secrets';

// ── Financial eligibility calculator ─────────────────────────────────────────
// Pre-computes offer eligibility from actual billing history so the model
// never has to guess — hard facts are injected directly into the prompt.

const FINANCIAL_OFFER_EVENTS = ['discount', 'credit', 'free month', 'refund'];

function parseFalconDate(dateStr: string): Date | null {
  const parts = dateStr.split('/');
  if (parts.length !== 3) return null;
  const d = new Date(`${parts[2]}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`);
  return isNaN(d.getTime()) ? null : d;
}

function computeFinancialEligibility(billingEvents: FalconBillingEvent[]) {
  const twelveMonthsAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo   = new Date(Date.now() - 30  * 24 * 60 * 60 * 1000);

  const priorOffers = billingEvents.filter(e => {
    const eventLower = e.event.toLowerCase();
    return FINANCIAL_OFFER_EVENTS.some(type => eventLower.includes(type));
  });

  const offersLast12Mo = priorOffers.filter(e => {
    const d = parseFalconDate(e.date);
    return d && d >= twelveMonthsAgo;
  });

  // Most recent offer first
  const sorted = [...offersLast12Mo].sort((a, b) => {
    const da = parseFalconDate(a.date)?.getTime() ?? 0;
    const db = parseFalconDate(b.date)?.getTime() ?? 0;
    return db - da;
  });

  const lastOffer     = sorted[0] ?? null;
  const lastOfferDate = lastOffer ? parseFalconDate(lastOffer.date) : null;
  const daysSinceLast = lastOfferDate
    ? Math.floor((Date.now() - lastOfferDate.getTime()) / (1000 * 60 * 60 * 24))
    : null;

  const offersUsed          = offersLast12Mo.length;
  const remainingAllowed    = Math.max(0, 2 - offersUsed);
  const backToBackBlocked   = daysSinceLast !== null && daysSinceLast < 30;
  const fullyBlocked        = remainingAllowed === 0;

  const historyLines = offersLast12Mo.map(
    e => `  • ${e.event} on ${e.date}${e.amount ? ` ($${e.amount})` : ''}${e.notes ? ` — ${e.notes}` : ''}`
  );

  return {
    offersUsed,
    remainingAllowed,
    lastOfferEvent: lastOffer?.event ?? null,
    lastOfferDate:  lastOffer?.date ?? null,
    daysSinceLast,
    backToBackBlocked,
    fullyBlocked,
    historyLines,
  };
}

function buildContractNote(
  commitmentTerms: CommitmentTerms | null | undefined,
  scheduledCancellation: ScheduledCancellation | null | undefined
): string | null {
  if (!commitmentTerms?.contractLengthMonths || commitmentTerms.contractLengthMonths <= 1) {
    return null; // month-to-month — not noteworthy enough to surface
  }

  const { contractLengthMonths } = commitmentTerms;
  const termLabel = `${contractLengthMonths}-month contract`;

  // Best available end date fallback chain:
  // 1. contractEndDate (direct from Falcon commitmentTerms)
  // 2. scheduledCancellation.pendingCancelDate (when the cancellation takes effect)
  const rawEndDate = commitmentTerms.contractEndDate ?? scheduledCancellation?.pendingCancelDate ?? null;

  if (!rawEndDate) {
    return `${termLabel} — contract end date unavailable`;
  }

  const endDate = new Date(rawEndDate);
  if (isNaN(endDate.getTime())) {
    return `${termLabel} — contract end date unavailable`;
  }

  const now = new Date();
  const isActive = endDate > now;
  const formattedEnd = endDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  if (isActive) {
    const daysRemaining = Math.ceil((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    return `⏰ UNDER CONTRACT — ${termLabel} · Ends ${formattedEnd} · ${daysRemaining} days remaining · Client CANNOT cancel before this date — use this time to rebuild the relationship`;
  } else {
    return `${termLabel} completed ${formattedEnd} — now month-to-month`;
  }
}

function buildSection3Guidelines(
  monthlyPrice: number,
  eligibility: ReturnType<typeof computeFinancialEligibility>
): string {
  // Pre-compute all offer amounts so the model never has to guess — it must use these exact figures
  const hasPricing = monthlyPrice > 0;
  const fmt = (n: number) => `$${n}`;

  const disc5  = hasPricing ? Math.round(monthlyPrice * 0.05)  : null;
  const disc10 = hasPricing ? Math.round(monthlyPrice * 0.10) : null;
  const disc15 = hasPricing ? Math.round(monthlyPrice * 0.15) : null;
  const disc20 = hasPricing ? Math.round(monthlyPrice * 0.20) : null;

  const priceAfter5  = hasPricing ? Math.round(monthlyPrice - (disc5  ?? 0)) : null;
  const priceAfter10 = hasPricing ? Math.round(monthlyPrice - (disc10 ?? 0)) : null;
  const priceAfter15 = hasPricing ? Math.round(monthlyPrice - (disc15 ?? 0)) : null;
  const priceAfter20 = hasPricing ? Math.round(monthlyPrice - (disc20 ?? 0)) : null;

  const mgr20x2Price = hasPricing ? Math.round(monthlyPrice * 0.80) : null; // monthly rate for 2-month deal
  const mgr50x1Price = hasPricing ? Math.round(monthlyPrice * 0.50) : null; // one-time half-month

  const freeMonthValue = monthlyPrice > 500 ? 500 : monthlyPrice;
  const freeMonthNote = monthlyPrice > 500
    ? `Client pays $${monthlyPrice}/mo — OVER the $500 cap. Free month = $500 credit, NOT a full free month.`
    : hasPricing
      ? `Client pays $${monthlyPrice}/mo — under the $500 cap. Full free month = ${fmt(freeMonthValue)} credit.`
      : `Monthly price unknown — free month capped at $500.`;

  const discountTierBreakdown = hasPricing
    ? `Actual amounts for this client (USE THESE IN YOUR LABELS AND SCRIPTS — DO NOT BE VAGUE):
    • 5%  → saves ${fmt(disc5!)}/mo → new rate ${fmt(priceAfter5!)}/mo
    • 10% → saves ${fmt(disc10!)}/mo → new rate ${fmt(priceAfter10!)}/mo
    • 15% → saves ${fmt(disc15!)}/mo → new rate ${fmt(priceAfter15!)}/mo
    • 20% → saves ${fmt(disc20!)}/mo → new rate ${fmt(priceAfter20!)}/mo`
    : `Monthly price unknown — use percentage labels only`;

  const managerDiscountBreakdown = hasPricing
    ? `Actual amounts for this client:
    • 20% off × 2 months → ${fmt(mgr20x2Price!)}/mo for 2 months (saves ${fmt(disc20! * 2)} total)
    • 50% off × 1 month  → ${fmt(mgr50x1Price!)} for one month (saves ${fmt(disc20!)} one-time)`
    : `20% off 2 months OR 50% off 1 month (price unknown — compute from client data)`;

  return `SECTION 3 — ECONOMICS: LAST RESORT ONLY

CRITICAL BEHAVIORAL CONSTRAINT:
TSI retention agents already default to financial concessions too quickly — it is the "easy way out" and we are actively working to reduce that behavior. Your Section 3 output must make agents feel the weight of escalating to financial options, not relief. This section exists but should feel like a reluctant final door — opened only after everything else has closed.

WHEN TO OPEN SECTION 3:
Only after the client has explicitly declined both Section 1 (Opportunity) AND Section 2 (Fear/Loss). If the client is still processing S1 or S2, stay there. Section 3 is NOT a parallel track — it is a last acknowledgment.

TONE OF agentScript:
NOT: "Great news — I might be able to save you some money."
YES: "I've made the full case for the value you'd be leaving behind. If after all of that, the issue truly comes down to what you're paying — not the results — here's where I'm authorized to go."

The agent is reluctant. They've already tried everything. Financial options should feel like the bottom of a drawer they're opening slowly, not a card they're happy to play.

ESCALATION SEQUENCE (strict order — agent works through these one at a time, never jumping ahead):

Step 1 — AGENT-APPROVED DISCOUNT (no manager needed)
  ${discountTierBreakdown}
  - Agent tries lowest tier first and works up only if needed
  - Floor pricing applies — cannot discount below floor regardless of tier
  - LABELS AND SCRIPTS MUST INCLUDE ACTUAL DOLLAR AMOUNTS — e.g. "5% off — $X/mo instead of $Y/mo"

Step 2 — MANAGER-APPROVED DISCOUNT (requires manager)
  ${managerDiscountBreakdown}
  - ONLY offered after agent has already tried Steps 1 (5–20% range)
  - Requires manager on the line or manager approval before offering
  - LABEL AND SCRIPT MUST INCLUDE ACTUAL DOLLAR AMOUNTS

Step 3 — FREE MONTH (no manager needed, conditions apply)
  - ${freeMonthNote}
  - Condition: client must have NO past due balance
  - Cannot be used as a qualification step for a downgrade
  - SCRIPT MUST STATE THE ACTUAL DOLLAR VALUE of the free month credit

Step 4 — DOWNGRADE (requires manager; strict exhaustion gate)
  - ONLY offered after Steps 1, 2, AND 3 have all been exhausted
  - Follows same 5/10/15/20% service reduction progression with actual dollar amounts
  - Floor pricing enforced
  - This is the hardest concession — it reduces the client's service package

Step 5 — CREDIT / WAIVE ONE PAY ONE (agent can propose, manager approves amount)
  - Agent waives one invoice if the client pays one invoice
  - Capped at $500 per invoice
  - No downgrade allowed immediately before or after this offer
  - Not a standalone retention tool — used for payment disputes/goodwill only

HARD LIMITS — COMPUTED FROM ACTUAL BILLING HISTORY (use these exact figures, do not estimate):
${eligibility.fullyBlocked
  ? `⛔ FULLY BLOCKED: This client has used ${eligibility.offersUsed} of 2 allowed financial offers in the last 12 months. NO financial concessions are available without manager AND director approval + ticket submission. Do not offer discounts, free months, or credits. The escalationSequence scripts should reflect this: agent can only say they've exhausted options and must escalate.`
  : eligibility.backToBackBlocked
  ? `⚠️ BACK-TO-BACK BLOCKED: Last offer (${eligibility.lastOfferEvent} on ${eligibility.lastOfferDate}) was only ${eligibility.daysSinceLast} days ago — under the 30-day minimum gap. Cannot offer another financial concession yet. ${eligibility.remainingAllowed} offer(s) remaining in the 12-month window, but back-to-back rule prevents offering today. Agent should note this and not present financial options.`
  : `✅ ELIGIBLE: ${eligibility.remainingAllowed} of 2 financial offer(s) remaining in the 12-month window.${eligibility.lastOfferDate ? ` Last offer: ${eligibility.lastOfferEvent} on ${eligibility.lastOfferDate} (${eligibility.daysSinceLast} days ago — back-to-back window clear).` : ' No prior offers in the last 12 months.'}`}
${eligibility.historyLines.length > 0 ? `\nOffer history (last 12 months):\n${eligibility.historyLines.join('\n')}` : '\nNo financial offers in the last 12 months.'}
- Anything outside these guidelines requires manager AND director approval + ticket submission

ESCALATION SEQUENCE FORMAT — generate all 5 options:
Each FinancialOption must include:
  - type: one of agent_discount | manager_discount | free_month | downgrade | credit
  - requiresManager: true or false
  - label: plain-English name WITH ACTUAL DOLLAR AMOUNTS where applicable
  - eligibility: specific conditions for THIS client (incorporate data — past due flag, package price, tenure)
  - script: 1-2 sentences agent says OUT LOUD — MUST include specific dollar amounts, not percentages alone

emailVersion: Do NOT lead with financial options in the email. Open with the value recap (what S1 and S2 covered). Introduce financial options in a second paragraph, framed as: "If budget is truly the only barrier — and not the results we've been driving — I want to be transparent about what's available." Financial options should feel like a footnote to the value case, not the headline.`;
}

function buildFormatterPrompt(
  analyst: AnalystOutput,
  gapAudit: GapAuditResult | null,
  clientName: string,
  contractNote: string | null,
  eligibility: ReturnType<typeof computeFinancialEligibility>,
  pipelineAtRiskOverride: number
): string {
  const tsiServiceNote = gapAudit?.tsiServiceGap
    ? `TSI SERVICE ALERT: ${gapAudit.dimensions.service?.narrative ?? 'TSI service gaps exist — review before calling.'}`
    : null;

  const section3Guidelines = buildSection3Guidelines(analyst.monthlyPrice, eligibility);

  // Detect contract clients from contractNote — changes pitch energy entirely
  const isUnderContract = contractNote?.includes('UNDER CONTRACT') ?? false;
  const contractModeInstruction = isUnderContract
    ? `\n⏰ CONTRACT CLIENT MODE — READ THIS FIRST:
This client is UNDER CONTRACT and cannot cancel before the date shown above. This is not a crisis — it is an opportunity. The pitch energy must be different:
- NOT: panicked save-the-sale
- YES: confident, patient, "we have time to make this right"
The agentBrief.leadWith should acknowledge the commitment and pivot to how TSI is going to use this window to prove value.
Section 1 commitments should be framed as "here's what we're doing during your remaining time with us" not "here's why you should stay."
Section 2 is still relevant — show them what they'd lose at the END of the term if they don't renew.
Section 3 — financial offers are still last resort, but frame them as "here's what we can do to make the remaining period worth it" rather than "here's how we can keep you from leaving today."
`
    : '';

  return `You are a senior customer success writer at Townsquare Interactive (TSI). A retention analyst has evaluated a cancellation request. Your job is to transform that analysis into a three-section agent brief a live CSR will use on a phone call.

BREVITY REQUIREMENT: Scripts and descriptions must be SHORT. An agent is on a live call with one eye on their notes. Every field should be scannable in 5 seconds. Agent scripts: 2 sentences max. Commitments: 1 sentence each. Loss timeline items: 1 sentence each. emailVersion: 3 sentences max. This is a reference card, not a narrative.

PIPELINE AT RISK — DISPLAY RULE: If pipelineAtRisk is between $0 and $49, do NOT display it as "$1" or any suspiciously low figure. Instead, frame the pipeline argument as the client's annual value to their own business: monthly price × 12 = annual subscription value they're trading away. Example: "At $X/month, you're walking away from $Y/year in digital marketing investment."

S2 SPEAKING CONSTRAINT — CRITICAL: Every sentence in agentScript (Section 2) must be speakable in a single breath. No sentence should contain more than 15 words. No compound clauses strung together with "and" or "while" or "as." The agent is reading off a screen on a live call. If a sentence has more than one comma, it's too long — break it into two. Test every sentence: can you say it naturally without stopping? If not, rewrite it.

PRODUCT NAMING — CRITICAL: TSI never exposes vendor names to clients or agents. In ALL output use only TSI product names: "BMP" or "Growth Management" (not vcita), "Directories" (not Yext), "Website" (not Duda). GBP / Google Business Profile is fine as-is.
${contractModeInstruction}
DEMYSTIFY METRICS: When referencing numbers, always include the plain-English impact. "247 direction requests (247 people tried to navigate to their door)" not just "247 direction requests." The agent needs to be able to say the number and immediately explain what it means.

NAMED LEADS: If the analyst mentions specific lead names (from recentLeadNames), use them. "People like [Name] and [Name] reached out through your website" is more compelling than "12 new leads."

PRIORITY: Section 1 (Opportunity) is the most important output. The agentScript in Section 1 is what the agent says in the first 60 seconds of the call. It determines whether the client stays on the line. Make it specific, human, and grounded in real numbers — not marketing language. Reference actual data points from the analyst output. Avoid any sentence that could apply to a different client.

Every section must feel bespoke. If you find yourself writing a generic sentence, stop and replace it with a specific one. The agent can tell when a script was generated from a template.

---

Client: ${clientName}
Tenure: ${analyst.tenureMonths} months
Pipeline at risk: $${pipelineAtRiskOverride.toLocaleString()}
TSI Service Note: ${tsiServiceNote ?? 'None — service quality is healthy'}

Analyst findings:
${JSON.stringify(analyst, null, 2)}

${gapAudit ? `Gap Audit Summary:\n${JSON.stringify({ overallScore: gapAudit.overallScore, topGap: gapAudit.topGap, tsiServiceGap: gapAudit.tsiServiceGap, accountHealth: gapAudit.accountHealth }, null, 2)}` : ''}

---

${section3Guidelines}

---

Produce the final retention brief as a JSON object with this EXACT structure:

{
  "agentBrief": {
    "clientSnapshot": "2-3 sentences: who is this, how long with TSI, what's at stake. Written as a quick brief the agent reads before dialing. Specific numbers.",
    "contractNote": ${JSON.stringify(contractNote)},
    "cancelReasonRead": "1-2 sentences: what the analyst thinks is really going on — use the cancelReasonAnchor and cancellationRisk from the analysis. Be direct.",
    "leadWith": "the single strongest opening argument — what the agent says in the first 30 seconds. Should be the most compelling specific data point for this client.",
    "verticalNote": "1-2 sentences: the competitiveBenchmark statement from the analyst output, expressed as a plain sentence the agent can say. Must include the actual metric, actual threshold, and above/at/below rating. E.g. 'At 18 months, healthy exterior painters typically see 1,500+ impressions — you're at 847, at the low end of normal for your stage.'",
    "tsiServiceNote": ${JSON.stringify(tsiServiceNote)}
  },
  "section1": {
    "headline": "the opening question — e.g. 'What if we could get you more [leads/calls/traffic] in the next 30 days?'",
    "commitments": [
      {
        "title": "short label — 3-5 words",
        "description": "specific thing TSI will do — 1 sentence",
        "expectedImpact": "plain-English outcome — 1 sentence, include timeframe"
      }
    ],
    "agentScript": "MAXIMUM 2 SENTENCES. What the agent says out loud. Conversational. Must include one specific number. Ends with a yes/no question.",
    "emailVersion": "2-3 sentences max. Professional, specific, references key data point."
  },
  "section2": {
    "headline": "the transition question — e.g. 'Before you go, can I take 60 seconds to show you what would actually happen?'",
    "lossTimeline": [
      {
        "asset": "specific asset with number — e.g. '247 direction requests/month'",
        "disappearsBy": "Day 1 | Within 7 days | Within 30 days | Within 90 days",
        "impact": "plain-English consequence — 1 sentence, what it means for their business"
      }
    ],
    "yearsOfWorkStatement": "1 sentence max. Quantify what they've built with actual numbers.",
    "agentScript": "MAXIMUM 2 SENTENCES. Walk through the timeline in one sentence, end with 'Is it okay if all of that happens?' as the second sentence.",
    "emailVersion": "2-3 sentences max. Asset-inventory framing — what disappears and when."
  },
  "section3": {
    "headline": "Final framing question — signals the value case is fully made and this is reluctant last resort. Do NOT say 'if I could make it cheaper' — that frames it as an easy offer. Frame it as: 'If you've weighed everything we've talked about and it still comes down to what you're paying...'",
    "openingCondition": "Internal agent signal: when to open this section. Must be explicit that S1 AND S2 have both been explicitly rejected. E.g. 'Only say the words below if the client has said no to the opportunity question AND the loss walkthrough. If they are still processing — stay in S1/S2.'",
    "eligibilityNotes": "Client-specific constraints: past due balance status, free month cap check (above/below $500), max 2 financial offerings per 12 months reminder, no back-to-back rule. Flag any unknown prior offer history.",
    "escalationSequence": [
      {
        "type": "agent_discount",
        "requiresManager": false,
        "label": "INCLUDE ACTUAL $ — e.g. '5% off — $X/mo instead of $Y/mo' (start at lowest tier that makes sense given client context)",
        "eligibility": "Specific conditions for this client — floor pricing required; lowest tier first; note if prior offers exist",
        "script": "1-2 sentences with ACTUAL DOLLAR AMOUNTS — e.g. 'I can bring your monthly down to $X, which saves you $Y every month.'"
      },
      {
        "type": "manager_discount",
        "requiresManager": true,
        "label": "INCLUDE ACTUAL $ — e.g. '20% off for 2 months — $X/mo for two months' OR '50% off one month — $X this month'",
        "eligibility": "Only offered after agent has tried 5–20% range; manager must be looped in first",
        "script": "1-2 sentences with ACTUAL DOLLAR AMOUNTS — reference that this requires manager and state the exact savings"
      },
      {
        "type": "free_month",
        "requiresManager": false,
        "label": "INCLUDE ACTUAL $ — e.g. 'Free month — $X credit' (use $500 cap value if over cap)",
        "eligibility": "No past due balance required; state whether this client is above or below the $500 cap; cannot be used as downgrade qualifier",
        "script": "1-2 sentences stating the EXACT CREDIT AMOUNT — e.g. 'I can apply a $X credit to next month so you pay nothing.'"
      },
      {
        "type": "downgrade",
        "requiresManager": true,
        "label": "Service downgrade — reduce package with actual $ savings (e.g. 'Downgrade to $X/mo')",
        "eligibility": "ONLY after steps 1–3 fully exhausted; follows 5/10/15/20% progression; floor pricing enforced; manager required",
        "script": "1-2 sentences — agent acknowledges the reduced service level and states the new price"
      },
      {
        "type": "credit",
        "requiresManager": true,
        "label": "Credit / Waive One Pay One — up to $500",
        "eligibility": "Capped at $500 per invoice; no downgrade immediately before or after; manager approval on amount",
        "script": "1-2 sentences — framed as a goodwill gesture for payment disputes; state the $500 cap clearly"
      }
    ],
    "agentScript": "MAXIMUM 2 SENTENCES. How the agent opens Section 3 — reluctant, final. Acknowledges S1 and S2 are done. Does NOT quote percentages or prices.",
    "emailVersion": "Follow-up email if no answer. MUST open with S1/S2 value recap — what's been built, what would be lost. Financial options in paragraph 2 only, framed as: 'If budget is truly the only barrier after weighing everything above, I want to be transparent about what options are available.' Financial options are a footnote, not the subject."
  },
  "pipelineAtRisk": ${pipelineAtRiskOverride},
  "tenureMonths": ${analyst.tenureMonths},
  "competitors": []
}

COMPETITORS FIELD — extract any named competitors from the analyst findings, cancelReasonAnchor, or agentCancelNotes. Use actual business or brand names only (e.g., ["Hibu", "Scorpion", "Thryv", "Yelp"]). If no competitor is named, return an empty array. Never include generic terms like "competitor" or "other company." These are stored for competitive intelligence.

Rules:
- Agent scripts should sound like a real human on the phone, not a marketing deck. Contractions are fine. Specificity is required.
- lossTimeline: 3-6 items, ordered by timing (Day 1 first). Use actual numbers where the analyst provided them.
- section1 commitments: 2-4 items, grounded in the analyst's opportunityActions. Make them concrete promises, not vague gestures.
- emailVersion in both sections should be ready to copy-paste — professional but warm, specific numbers, no filler.

**ANTI-GENERIC QUALITY GATE — apply before finalizing:**
For every sentence in agentScript (S1 and S2) and verticalNote, apply this test: "Could I copy this sentence onto a different client's brief with no changes?" If yes — if it contains no business name, no specific number, no specific TSI commitment — rewrite it until it fails that test.

S1 agentScript MUST contain all three:
(a) the client's business name or their market/city
(b) a specific number from their data (impressions, leads, call clicks, pipeline $, etc.)
(c) a specific TSI commitment ("We'll publish 2 new geo pages this week", "I'll have our team review your GBP setup within 48 hours")

verticalNote MUST carry the competitiveBenchmark statement with the actual metric value and actual threshold — not generic vertical description.

- Return ONLY the raw JSON object. No markdown. No code fences. No \`\`\`json prefix. The response must start with { and end with }.`;
}

export async function runFormatter(
  analyst: AnalystOutput,
  clientName: string,
  gapAudit: GapAuditResult | null = null,
  commitmentTerms: CommitmentTerms | null = null,
  scheduledCancellation: ScheduledCancellation | null = null,
  billingEvents: FalconBillingEvent[] = []
): Promise<RetentionBrief> {
  const apiKey = getAnthropicApiKey();
  const contractNote = buildContractNote(commitmentTerms, scheduledCancellation);
  const eligibility  = computeFinancialEligibility(billingEvents);

  // Fix $1 pipeline artifact: when pipelineAtRisk is suspiciously low (< $50),
  // fall back to annual subscription value so the formatter has a meaningf
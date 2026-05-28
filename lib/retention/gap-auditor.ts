// Agent 4: Gap Auditor
//
// Model: claude-sonnet-4-6
//
// Runs in parallel with the Analyst (Agent 2). Produces a full account health
// index — every platform dimension scored against tenure-calibrated benchmarks,
// plus a TSI service quality layer derived from Falcon activity data.
//
// This is the learning data store for the future proactive retention agent.
// It captures the complete health state of a client at cancellation time,
// across performance, financial, structural, and cancellation history signals.
// Every dimension and data point stored here feeds that future model.
//
// Output shape:
//   - 10 dimensions: gbp, website, listings, reputation, pipeline, service,
//                    financial, structural, cancellation_history, social
//   - Each dimension: score (A-F), actual values, benchmark statement, narrative delta,
//     tsiOwned flag (is this gap our problem?), specific action
//   - prioritizedGaps: ranked list with severity and ownership
//   - tsiServiceGap: top-level flag if any dimension is TSI-owned
//
// This is not a "data presence" check — it's a performance delta check.
// The goal is to answer: "What does this account actually look like, and where
// is it falling short of what a healthy TSI client at this tenure tier should look like?"

import type { FetchedData, GapAuditResult } from './types';
import { getAnthropicApiKey } from '@/lib/secrets';

function buildGapAuditorPrompt(data: FetchedData, periodDays: number): string {
  const { client, gbp, gbpReviews, duda, yext, vcita, activities, soci } = data;

  // ── Derived metrics ─────────────────────────────────────────────────────────
  const launchDate = client.subscription?.launchDate;
  const tenureMonths = launchDate
    ? Math.round((Date.now() - new Date(launchDate).getTime()) / (1000 * 60 * 60 * 24 * 30))
    : 0;

  const avgRating = gbpReviews?.length
    ? (gbpReviews.reduce((s, r) => s + Number(r.rating), 0) / gbpReviews.length).toFixed(1)
    : null;

  const repliedCount = gbpReviews?.filter(r => r.hasReply).length ?? 0;
  const reviewReplyRate = gbpReviews?.length
    ? Math.round((repliedCount / gbpReviews.length) * 100)
    : null;

  // Days since the most recent ticket was touched — proxy for last TSI touchpoint
  const daysSinceLastTouchpoint = (() => {
    if (!activities?.recentTickets?.length) return null;
    const mostRecent = activities.recentTickets
      .map(t => new Date(t.updatedAt).getTime())
      .sort((a, b) => b - a)[0];
    return Math.floor((Date.now() - mostRecent) / (1000 * 60 * 60 * 24));
  })();

  // Exclude billing workflow ticket types from service health evaluation.
  // Mirrors the blocklist in lib/falcon.ts — must stay in sync.
  // - Cancellation Request: the retention trigger itself, not a service event
  // - Accounts Receivable: billing/collections workflow artifact
  // - Account Resolution: auto-created on billing declines — NOT a TSI service failure
  const isWorkflowTicket = (type: string) =>
    /cancellation/i.test(type) ||
    /accounts?\s*receivable/i.test(type) ||
    /account\s*resolution/i.test(type);

  const openTicketDetails = activities?.recentTickets
    ?.filter(t =>
      (t.status === 'OPEN' || t.status === 'IN_PROGRESS' || t.status === 'BLOCKED') &&
      !isWorkflowTicket(t.type ?? '')
    )
    .map(t => ({
      subject: t.subject,
      type: t.type,
      status: t.status,
      daysOpen: Math.floor((Date.now() - new Date(t.createdAt).getTime()) / (1000 * 60 * 60 * 24)),
    })) ?? [];

  const hasBlockedTickets = openTicketDetails.some(t => t.status === 'BLOCKED');

  // Falcon returns serviceKeys as bundled strings e.g. ["WOYTZ"] — split into individual chars
  const serviceKeys: string[] = (client.subscription?.serviceKeys ?? [])
    .flatMap((k: string) => k.split(''));
  const hasWebsite = serviceKeys.includes('W');
  const hasSEO = serviceKeys.includes('O');
  const hasListings = serviceKeys.includes('Y');
  const hasFullBMP = serviceKeys.includes('V');
  const hasLiteBMP = serviceKeys.includes('Z');
  const hasCallTrace = serviceKeys.includes('C') || serviceKeys.includes('P');
  const hasSocial = serviceKeys.includes('S');
  const hasEmail = serviceKeys.includes('E');
  const hasFunnels = serviceKeys.includes('F');

  // ── Contract / commitment derived values ──────────────────────────────────
  const endDate = client.subscription?.endDate ?? null;
  const commitmentTerms = client.subscription?.commitmentTerms ?? null;
  const scheduledCancellation = client.subscription?.scheduledCancellation ?? null;
  const contractEndDate = commitmentTerms?.contractEndDate ?? null;
  const effectiveCancelDate = contractEndDate || scheduledCancellation?.pendingCancelDate || null;
  const isM2M = !endDate || endDate === '0000-00-00';
  const isInCommitment = effectiveCancelDate ? new Date(effectiveCancelDate) > new Date() : false;
  const daysRemainingInCommitment = isInCommitment && effectiveCancelDate
    ? Math.ceil((new Date(effectiveCancelDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : 0;

  // ── Billing event analysis ─────────────────────────────────────────────────
  const twelveMonthsAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
  const billingEvents12mo = (client.billingEvents ?? []).filter(e => {
    const parts = e.date.split('/');
    if (parts.length !== 3) return false;
    const dt = new Date(`${parts[2]}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`);
    return !isNaN(dt.getTime()) && dt >= twelveMonthsAgo;
  });
  const discountEvents = billingEvents12mo.filter(e =>
    /discount|adjustment|credit/i.test(e.event)
  );
  const allDiscountEvents = (client.billingEvents ?? []).filter(e =>
    /discount|adjustment|credit/i.test(e.event)
  );

  // ── Cancellation history analysis ─────────────────────────────────────────
  const cancellationHistory = client.cancellationHistory ?? [];
  const priorCancelRequests = cancellationHistory.filter(e =>
    /request/i.test(e.event)
  ).length;
  const savedFromCancel = cancellationHistory.filter(e =>
    /save|retain|kept/i.test(e.event)
  ).length;
  const cancelReasons = cancellationHistory
    .map(e => e.reason)
    .filter(Boolean) as string[];
  const uniqueCancelReasons = [...new Set(cancelReasons)];

  const snapshot = JSON.stringify({
    client: {
      name: client.name,
      market: client.tsiMarket,
      monthlyPrice: client.price,
      tenureMonths,
      serviceKeys,
      launchDate: client.subscription?.launchDate,
      subscribedProducts: {
        website: hasWebsite,
        seo: hasSEO,
        listings: hasListings,
        fullBMP_payments: hasFullBMP,
        liteBMP_noPayments: hasLiteBMP,
        callTrace: hasCallTrace,
        social: hasSocial,
        email: hasEmail,
        funnels: hasFunnels,
      },
    },
    contractStatus: {
      type: isM2M ? 'month-to-month' : 'contract',
      endDate,
      contractLengthMonths: commitmentTerms?.contractLengthMonths ?? null,
      contractStartDate: commitmentTerms?.contractStartDate ?? null,
      contractEndDate,
      effectiveCancelDate,
      isInCommitment,
      daysRemainingInCommitment: isInCommitment ? daysRemainingInCommitment : null,
      scheduledCancellation,
    },
    billing: {
      billingEventsLast12Mo: billingEvents12mo,
      discountsLast12Mo: discountEvents.length,
      discountEventsLast12Mo: discountEvents,
      totalDiscountsAllTime: allDiscountEvents.length,
      allBillingEvents: client.billingEvents ?? [],
    },
    cancellationHistory: {
      allEvents: cancellationHistory,
      priorCancelRequests,
      savedFromCancel,
      uniqueCancelReasons,
      currentScheduledCancellation: scheduledCancellation,
    },
    gbp: gbp
      ? {
          businessImpressions: gbp.businessImpressions,
          mapImpressions: gbp.mapImpressions,
          searchImpressions: gbp.searchImpressions,
          totalImpressions: (gbp.businessImpressions ?? 0) + (gbp.mapImpressions ?? 0) + (gbp.searchImpressions ?? 0),
          callClicks: gbp.callClicks,
          websiteClicks: gbp.websiteClicks,
          directionRequests: gbp.directionRequests,
          postsLive: gbp.postsLive,
        }
      : null,
    reviews: gbpReviews?.length
      ? {
          total: gbpReviews.length,
          averageRating: avgRating,
          repliedCount,
          replyRate: reviewReplyRate !== null ? `${reviewReplyRate}%` : null,
        }
      : null,
    website: duda
      ? {
          pageViews: duda.pageViews,
          uniqueVisitors: duda.uniqueVisitors,
          visits: duda.visits,
          totalPages: duda.totalPages,
          siteUpdatesInPeriod: duda.siteUpdates?.length ?? 0,
          publishedPostsInPeriod: duda.publishedPosts?.length ?? 0,
          lastPublished: duda.lastPublished,
          daysSinceLastPublish: duda.lastPublished
            ? Math.floor((Date.now() - new Date(duda.lastPublished).getTime()) / (1000 * 60 * 60 * 24))
            : null,
          siteAlias: duda.siteAlias,
        }
      : null,
    listings: yext
      ? {
          totalListings: yext.totalListings,
          syncedListings: yext.syncedListings,
          syncRate: yext.totalListings > 0
            ? `${Math.round((yext.syncedListings / yext.totalListings) * 100)}%`
            : null,
          accuracyScore: yext.accuracy,
          averageScore: yext.averageScore,
          impressions: yext.impressions,
          actions: yext.actions,
          actionBreakdown: yext.actionBreakdown ?? null,
          periodNote: `All metrics cover the last ${periodDays} days`,
        }
      : null,
    pipeline: vcita
      ? hasFullBMP
        ? {
            totalLeads: vcita.totalLeads,
            newLeads: vcita.newLeads,
            leadSamples: vcita.leadSamples,
            activePipeline: vcita.activePipeline,
            upcomingBookings: vcita.upcomingBookings,
            conversations: vcita.conversations,
            openInvoices: vcita.openInvoices,
            totalRevenue: vcita.totalRevenue,
          }
        : {
            // Z client (Lead Nurturing only) — payment/revenue fields deliberately excluded
            totalLeads: vcita.totalLeads,
            newLeads: vcita.newLeads,
            leadSamples: vcita.leadSamples,
            upcomingBookings: vcita.upcomingBookings,
            conversations: vcita.conversations,
          }
      : null,
    social: hasSocial && soci
      ? {
          upcomingPostCount: soci.upcomingPostCount,
          recentlySentCount: soci.recentlySentCount,
          scheduledNetworks: soci.scheduledNetworks,
          pageFans28day: soci.fbInsights?.pageFans28day ?? null,
          pageFansChangePct28day: soci.fbInsights?.pageFansChangePct28day ?? null,
          pageImpressions28day: soci.fbInsights?.pageImpressions28day ?? null,
          pageImpressionsChangePct28day: soci.fbInsights?.pageImpressionsChangePct28day ?? null,
          pagePostEngagements28day: soci.fbInsights?.pagePostEngagements28day ?? null,
          pageEngagedUsers28day: soci.fbInsights?.pageEngagedUsers28day ?? null,
          sentiment: soci.sentiment ?? null,
          demographics: soci.demographics ?? null,
          topPosts: soci.topPosts?.slice(0, 3) ?? [],
        }
      : hasSocial ? null : 'not_subscribed',
    // dataErrors tells you WHY a platform field is null — a fetch failure vs. empty data.
    dataErrors: Object.keys(data.errors ?? {}).length > 0 ? data.errors : null,
    service: {
      callsInPeriod: activities?.callsThisPeriod ?? 0,
      smsInPeriod: activities?.smsThisPeriod ?? 0,
      totalTicketsInPeriod: activities?.totalThisPeriod ?? 0,
      openTickets: activities?.openTickets ?? 0,
      resolvedThisPeriod: activities?.resolvedThisPeriod ?? 0,
      daysSinceLastTouchpoint,
      hasBlockedTickets,
      openTicketDetails,
    },
  }, null, 2);

  return `You are a senior client success analyst at Townsquare Interactive (TSI). Your job is to produce a comprehensive account health index for this client — every platform we manage scored against what a healthy TSI account at their tenure tier should look like, plus an honest evaluation of TSI's own service quality, financial health signals, structural setup quality, and cancellation history.

This is the PRIMARY LEARNING DATASET for a future proactive retention model. Every dimension you score and every data point you include will be used to train an agent that identifies at-risk clients BEFORE they request cancellation. Score accurately and richly — do not soften gaps or omit signals.

---

## CRITICAL: NULL DATA ≠ ABSENT PRODUCT

Before scoring anything, understand these rules:

- \`subscribedProducts\` is the ONLY source of truth for what this client has. Trust it absolutely.
- If a platform data field is null (e.g., gbp: null, website: null, listings: null), it means the data FETCH FAILED or we couldn't resolve the account. It does NOT mean the client lacks that product.
- When a subscribed product's data is null: use status "no_data", note the data was unavailable, and do NOT penalize the score purely for absence of data. Flag it as needing investigation instead.
- NEVER write "no website" or "no listings" or any absence claim if subscribedProducts shows the product is true.

## CRITICAL: SERVICE KEY RULES — READ BEFORE SCORING ANYTHING

The client data includes a \`subscribedProducts\` map. You MUST enforce these rules before scoring any dimension:

**website dimension:**
- subscribedProducts.website = false → score: "N/A", status: "not_applicable", narrative: "Client does not have the Website product.", action: null

**listings dimension:**
- subscribedProducts.listings = false → score: "N/A", status: "not_applicable", narrative: "Client does not have the Directory Listing product.", action: null
- subscribedProducts.listings = true AND business is service-area type (plumber, electrician, cleaner, landscaper, etc.) → incomplete sync is EXPECTED; do not penalize lower sync counts

**pipeline dimension (vcita):**
- subscribedProducts.fullBMP_payments = false AND subscribedProducts.liteBMP_noPayments = true → this is a Z/Lead Nurturing client
  → Evaluate ONLY: leads, bookings, conversations
  → NEVER reference: revenue, activePipeline, openInvoices, totalRevenue, or any dollar amounts
  → If pipeline data shows $0 revenue/pipeline, DO NOT flag this as a gap — the client does not have that product
- subscribedProducts.fullBMP_payments = false AND subscribedProducts.liteBMP_noPayments = false → no BMP at all → score: "N/A", status: "not_applicable"

**reputation dimension (reviews):**
- subscribedProducts.listings = false → reputation monitoring is not subscribed → score: "N/A", status: "not_applicable"

**social dimension:**
- subscribedProducts.social = false → score: "N/A", status: "not_applicable", narrative: "Client does not have the Social product.", action: null
- social data is null but subscribedProducts.social = true → score based on no_data, flag for investigation

**GBP dimension:**
- Always evaluate GBP — it is core to all TSI packages

**service dimension:**
- Always evaluate TSI service quality — it is relevant regardless of product mix

**financial, structural, cancellation_history dimensions:**
- Always evaluate — these are always applicable regardless of product mix

**Important:** A "not_applicable" dimension means the product was never sold to this client. It is NOT a gap, NOT a failure, and should NOT appear in prioritizedGaps.

---

## TENURE TIERS & BENCHMARKS

Determine the client's tier from tenureMonths, then apply the appropriate benchmarks:

**ONBOARDING (0–3 months):** Recently launched. Focus on setup completeness, early signals.
**GROWTH (3–12 months):** Ramp phase. Expect early ROI signals across all platforms.
**MATURE (12–24 months):** Fully ramped. Should be hitting all benchmarks. If not, there's a real gap.
**VETERAN (24+ months):** Proven investment. Should show strong multi-platform performance. Gaps here are serious.

---

## BENCHMARK MATRIX (all figures are for the report period provided)

### GBP (Google Business Profile)
| Metric | Growth | Mature | Veteran |
|---|---|---|---|
| Total impressions | 1,500+ | 3,500+ | 6,000+ |
| Call clicks | 15+ | 35+ | 60+ |
| Direction requests | 10+ | 25+ | 40+ |
| Website clicks | 20+ | 50+ | 80+ |
| Posts live | 2+ | 4+ | 6+ |

GBP below benchmark = the business is invisible in local search. This compounds every month.

### Website (Duda)
| Metric | Growth | Mature | Veteran |
|---|---|---|---|
| Unique visitors | 150+ | 350+ | 600+ |
| Page views | 400+ | 900+ | 1,500+ |
| Total pages | 5+ | 8+ | 10+ |
| Site updates in period | 4+ | 6+ | 6+ |
| Days since last publish | <60 | <30 | <30 |

A stale site (no updates in 60+ days) signals to Google the site is abandoned. Content freshness directly affects rankings. A single-page website limits indexable content.

### Listings (Yext)
| Metric | Any tier |
|---|---|
| Accuracy score | 90+ is healthy; 80–89 is watch; <80 is gap |
| Synced listings | 50+ is strong; 30–49 is moderate; <30 is low |
| Sync rate | 90%+ of total should be synced |

### Reputation (Reviews)
| Metric | Growth | Mature | Veteran |
|---|---|---|---|
| Average rating | 4.0+ | 4.2+ | 4.3+ |
| Reply rate | 40%+ | 65%+ | 75%+ |
| New reviews in period | 1+ | 3+ | 5+ |

### Pipeline (vcita)
| Metric | Growth | Mature | Veteran |
|---|---|---|---|
| Active pipeline | >$0 | $500+ | $1,500+ |
| New leads in period | 1+ | 3+ | 5+ |
| Upcoming bookings | 1+ | 2+ | 3+ |

### Social (SOCI)
| Metric | Any tier |
|---|---|
| Upcoming scheduled posts | 4+ per month is healthy |
| Page impressions trend (28-day) | positive or stable |
| Post engagement | positive sentiment, active scheduling across 2+ networks |
| Recency | posts scheduled for current/next week = active |

Inactive social (0 upcoming posts, no sent this period) = product abandoned. Actively posting but declining reach = platform-level issue.

### Service (TSI responsibility)
| Metric | Any tier |
|---|---|
| Outbound calls in period | 2+ per 90 days (minimum touch cadence) |
| Days since last touchpoint | <30 days for mature/veteran; <45 for growth |
| Open tickets | 0 is ideal; 1 is acceptable; 2+ needs explanation |
| Blocked tickets | Any BLOCKED non-cancellation ticket = TSI service failure |

### Financial
| Signal | Meaning |
|---|---|
| M2M client | Higher churn risk than contract clients — no commitment barrier |
| 2+ discounts in 12 months | Financially stressed or price-sensitive — Economics escalation already partially used |
| 1 discount in 12 months | One concession in window — one more available before limit |
| 0 discounts in 12 months | Clean history — full Economics section available if needed |
| Under active contract | Commitment barrier present — lower immediate churn risk |
| discountEvents.event = "Launch" or "Registration" | Normal onboarding event — not a financial concession |

Financial score is NOT about revenue — it's about churn risk indicators and concession eligibility context.

### Structural
| Signal | Meaning |
|---|---|
| GBP data null (fetch failed) | GBP account may be unresolved — setup issue |
| Website data null (fetch failed) | Duda site not connected or not published — setup issue |
| totalPages < 5 | Single or minimal-page site — limited SEO surface |
| postsLive = 0 | No GBP posts — content marketing absent |
| Social subscribed but not connected | Product sold but not configured |
| daysSinceLastPublish > 90 | Site abandoned — structural staleness |

Structural score measures setup quality and platform activation, not performance. A client can have good GBP numbers but still have structural gaps (e.g., website not published, no posts live).

### Cancellation History
| Signal | Meaning |
|---|---|
| priorCancelRequests = 0 | First-time cancel — unknown save behavior |
| priorCancelRequests = 1, savedFromCancel = 1 | Saved once before — what worked? Reference it |
| priorCancelRequests >= 2 | Repeat cancel pattern — high churn risk, save is harder |
| cancelReasons contain competitor name | Competitive threat — factor into pitch |
| scheduledCancellation.cancelStatus = "PENDING" | Active scheduled cancel — urgency is real |

---

## CLIENT DATA

${snapshot}

---

## OUTPUT FORMAT

Return a JSON object with this exact structure. Be specific — use the actual numbers from the data. Do not round up or soften gaps. This data will be stored as training data for a future proactive retention model, so accuracy and completeness matter more than softness.

{
  "overallScore": "A|B|C|D|F — single letter grade for the overall account health",
  "tenureTier": "onboarding|growth|mature|veteran",
  "accountHealth": "2-3 sentences: plain English account summary — who is this client, what does their data actually show, what is the single most important health signal",
  "tsiServiceGap": true or false,
  "dimensions": {
    "gbp": {
      "score": "A|B|C|D|F|N/A",
      "status": "healthy|watch|gap|critical|no_data",
      "actual": { "totalImpressions": <number>, "callClicks": <number>, "directionRequests": <number>, "websiteClicks": <number>, "postsLive": <number> },
      "benchmark": "one sentence: what healthy looks like at their tenure tier",
      "narrative": "specific delta: e.g. '847 impressions vs. 3,500+ expected for a mature account — running at 24% of benchmark. Call clicks near zero means GBP is generating visibility but not converting.'",
      "tsiOwned": false,
      "action": "specific next step or null"
    },
    "website": {
      "score": "A|B|C|D|F|N/A",
      "status": "healthy|watch|gap|critical|no_data",
      "actual": { "uniqueVisitors": <number>, "pageViews": <number>, "totalPages": <number>, "siteUpdates": <number>, "daysSinceLastPublish": <number or null> },
      "benchmark": "...",
      "narrative": "...",
      "tsiOwned": false,
      "action": "..."
    },
    "listings": {
      "score": "A|B|C|D|F|N/A",
      "status": "healthy|watch|gap|critical|no_data",
      "actual": { "syncedListings": <number>, "totalListings": <number>, "accuracyScore": <number or null>, "impressions": <number> },
      "benchmark": "...",
      "narrative": "...",
      "tsiOwned": false,
      "action": "..."
    },
    "reputation": {
      "score": "A|B|C|D|F|N/A",
      "status": "healthy|watch|gap|critical|no_data",
      "actual": { "totalReviews": <number>, "averageRating": <string or null>, "replyRate": <string or null>, "repliedCount": <number> },
      "benchmark": "...",
      "narrative": "...",
      "tsiOwned": false,
      "action": "..."
    },
    "pipeline": {
      "score": "A|B|C|D|F|N/A",
      "status": "healthy|watch|gap|critical|no_data",
      "actual": { "activePipeline": <number>, "newLeads": <number>, "upcomingBookings": <number>, "totalRevenue": <number> },
      "benchmark": "...",
      "narrative": "...",
      "tsiOwned": false,
      "action": "..."
    },
    "service": {
      "score": "A|B|C|D|F",
      "status": "healthy|watch|gap|critical",
      "actual": { "callsInPeriod": <number>, "smsInPeriod": <number>, "openTickets": <number>, "daysSinceLastTouchpoint": <number or null>, "hasBlockedTickets": <boolean> },
      "benchmark": "2+ outbound calls per 90 days, no tickets open >30 days, last touchpoint within 30 days for mature/veteran accounts",
      "narrative": "honest assessment of TSI's service quality for this account — calls made, ticket handling, recency of contact. If TSI hasn't called in 90 days, say so plainly.",
      "tsiOwned": true or false,
      "action": "what TSI should do before the cancel call, or null if service is healthy"
    },
    "financial": {
      "score": "A|B|C|D|F",
      "status": "healthy|watch|gap|critical",
      "actual": {
        "contractType": "month-to-month|contract",
        "isInCommitment": <boolean>,
        "daysRemainingInCommitment": <number or null>,
        "discountsLast12Mo": <number>,
        "totalDiscountsAllTime": <number>,
        "monthlyPrice": <number or null>
      },
      "benchmark": "Contract clients are lower churn risk. M2M clients with 0 discounts in 12 months have full Economics flexibility. 2+ discounts in 12 months = concession cap reached.",
      "narrative": "Describe the financial health signal: contract type, commitment status, discount history. State the concession eligibility clearly — e.g. 'M2M client, 1 discount in last 12 months — one concession still available in the rolling window.'",
      "tsiOwned": false,
      "action": "concession eligibility summary for the CSR — what financial options remain available"
    },
    "structural": {
      "score": "A|B|C|D|F",
      "status": "healthy|watch|gap|critical",
      "actual": {
        "gbpResolved": <boolean — gbp data was not null>,
        "websitePublished": <boolean — duda data was not null and lastPublished is not null>,
        "totalPages": <number or null>,
        "postsLive": <number or null>,
        "socialConnected": <boolean — soci data was not null if subscribed>,
        "daysSinceLastPublish": <number or null>
      },
      "benchmark": "All subscribed products should be fully configured and active. Website should have 5+ pages. GBP account should be resolved. Social should be connected if subscribed.",
      "narrative": "Describe the structural setup quality — which products are active, what is missing or incomplete, and whether any setup gaps are contributing to poor performance metrics.",
      "tsiOwned": true,
      "action": "specific setup action needed, or null if fully configured"
    },
    "cancellation_history": {
      "score": "A|B|C|D|F",
      "status": "healthy|watch|gap|critical",
      "actual": {
        "priorCancelRequests": <number>,
        "savedFromCancel": <number>,
        "uniqueCancelReasons": <string[]>,
        "currentScheduledStatus": <string or null — scheduledCancellation.cancelStatus>,
        "currentCancelReason": <string or null>
      },
      "benchmark": "First-time cancel with no prior history = unknown. Repeat cancel pattern = high risk. Prior save with known reason = actionable.",
      "narrative": "Describe the cancellation history: first time or repeat, what saved them before if applicable, known reasons/competitors, current scheduled status.",
      "tsiOwned": false,
      "action": "how cancellation history should inform the pitch approach — reference what worked before if a save exists"
    },
    "social": {
      "score": "A|B|C|D|F|N/A",
      "status": "healthy|watch|gap|critical|no_data|not_applicable",
      "actual": {
        "upcomingPostCount": <number or null>,
        "recentlySentCount": <number or null>,
        "scheduledNetworks": <string[] or null>,
        "pageFans28day": <number or null>,
        "pageImpressions28day": <number or null>,
        "pageImpressionsChangePct28day": <number or null>,
        "pagePostEngagements28day": <number or null>,
        "sentimentScore": <number or null — avgSentiment>
      },
      "benchmark": "Active scheduling (4+ posts/month across 2+ networks), stable or growing audience, positive engagement trend.",
      "narrative": "Describe social health: scheduling activity, audience trend, engagement quality. If not subscribed, note N/A.",
      "tsiOwned": false,
      "action": "..."
    }
  },
  "prioritizedGaps": [
    {
      "dimension": "gbp|website|listings|reputation|pipeline|service|financial|structural|cancellation_history|social",
      "severity": "critical|high|medium|low",
      "summary": "one punchy sentence with the specific number — e.g. 'GBP impressions at 24% of benchmark for a mature account'",
      "tsiOwned": true or false
    }
  ],
  "topGap": "The single most important gap or risk in one sentence — either the worst performance gap or the TSI service issue if one exists"
}

Rules:
- Include all 10 dimensions in every response
- prioritizedGaps should include ALL dimensions scoring C or below, ranked by severity
- N/A dimensions (not_applicable status) are excluded from prioritizedGaps
- If any service metric indicates TSI dropped the ball, set tsiOwned: true on the service dimension AND set tsiServiceGap: true at the top level
- topGap should surface a TSI service gap over a client performance gap if both exist — we need to own that going into the call
- The financial dimension's action field is the concession eligibility summary — this is used directly in the retention brief
- The cancellation_history dimension's action field should reference prior save tactics if they exist
- IMPORTANT: Cancellation Request, Account Resolution, and Accounts Receivable ticket types are NOT in openTicketDetails — they are filtered before you receive this data. These are billing workflow artifacts, not TSI service failures. If you see any mention of them in the raw data, ignore them entirely for service dimension scoring.
- Return only the JSON object`;
}

export async function runGapAuditor(data: FetchedData, periodDays = 90): Promise<GapAuditResult> {
  const apiKey = getAnthropicApiKey();

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(120_000), // 2-min hard cap
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 6000,
      messages: [{ role: 'user', content: buildGapAuditorPrompt(data, periodDays) }],
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    thr
// Agent 2: Retention Analyst
//
// Model: claude-sonnet-4-6
//
// Reasoning step — evaluates raw client data and builds the retention case.
// Produces enriched AnalystOutput consumed by the Formatter (Agent 3):
//   - clientProfile, cancellationRisk, cancelReasonAnchor
//   - verticalContext, seasonalContext (bespoke intelligence)
//   - opportunityActions (1-4 specific improvements for Section 1)
//   - lossAssets (what disappears and when — Section 2 feed)
//   - insights (section-level reasoning — subscribed products only)
//   - pipelineAtRisk (0 for Z/Lead Nurturing clients)
//
// Service key rules are enforced here: only subscribed products generate insights.
// V vs Z BMP distinction is enforced: Z clients never get revenue/pipeline analysis.

import type { FetchedData, AnalystOutput } from './types';
import { getAnthropicApiKey } from '@/lib/secrets';
import { getRetentionContext } from './context';

function buildAnalystPrompt(data: FetchedData, periodDays: number, agentNotes: string): string {
  const { client, gbp, gbpReviews, duda, yext, vcita, activities, soci } = data;

  const launchDate = client.subscription?.launchDate;
  const tenureMonths = launchDate
    ? Math.round((Date.now() - new Date(launchDate).getTime()) / (1000 * 60 * 60 * 24 * 30))
    : 0;

  // Falcon returns serviceKeys as bundled strings e.g. ["WOYTZ"] — split into individual chars
  const serviceKeys: string[] = (client.subscription?.serviceKeys ?? [])
    .flatMap((k: string) => k.split(''));
  const hasWebsite  = serviceKeys.includes('W');
  const hasSEO      = serviceKeys.includes('O');
  const hasListings = serviceKeys.includes('Y');
  const hasFullBMP  = serviceKeys.includes('V');
  const hasLiteBMP  = serviceKeys.includes('Z');
  const hasSocial   = serviceKeys.includes('S');

  // pipelineAtRisk is only meaningful for V (full BMP) clients
  const openInvoiceTotal = hasFullBMP
    ? (vcita?.invoiceItems?.filter(i => i.status !== 'paid').reduce((s, i) => s + i.amount, 0) ?? 0)
    : 0;
  const pipelineAtRisk = hasFullBMP
    ? (vcita?.activePipeline ?? 0) + openInvoiceTotal
    : 0;

  const avgRating = gbpReviews?.length
    ? (gbpReviews.reduce((s, r) => s + Number(r.rating), 0) / gbpReviews.length).toFixed(1)
    : null;

  const today = new Date();
  const currentMonth = today.toLocaleString('en-US', { month: 'long' });
  const currentYear = today.getFullYear();

  // Build named lead anecdote list — max 5 entries with email for spam judgment.
  // Format: "Name (email@domain.com)" so the model can distinguish real inquiries from spam.
  const leadNames = vcita?.leadSamples
    ?.filter(l => l.name?.trim() && l.name !== 'Unnamed client')
    .slice(0, 5)
    .map(l => l.email ? `${l.name} (${l.email})` : l.name) ?? [];

  // Build snapshot — mask revenue fields for Z clients
  const vcitaSnapshot = vcita
    ? hasFullBMP
      ? {
          totalLeads: vcita.totalLeads,
          newLeads: vcita.newLeads,
          recentLeadNames: leadNames.length > 0 ? leadNames : null, // named anecdotes
          openInvoices: vcita.openInvoices,
          totalRevenue: vcita.totalRevenue,
          activePipeline: vcita.activePipeline,
          upcomingBookings: vcita.upcomingBookings,
          conversations: vcita.conversations,
          invoiceSample: vcita.invoiceItems?.slice(0, 3),
          // Named estimates — real client names on real open proposals. Use these in
          // the loss narrative: "a $X quote to [name] disappears from your pipeline Day 1."
          // Only present when the client has active estimates with named contacts.
          estimateSample: vcita.estimateItems
            ?.filter(e => e.client && (e.status === 'sent' || e.status === 'approved' || e.status === 'viewed'))
            .slice(0, 3)
            .map(e => ({ client: e.client, amount: e.amount, status: e.status, label: e.label }))
            .filter(e => e.client) ?? [],
        }
      : {
          // Z (Lead Nurturing only) — payment/revenue fields deliberately excluded
          totalLeads: vcita.totalLeads,
          newLeads: vcita.newLeads,
          recentLeadNames: leadNames.length > 0 ? leadNames : null, // named anecdotes
          upcomingBookings: vcita.upcomingBookings,
          conversations: vcita.conversations,
        }
    : null;

  // Billing event history — last 12 months, for financial eligibility context
  // Date format from Falcon: MM/DD/YYYY
  const twelveMonthsAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
  const recentBillingEvents = (client.billingEvents ?? [])
    .filter(e => {
      if (!e.date) return false;
      const parts = e.date.split('/');
      if (parts.length !== 3) return false;
      const dt = new Date(`${parts[2]}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`);
      return !isNaN(dt.getTime()) && dt >= twelveMonthsAgo;
    })
    .slice(0, 15);

  const commitmentTerms = client.subscription?.commitmentTerms ?? null;
  const contractLengthMonths = commitmentTerms?.contractLengthMonths ?? null;
  const contractEndDate = commitmentTerms?.contractEndDate ?? null;
  const scheduledCancellation = client.subscription?.scheduledCancellation ?? null;

  // Best available "when can they actually cancel" date:
  // 1. contractEndDate (direct from Falcon commitmentTerms — most authoritative for active contracts)
  // 2. scheduledCancellation.pendingCancelDate (when the system has scheduled it to take effect)
  // 3. null (M2M or unknown)
  const effectiveCancelDate = contractEndDate
    || scheduledCancellation?.pendingCancelDate
    || null;

  const isInCommitment = effectiveCancelDate ? new Date(effectiveCancelDate) > new Date() : false;
  const daysRemainingInCommitment = isInCommitment && effectiveCancelDate
    ? Math.ceil((new Date(effectiveCancelDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : 0;

  const snapshot = JSON.stringify({
    client: {
      name: client.name,
      market: client.tsiMarket,
      status: client.status,
      monthlyPrice: client.price,
      tenureMonths,
      serviceKeys,
      contractTerms: {
        contractLengthMonths: contractLengthMonths ?? 1,
        contractType: contractLengthMonths === 6 ? '6-month' : contractLengthMonths === 3 ? '3-month' : 'month-to-month',
        contractEndDate: contractEndDate ?? null,
        effectiveCancelDate,
        isInCommitment,
        daysRemainingInCommitment: isInCommitment ? daysRemainingInCommitment : null,
        scheduledCancellationStatus: scheduledCancellation?.cancelStatus ?? null,
        note: isInCommitment
          ? `CLIENT CANNOT CANCEL YET — in a ${contractLengthMonths}-month commitment. Earliest cancellation: ${effectiveCancelDate}. ${daysRemainingInCommitment} days remaining. This means MORE TIME to win them back — pitch energy should be patient and confident, not panicked.`
          : contractLengthMonths && contractLengthMonths > 1
            ? `Client completed their ${contractLengthMonths}-month commitment and is now month-to-month — they can cancel at any time.`
            : 'Client is month-to-month — can cancel at any time.',
      },
      subscribedProducts: {
        website: hasWebsite,
        seo: hasSEO,
        directoryListings: hasListings,
        fullBMP_withPayments: hasFullBMP,
        liteBMP_noPayments: hasLiteBMP,
        social: hasSocial,
      },
      launchDate: client.subscription?.launchDate,
    },
    // dataErrors tells you WHY a platform field is null — data fetch failed vs. product not subscribed.
    // IMPORTANT: null data with no corresponding error means the platform returned successfully but empty.
    // null data WITH an error means the fetch itself failed. Neither means the product is absent.
    dataErrors: Object.keys(data.errors ?? {}).length > 0 ? data.errors : null,
    gbp: gbp
      ? {
          businessImpressions: gbp.businessImpressions,
          mapImpressions: gbp.mapImpressions,
          searchImpressions: gbp.searchImpressions,
          callClicks: gbp.callClicks,
          websiteClicks: gbp.websiteClicks,
          directionRequests: gbp.directionRequests,
          postsLive: gbp.postsLive,
          periodStart: gbp.periodStart,
          periodEnd: gbp.periodEnd,
          // Actual search terms customers used to find this business on Google.
          // Use these to make the impression count concrete: "X people searched
          // '[keyword]' and found you." Local-specific without competitor naming.
          searchKeywords: gbp.searchKeywords ?? null,
        }
      : null,
    reviews: gbpReviews?.length
      ? {
          total: gbpReviews.length,
          averageRating: avgRating,
          // comment and reviewer are included so the analyst can quote actual customer language
          // in the retention narrative — far more compelling than bare star counts.
          samples: gbpReviews.slice(0, 3).map(r => ({
            rating: r.rating,
            hasReply: r.hasReply,
            reviewer: r.reviewer !== 'Anonymous' ? r.reviewer : null,
            comment: r.comment ? r.comment.slice(0, 150).trim() : null,
          })),
        }
      : null,
    website: (hasWebsite || hasSEO) && duda
      ? {
          pageViews: duda.pageViews,
          uniqueVisitors: duda.uniqueVisitors,
          visits: duda.visits,
          totalPages: duda.totalPages,
          siteUpdatesCount: duda.siteUpdates?.length ?? 0,
          publishedPostsCount: duda.publishedPosts?.length ?? 0,
          lastPublished: duda.lastPublished,
        }
      : null,
    listings: hasListings && yext
      ? {
          syncedListings: yext.syncedListings,
          totalListings: yext.totalListings,
          impressions: yext.impressions,
          actions: yext.actions,
          accuracy: yext.accuracy,
          actionBreakdown: yext.actionBreakdown
            ? {
                tapToCall: yext.actionBreakdown.tapToCall,
                drivingDirections: yext.actionBreakdown.drivingDirections,
                website: yext.actionBreakdown.website,
              }
            : null,
          periodNote: `All metrics cover the last ${periodDays} days`,
        }
      : null,
    pipeline: (hasFullBMP || hasLiteBMP)
      ? vcitaSnapshot
      : null,
    social: hasSocial && soci
      ? {
          upcomingPostCount: soci.upcomingPostCount,
          recentlySentCount: soci.recentlySentCount,
          scheduledNetworks: soci.scheduledNetworks,
          // Engagement analytics
          pageFans28day: soci.fbInsights?.pageFans28day ?? null,
          pageFansChangePct28day: soci.fbInsights?.pageFansChangePct28day ?? null,
          pageImpressions28day: soci.fbInsights?.pageImpressions28day ?? null,
          pageImpressionsChangePct28day: soci.fbInsights?.pageImpressionsChangePct28day ?? null,
          pageEngagedUsers28day: soci.fbInsights?.pageEngagedUsers28day ?? null,
          pagePostEngagements28day: soci.fbInsights?.pagePostEngagements28day ?? null,
          sentiment: soci.sentiment ?? null,
          topPosts: soci.topPosts.slice(0, 3).map(p => ({
            message: p.message,
            impressions: p.impressions,
            engagedUsers: p.engagedUsers,
          })),
        }
      : hasSocial ? null : 'not_subscribed',
    activities: activities
      ? {
          openTickets: activities.openTickets,
          resolvedThisPeriod: activities.resolvedThisPeriod,
          totalThisPeriod: activities.totalThisPeriod,
          callsThisPeriod: activities.callsThisPeriod,
        }
      : null,
    // Billing events from the last 12 months — use to assess financial concession eligibility
    // Key: max 2 financial offerings per 12-month rolling period; no back-to-back
    billingHistory: recentBillingEvents.length > 0 ? recentBillingEvents : null,
    pipelineAtRisk,
    tenureMonths,
    periodDays,
    currentDate: `${currentMonth} ${currentYear}`,
    agentCancelNotes: agentNotes || null,
  }, null, 2);

  const context = getRetentionContext(false); // skip Notes section for token budget

  // Build the insights section list based on what products are subscribed
  const insightSections: string[] = ['gbp']; // GBP is always evaluated
  if (hasListings) insightSections.push('listings', 'reputation');
  if (hasWebsite || hasSEO) insightSections.push('website');
  if (hasFullBMP || hasLiteBMP) insightSections.push('pipeline');
  if (hasSocial) insightSections.push('social');

  const insightsSpec = insightSections.map(s => `    { "section": "${s}", "coreArgument": "...", "keyDataPoints": ["..."], "urgencyLevel": "high|medium|low", "urgencyReason": "..." }`).join(',\n');

  return `You are a senior retention analyst at Townsquare Interactive (TSI). A small business client has submitted a cancellation request. Your job is to reason carefully about their specific situation — their business type, their market, the season, their actual data — and build the most compelling, bespoke retention case possible.

${context}

---

## CLIENT DATA (${periodDays} days ending today, ${currentMonth} ${currentYear})

${snapshot}

---

## WHAT YOU MUST PRODUCE

Analyze this data from every angle and return a JSON object. The brief you generate will be read by a live retention agent on a phone call. It must feel like it was written specifically for this client, not generated from a template.

Before writing anything, reason through:
1. **What business is this?** What vertical, what service area, what kind of customer base? Name the specific trade or service — "painting contractor" not "home services", "industrial welding fabricator" not "trades business", "tattoo studio" not "personal services."
2. **What is the REAL seasonal pattern for this specific vertical in ${currentMonth}?** This is the most commonly botched step. Do not default to "peak season." Go through this checklist:
   - Is this a business where demand is genuinely tied to weather, tax cycles, holidays, or a specific buying window? Name the specific driver.
   - TRUE high-seasonality verticals: exterior contractors (painting, roofing, concrete, landscaping — weather-dependent), HVAC (summer heat + winter cold), tax prep (Jan–Apr), pool services (May–Sep)
   - MODERATE seasonality: restaurants, retail, auto services, moving companies
   - LOW / FLAT seasonality: tattoo studios, mobile repair, electricians, plumbers, urgent care, most professional services, salons, gyms
   - If you cannot name a SPECIFIC reason why ${currentMonth} is peak or off-peak for THIS exact vertical, classify it as moderate or flat and make a year-round visibility argument instead
   - The test: could you copy your seasonalContext paragraph and paste it onto a different business in a completely different vertical? If yes, it's not specific enough — rewrite it.
3. **What does the data actually say?** Not just what's missing — what's working, what's trending?
4. **Why are they really canceling?** Use the agent notes, the payment status, and the activity signals to infer the real reason.
5. **What would actually change their mind?** For this specific client, in this specific situation?
6. **Who are they actually competing against?** For this vertical in this market — is it other local independents, national franchises, word-of-mouth referrals, Angi/HomeAdvisor listings? What makes digital search visibility specifically valuable vs. their other options for getting new customers?

**NULL DATA ≠ ABSENT PRODUCT — READ THIS FIRST:**
- \`subscribedProducts\` is the ONLY source of truth for what this client has. Trust it absolutely.
- If a platform data field is null (e.g., gbp: null, website: null, listings: null), it means the data FETCH FAILED or we couldn't resolve the account — it does NOT mean the client lacks that product.
- NEVER say "no active products", "no website", "no listings", or anything implying the client isn't subscribed, based on null data. Only conclude a product is absent if subscribedProducts explicitly shows false.
- When subscribed but data is null: note that "data was unavailable for this period" and pivot to what IS available (vcita leads, activities, reviews, service keys, tenure).

**DEMYSTIFY EVERY METRIC — REQUIRED:**
Never state a raw number without its plain-English business impact. A retention agent is on a phone call with a small business owner who doesn't know what "impressions" or "actions" mean.
- BAD: "385 GBP call clicks"
- GOOD: "385 people found your phone number on Google and called it — that's 385 potential customers who tried to reach you directly"
- BAD: "247 direction requests"
- GOOD: "247 people asked Google Maps to navigate to your location — those are customers actively trying to find your door"
- BAD: "12 new leads in vcita"
- GOOD: "12 people submitted inquiry forms or reached out through your website asking about your services"
This applies everywhere: GBP, Yext, Duda, vcita, SOCI. Every number gets a "that means..." translation.

**NAMED LEAD ANECDOTES — USE THEM, BUT FILTER SPAM FIRST:**
If recentLeadNames is present in the pipeline/vcita data, reference actual names when discussing lead activity. "People like [name] and [name] have reached out..." is more compelling than "12 leads came in." Use names only in the analyst output — the formatter will use them in the agent script. Never make up names; only use what's in recentLeadNames.

IMPORTANT — vcita leads include real client inquiries AND vendor spam (people trying to sell services TO the SMB client, not buy from them). Before referencing a name, apply judgment:
- SKIP: leads with emails like info@, marketing@, sales@, contact@, hello@, team@, or any address that reads like a business outreach account
- SKIP: leads where the name is a company name or generic title rather than a personal first + last name
- SKIP: leads that are clearly vendors (e.g., "SEO Services LLC", "We Help You Get More Reviews")
- USE: leads with a personal first/last name and a personal-looking email (gmail, outlook, yahoo, or a local business domain)
Better to reference 1 real customer lead than 4 names where some are spam.

**ESTIMATE CLIENT NAMES — HIGHEST-IMPACT SPECIFICITY (V-key clients only):**
If estimateSample is present in the pipeline data, these are real proposals out to real named contacts. Use them directly in lossAssets. Format: "A $[amount] quote to [client name] is sitting in your pipeline right now — that disappears on Day 1 of cancellation." This is far more powerful than a dollar total alone. Never fabricate names or amounts; only use what is in estimateSample.

**REVIEW TEXT — QUOTE THE CLIENT'S OWN CUSTOMERS:**
If reviews.samples contains comment text and reviewer names, use actual review language in the narrative. A business owner recognizes their own customers' words immediately. Use format: "[Reviewer] left a 5-star review saying '[quote]' — that's the reputation you've built in [market]." Truncate naturally at a sentence boundary. Never paraphrase or fabricate; only quote verbatim from the comment field. Skip if comment is null.

**SEARCH KEYWORDS — MAKE IMPRESSIONS LOCAL AND SPECIFIC:**
If gbp.searchKeywords is present, translate the impression count using the actual search terms: "In the last [period], people searching '[top keyword]' and '[second keyword]' found your business on Google — that's real local demand for exactly what you do." This grounds the impression count in actual customer behavior instead of an abstract number. Use the top 1-2 keywords by impression count. Never invent keywords; only use what is in searchKeywords.

**COMPETITIVE POSITION — RELATIVE STANDING, NOT COMPETITOR NAMES:**
Do not attempt to name specific competitors. The brief has no data about actual competitor businesses. Instead, frame the competitive argument as relative market position: describe what happens to this client's standing when they go inactive versus the field of competitors in their category who stay active. Use the vertical benchmarks below to rate whether this client's metrics are above/at/below healthy for their vertical and tenure tier — then state that explicitly. "At 18 months, healthy [vertical] businesses in competitive markets typically have [X]. You're at [Y] — [above/at the low end of/below] that range." That is a statement with weight the agent can repeat on the call.

**TICKET CONTEXT — CRITICAL:**
The activities snapshot (openTickets, recentTickets) reflects only SERVICE tickets — Cancellation Request tickets have already been stripped out. However, when referencing open tickets as service gaps or work items:
- NEVER tell the agent to "close the cancellation ticket" or "resolve the open cancellation request" — that is the very ticket that triggered this pipeline. It is not a service failure.
- If openTickets > 0, the tickets are genuine support issues. Reference them as follow-up items for the CSR team, not as something the retention agent needs to close on this call.
- Do NOT imply the cancellation decision is linked to an open ticket unless the agentCancelNotes explicitly say so.

**CONTRACT VS M2M MODE:**
- If contractTerms.isInCommitment === true: This changes everything. The agent has TIME. The pitch should be patient and confident — the client literally cannot cancel right now, so the goal is to repair the relationship during the commitment window, not panic-sell. Surface this prominently. The lossAssets and opportunityActions should reinforce what they're investing in during this period.
- If M2M: Normal urgency applies — they can leave today.

**SERVICE KEY ENFORCEMENT:**
- Only generate insights for products listed in subscribedProducts as true
- Do NOT reference revenue, pipeline dollars, invoices, or payments for a liteBMP client (Z key)
- Do NOT generate website/SEO insights if neither W nor O is in serviceKeys
- Do NOT generate listings/reputation insights if Y is not in serviceKeys
- For social (S key): use upcomingPostCount, recentlySentCount, and scheduledNetworks to assess how active the social pipeline is. Note: engagement metrics (likes, reach, impressions) are not available — focus on pipeline activity (posts scheduled, networks covered).

Return this JSON structure:

{
  "clientProfile": "1 solid paragraph: who is this client, what business do they run, how long with TSI, what does their data say about how the business is performing. Be specific.",
  "cancellationRisk": "your inferred read on why they're canceling — use data signals, payment status, ticket history, agent notes to infer the real reason",
  "cancelReasonAnchor": "if agentCancelNotes contains a reason, explain in 1-2 sentences how that reason should frame the ENTIRE pitch — what angle to lead with. null if no notes.",
  "topRetentionHook": "the single most compelling specific argument for this client — the thing an agent should say in the first 30 seconds",
  "verticalContext": "2-3 sentences specific to THIS trade/vertical — not generic small business language. Name who their customers are and how they find new ones (Google search? referrals? Angi/HomeAdvisor? drive-by?). Describe the competitive dynamic as relative market position: what happens to their Google standing when they go inactive while competitors in their category stay active. Explain specifically why digital search presence matters for THIS type of business. Use the vertical benchmark table to explicitly state whether this client's key metrics are above/at/below healthy for their vertical and tenure tier — include the actual threshold and actual value. A reader should not be able to swap this paragraph onto a different vertical without rewriting it.",
  "competitiveBenchmark": "1 sentence only. State the client's relative standing explicitly: '[Client] is [above/at/below] healthy for a [vertical] business at [tenure] months. Healthy at this stage means [specific metric threshold from the benchmark table]; they are at [actual value].' Use actual numbers from the data and actual thresholds from the benchmark table. If the vertical isn't in the benchmark table, use tenure-based reasoning instead.",
  "seasonalContext": "2-3 sentences. REQUIRED: explicitly state HIGH/MODERATE/LOW seasonality for this vertical, then back it up with a specific reason. HIGH = name the exact demand driver (e.g. 'exterior painting season runs April-October because homeowners won't book during freeze risk'). LOW/MODERATE = say so plainly ('tattoo studios see flat demand year-round — there is no meaningful seasonal hook here'). Then state whether canceling in ${currentMonth} specifically is good or bad timing for this business, and why. NEVER claim peak season without a named specific driver. If this paragraph could apply to a different vertical, it is not acceptable — rewrite it.",
  "opportunityActions": [
    {
      "title": "short label for this improvement",
      "description": "specific thing TSI can do — actionable, not vague",
      "expectedImpact": "what improvement should the client expect and roughly when"
    }
  ],
  "lossAssets": [
    {
      "asset": "what they'd lose — be specific to their actual data (e.g. '847 Google impressions/month' not just 'Google presence')",
      "disappearsBy": "Day 1 | Within 7 days | Within 30 days | Within 90 days",
      "impact": "specific consequence for THIS business type in THIS market"
    }
  ],
  "insights": [
${insightsSpec}
  ],
  "pipelineAtRisk": ${pipelineAtRisk},
  "tenureMonths": ${tenureMonths},
  "monthlyPrice": ${client.price ?? 0},
  "serviceKeys": ${JSON.stringify(serviceKeys)}
}

Rules:
- opportunityActions: 2–4 specific, actionable items. These are promises TSI is making to improve. Make them realistic and grounded in the actual data gaps.
- lossAssets: 3–6 items, ordered by timing (Day 1 first). Use actual numbers from their data where possible.
- insights: only for subscribed products (${insightSections.join(', ')}). Use real numbers. High urgency should be reserved for genuine gaps, not used on everything.
- Return only the JSON object.`;
}

export async function runAnalyst(
  data: FetchedData,
  periodDays: number,
  agentNotes = ''
): Promise<AnalystOutput> {
  const apiKey = getAnthropicApiKey();

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(120_000), // 2-min hard cap — fail fast, don't hang the pipeline
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 6000,
      messages: [{ role: 'user', content: buildAnalystPrompt(data, periodDays, agentNotes) }],
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`Analyst (Sonnet) error: ${response.status} ${response.statusText}${errBody ? ` — ${errBody.slice(0, 200)}` : ''}`);
  }

  const result = await response.json() as { content: Array<{ type: string; text: string }> };
  const text = result.content?.[0]?.text;
  if (!text) throw new Error('Empty response from analyst');

  try {
    // Strip markdown code fences if present, then extract { ... } block
    const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    const match = stripped.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON object found in response');
    return JSON.parse(m
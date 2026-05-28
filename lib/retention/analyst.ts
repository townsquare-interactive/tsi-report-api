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
    // TSI service contact story — built from Falcon clientServicingInformation
    // LAC = lastAttemptedContact (every call dial, including voicemails and no-answers)
    // LCR = responded (date the client actually picked up and had a real conversation with TSI)
    // These are the authoritative contact signals — NOT ticket updatedAt
    servicing: client.servicing
      ? {
          // LAC / LCR contact story — use these to frame contact narrative
          lastAttemptedContact: client.servicing.lastAttemptedContact,
          daysSinceLAC: client.servicing.lastAttemptedContact
            ? Math.floor((Date.now() - new Date(client.servicing.lastAttemptedContact).getTime()) / (1000 * 60 * 60 * 24))
            : null,
          lastClientResponse: client.servicing.responded,
          daysSinceLCR: client.servicing.responded
            ? Math.floor((Date.now() - new Date(client.servicing.responded).getTime()) / (1000 * 60 * 60 * 24))
            : null,
          lastValueProvided: client.servicing.lastValueProvided,
          teamDivision: client.servicing.teamDivision,
          // CSL = Customer Success Lead (pooled service rep assigned to this account)
          // These are the humans responsible for the monthly value touch
          serviceTeam: client.servicing.serviceTeam.map(m => ({
            name: m.name,
            role: m.role?.label ?? null,
          })),
        }
      : null,
    // contentGenActivity = Client Hub automation only (Geo, FAQ, Blog pages)
    // This is NOT the full content picture — Duda is the source of truth for all site content
    // null here does NOT mean no content was published; it means the automation tool wasn't used
    contentGenActivity: client.contentGenActivity
      ? {
          lastCompletedAt: client.contentGenActivity.lastCompletedAt,
          lastPageType: client.contentGenActivity.lastPageType,
          note: 'This reflects Client Hub automation only (Geo/FAQ/Blog). Duda page inventory below shows the full site content picture.',
        }
      : null,
    // paymentStatus — CURRENT | PAST_DUE (null until Falcon dev resolves permissions)
    paymentStatus: client.paymentStatus,
    // Duda page inventory — full list of site pages with title and path
    // Classify into: service pages (what they offer), geo pages (city/area targeting),
    // FAQ pages (Q&A content), blog posts, and other
    // Use this to give SPECIFIC content improvement recommendations (not just "add more pages")
    websitePageInventory: (hasWebsite || hasSEO) && duda?.pages?.length
      ? duda.pages.slice(0, 30) // cap at 30 to stay in context budget
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

**GBP ZERO vs. UNAVAILABLE — CRITICAL DISTINCTION:**
- GBP data = null → the GBP fetch FAILED or the account is unresolved. Flag this as a setup issue needing investigation. Do NOT say "your GBP shows zero impressions." The correct framing is "we couldn't pull your Google data — there may be an account connection issue we need to resolve."
- GBP data = present but zeros (impressions=0, callClicks=0) → real performance data. These are genuine zeros meaning the profile is active but generating no traffic. This IS a content/optimization gap, and is something TSI can actively work on. Say so specifically.
- Never conflate these two — one is a fetch failure, one is a performance opportunity.

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

**CONTACT STORY — USE LAC/LCR, NOT TICKET DATES:**
The \`servicing\` field contains the authoritative contact dates:
- \`lastAttemptedContact\` (LAC) = the most recent date TSI called this client, even if they left a voicemail or got no answer
- \`lastClientResponse\` (LCR) = the most recent date the client actually picked up and held a real conversation
- \`daysSinceLAC\` / \`daysSinceLCR\` = computed days from today

Framing rules:
- If daysSinceLAC is LOW (TSI has called recently) but daysSinceLCR is HIGH (client hasn't responded): this is a client-avoidance pattern. TSI is doing their job. Frame it as: "We've been in contact regularly — you haven't had a chance to respond yet. This call is important."
- If daysSinceLAC is HIGH (TSI hasn't called recently): this is a TSI service gap. Flag it honestly but do NOT suggest it as a cancellation reason. Instead, frame it as something TSI will commit to improving: "I'm reaching out because I want to make sure you've been getting the attention you deserve."
- NEVER frame contact as "TSI hasn't contacted you in X days" in a mea-culpa tone. Instead frame as what TSI will do going forward.
- The teamDivision / serviceTeam tells you WHO the CSL is — use their name if available: "I'm [CSL name], your dedicated account rep" is more personal.
- CSL (Customer Success Lead) proactive calls are normal service cadence, not evidence of a problem. Billing collection calls are NOT value-add contact — don't count those.

**BILLING DECLINE FRAMING:**
If paymentStatus = "PAST_DUE" or agentCancelNotes mention billing issues:
- The primary goal becomes: fix the payment situation first, then save the account.
- Frame the conversation as: "Before we talk about whether to stay, let's make sure we can actually keep the account active. Our billing team can work with you on the balance — would it help to have that conversation first?"
- Do NOT treat billing decline as a reason to skip S1 and go straight to discounts. Fix-payment-first, then value conversation.
- Billing decline + long-term client = likely cashflow issue, not a value dissatisfaction issue. Distinguish these.

**NO MEA CULPA — CRITICAL:**
NEVER write language that implies TSI failed this client as a stated fact, especially in the opportunity section. This includes:
- "We haven't touched your content in 30 days" → DO NOT write this unless you have explicit proof from Duda page history
- "We dropped the ball on your GBP" → DO NOT write this
- "We should have been in better contact" → DO NOT write this
- Any sentence that begins with "I want to apologize" or similar
These statements undermine the agent's confidence and signal to the client that cancellation might be justified. If TSI genuinely has a service gap (verified by data), the gap-auditor flags it separately for the CSR team. The analyst's job is to build the strongest case for staying, not to confess.

INSTEAD of mea culpa, use forward-looking commitments: "Here's what we're going to do in the next 30 days." That's empowering, not apologetic.

**CONTENT INTELLIGENCE — BE SPECIFIC:**
When recommending content improvements, name the specific type, not just "add more pages":
- SERVICE PAGES: "We'll publish a dedicated page for [specific service]" (e.g., "emergency HVAC repair" not "services")
- GEO PAGES: "We'll add a [City] page so you appear in local searches for [City] + [service]"
- FAQ PAGES: "A Q&A page on '[common question in this vertical]' captures people researching before they call"
- HYPER-LOCAL BLOG: "A blog post like 'Best time to repaint your [city] home' builds topical authority for local search"
- The websitePageInventory field shows the actual current pages — reference what's already there and what specific type is missing. "You have 3 service pages — we'll add 2 geo pages and 1 FAQ page this month."
- Old clients (high tenureMonths) may have 
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

  // ── Pre-computed interpretations: prevent the model from misreading data signals ──

  // Contact story: distinguish client avoidance from TSI service gap
  // The model frequently misreads high LCR (client not responding) as a TSI failure
  // We pre-compute this so the model has the correct interpretation injected as fact
  const lacDate = client.servicing?.lastAttemptedContact ?? null;
  const lcrDate = client.servicing?.responded ?? null;
  const daysSinceLACPrecomputed = lacDate
    ? Math.floor((Date.now() - new Date(lacDate).getTime()) / (1000 * 60 * 60 * 24))
    : null;
  const daysSinceLCRPrecomputed = lcrDate
    ? Math.floor((Date.now() - new Date(lcrDate).getTime()) / (1000 * 60 * 60 * 24))
    : null;

  let contactStoryInterpretation: 'client_avoidance' | 'tsi_gap' | 'healthy' | 'unknown' = 'unknown';
  let contactStoryExplanation = 'No contact data available.';
  if (daysSinceLACPrecomputed !== null) {
    if (daysSinceLACPrecomputed <= 30 && (daysSinceLCRPrecomputed === null || daysSinceLCRPrecomputed >= 120)) {
      contactStoryInterpretation = 'client_avoidance';
      contactStoryExplanation = `TSI attempted contact ${daysSinceLACPrecomputed} days ago. Client last responded ${daysSinceLCRPrecomputed ?? 'never recorded'} days ago. TSI IS calling — the client is not answering. This is CLIENT AVOIDANCE, not a TSI service failure. Do not frame this as TSI dropping the ball.`;
    } else if (daysSinceLACPrecomputed > 45) {
      contactStoryInterpretation = 'tsi_gap';
      contactStoryExplanation = `TSI's last contact attempt was ${daysSinceLACPrecomputed} days ago. This IS a TSI service gap — outreach cadence is insufficient.`;
    } else {
      contactStoryInterpretation = 'healthy';
      contactStoryExplanation = `TSI contacted ${daysSinceLACPrecomputed} days ago. Contact cadence is adequate.`;
    }
  }

  // Website publish interpretation: prevent UNPUBLISHED from being read as "never published"
  // When a client cancels, TSI unpublishes the site — so UNPUBLISHED ≠ setup failure
  const dudaLastPublishedDays = duda?.lastPublished
    ? Math.floor((Date.now() - new Date(duda.lastPublished).getTime()) / (1000 * 60 * 60 * 24))
    : null;
  let websitePublishInterpretation = 'no_data';
  // If the client account is cancelled/cancelling, an UNPUBLISHED site with no lastPublished
  // is almost certainly a post-cancellation artifact — TSI unpublishes on cancel.
  // Never conclude the site was never live when the account is in a cancelled state.
  const accountIsCancelled = client.status?.toLowerCase().includes('cancel') ||
    (client.cancellationHistory ?? []).some(e =>
      e.event?.toLowerCase().includes('cancel') &&
      new Date(e.date).getTime() > Date.now() - 30 * 24 * 60 * 60 * 1000
    );
  if (duda) {
    if (dudaLastPublishedDays !== null && dudaLastPublishedDays <= 60) {
      websitePublishInterpretation = `RECENTLY_ACTIVE: Site was published ${dudaLastPublishedDays} days ago. The current inactive status is likely a post-cancellation artifact. DO NOT treat as a setup failure or say the site was never live. The site built ${tenureMonths} months of SEO equity.`;
    } else if (accountIsCancelled && dudaLastPublishedDays === null) {
      websitePublishInterpretation = `POST_CANCEL_UNPUBLISHED: Account is in cancelled/cancelling status and the site has no publish date — this means TSI unpublished the site as part of cancellation processing. The site WAS live during the client's ${tenureMonths}-month tenure. DO NOT say the site was never published or never visible. Say the site is currently inactive due to the cancellation process.`;
    } else if (dudaLastPublishedDays !== null && dudaLastPublishedDays <= 180) {
      websitePublishInterpretation = `STALE: Last published ${dudaLastPublishedDays} days ago. Content cadence gap — not a structural setup failure.`;
    } else if ((duda.visits ?? 0) > 0 || (duda.pageViews ?? 0) > 0) {
      websitePublishInterpretation = `HAS_TRAFFIC: Site shows traffic (${duda.visits} visits, ${duda.pageViews} page views) so it was live. Do not conclude it was never published.`;
    } else if (dudaLastPublishedDays === null && tenureMonths <= 3) {
      websitePublishInterpretation = `POSSIBLY_NOT_PUBLISHED: No publish date, no traffic, account is ${tenureMonths} months old. May be a setup issue — flag for investigation but do not state as fact.`;
    } else {
      websitePublishInterpretation = `UNKNOWN: No recent publish date. Traffic data unavailable. Structural investigation needed — do not assert the site was never live.`;
    }
  }

  // Pitch frame: determines how Section 1 must open
  const daysUntilCancel = effectiveCancelDate
    ? Math.ceil((new Date(effectiveCancelDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : 999;
  const isPastDue = client.paymentStatus === 'PAST_DUE';
  // Also detect billing_first from cancel reason text — paymentStatus may not reflect the decline yet
  const cancelReasonImpliesBilling = !!(
    agentNotes?.toLowerCase().match(/billing|decline|chargeback|payment fail|ach|non.?pay|past.?due/i) ||
    scheduledCancellation?.reason?.toLowerCase().match(/billing|decline|chargeback|payment fail|ach|non.?pay/i)
  );
  const hasNamedCompetitor = !!(
    scheduledCancellation?.competitor ||
    agentNotes?.toLowerCase().match(/hibu|scorpion|thryv|yelp|reachlocal|vendasta|seo|marketing agency/i)
  );

  type PitchFrame = 'billing_first' | 'competitive_defense' | 'service_gap_own_and_fix' | 'value_proof' | 'urgency_window' | 'relationship_save';
  let pitchFrame: PitchFrame;
  if (isPastDue || cancelReasonImpliesBilling) {
    pitchFrame = 'billing_first';
  } else if (daysUntilCancel <= 7) {
    pitchFrame = 'urgency_window';
  } else if (hasNamedCompetitor) {
    pitchFrame = 'competitive_defense';
  } else if (contactStoryInterpretation === 'client_avoidance' && (daysSinceLCRPrecomputed ?? 0) >= 365) {
    pitchFrame = 'relationship_save';
  } else if (contactStoryInterpretation === 'tsi_gap') {
    pitchFrame = 'service_gap_own_and_fix';
  } else {
    pitchFrame = 'value_proof';
  }

  // Saveability triage — computed from deterministic signals, not model reasoning
  // Purpose: help agents allocate effort; don't give a 30-min push to cases where graceful
  // offboarding is the better play (e.g. business closing, decision already finalized)
  const isClosingBusiness = !!(agentNotes?.toLowerCase().match(/closing|sold.*business|going.*out.*business|shut.*down/i));
  const isDecisionFinalized = !!(agentNotes?.toLowerCase().match(/already.*switch|already.*sign|already.*moved|decision.*final|decision.*made|committed.*to/i));
  const priorCancelCount = client.cancellationHistory?.filter(e =>
    /request/i.test(e.event ?? '')
  ).length ?? 0;
  const priorSaveCount = client.cancellationHistory?.filter(e =>
    /save|retain|kept/i.test(e.event ?? '')
  ).length ?? 0;

  type SaveabilityScore = 'High Save Probability' | 'Recoverable' | 'Likely Lost';
  let saveabilityScore: SaveabilityScore;
  // If Falcon already shows Cancelled Client status, this is a closed account — not a live save opportunity
  const alreadyCancelledInFalcon = client.status?.toLowerCase().includes('cancelled client') ||
    client.status?.toLowerCase() === 'cancelled';
  if (alreadyCancelledInFalcon) {
    saveabilityScore = 'Likely Lost';
  } else if (isClosingBusiness) {
    saveabilityScore = 'Likely Lost';
  } else if (isDecisionFinalized && hasNamedCompetitor && priorCancelCount >= 1) {
    saveabilityScore = 'Likely Lost';
  } else if ((isPastDue || cancelReasonImpliesBilling) && !isDecisionFinalized) {
    saveabilityScore = 'Recoverable'; // billing is fixable if not already walked
  } else if (priorCancelCount === 0 && !hasNamedCompetitor && !isClosingBusiness) {
    saveabilityScore = tenureMonths >= 12 ? 'High Save Probability' : 'Recoverable';
  } else if (priorCancelCount >= 2 && priorSaveCount === 0) {
    saveabilityScore = 'Likely Lost'; // repeat cancels with no successful saves
  } else {
    saveabilityScore = 'Recoverable';
  }

  const isInCommitment = effectiveCancelDate ? new Date(effectiveCancelDate) > new Date() : false;
  const daysRemainingInCommitment = isInCommitment && effectiveCancelDate
    ? Math.ceil((new Date(effectiveCancelDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : 0;

  const snapshot = JSON.stringify({
    client: {
      name: client.name,
      market: client.tsiMarket,
      status: client.status,
      vertical: client.vertical,         // e.g. "tree_service", "painting" — use for benchmark lookup
      gccDate: client.gccDate,           // onboarding call date (often null)
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
    // Cancellation intelligence — competitor and what was already tried in prior saves
    cancellationIntel: {
      // Named competitor from the current cancel request (may be blank string — check truthiness)
      competitor: scheduledCancellation?.competitor || null,
      // What save solutions were already offered in THIS cancel request (comma-separated)
      // CRITICAL: Do NOT recommend anything already on this list — it has already been tried
      saveSolutionsOffered: scheduledCancellation?.saveSolutions || null,
      // Prior cancel history — pattern matters (first-time vs. repeat canceller)
      priorCancelCount: client.cancellationHistory.filter(e => e.cancelStatus === 'cancel_request' || e.event?.toLowerCase().includes('initiated')).length,
      // Prior saves and what was offered each time
      priorSaves: client.cancellationHistory
        .filter(e => e.savedBy || e.savedAt || e.saveSolutions)
        .map(e => ({
          date: e.date,
          savedBy: e.savedBy,
          saveSolutions: e.saveSolutions,
          competitor: e.competitor || null,
        }))
        .slice(0, 3),
    },
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
    // ── Pre-computed interpretations (injected as facts — do NOT override these) ──
    _precomputed: {
      pitchFrame,
      saveabilityScore,
      alreadyCancelledInFalcon,  // client.status is "Cancelled Client" — closed account, not pending
      contactStory: {
        interpretation: contactStoryInterpretation,
        explanation: contactStoryExplanation,
      },
      websitePublishInterpretation,
    },
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

**HOLD ALL REASONING INTERNALLY — OUTPUT ONLY JSON:**
Do not write any analysis, reasoning, or explanation before the JSON object. Your ENTIRE response must begin with { and end with }. Any text outside the JSON will break the pipeline.

Reason through the following questions silently before writing the JSON — your answers inform the JSON fields but do NOT appear in your output:
1. What specific trade/service is this? (e.g. "exterior painting contractor", not "home services")
2. What is the real seasonal pattern for this vertical in ${currentMonth}? Is demand weather-driven, tax-cycle-driven, or flat year-round?
3. What does the data actually say? Not what's missing — what's working and what's trending?
4. Why are they REALLY canceling? Check the pitchFrame in _precomputed — it already tells you the primary driver.
5. What would actually change their mind for this specific client in this situation?
6. READ THE _precomputed BLOCK FIRST. The pitchFrame, contactStory.interpretation, and websitePublishInterpretation are pre-analyzed facts. Do NOT contradict them. Build your analysis from them.
7. READ THE TICKET CONVERSATIONS in agentCancelNotes carefully. Look for: prior complaints that were raised but never resolved, promises TSI made that weren't kept, the client's emotional tone (frustrated, resigned, open), and anything that was said but then NOT followed up on. This prior history shapes the entire opening posture for the call.
8. Are there contradictions between stated and implicit signals? Examples: says "too expensive" but has never missed a payment → real issue is probably service or trust, not price. Says "no ROI" but has strong GBP traffic → might be operational (not converting leads). Flagging the contradiction helps the agent listen for the real driver instead of arguing about the stated one.

**NULL DATA ≠ ABSENT PRODUCT — READ THIS FIRST. APPLIES TO EVERY PLATFORM:**

- \`subscribedProducts\` is the ONLY source of truth for what this client has. Trust it absolutely.
- Null OR zero data for a subscribed product = the API fetch failed or the account wasn't found. It NEVER means the product isn't set up, provisioned, or configured.
- NEVER say "no active products", "no website", "no listings", or any absence claim based on null or zero data alone.
- When subscribed but data is null OR zero: pivot to what IS available — never lead with what's missing.

**ZERO DATA IS NOT THE SAME AS NULL DATA — but both could be fetch failures:**
- Yext returning 0 synced listings with locationId=null does NOT mean listings weren't set up — it means Yext couldn't find the entity for this GPID this session. The listings ARE active.
- Duda returning null does NOT mean the website wasn't built — it means Duda lookup failed.
- vcita returning null or zero leads does NOT mean BMP was never configured — it means the API call failed.
- GBP null means the client hasn't granted TSI agency account manager access (see GBP section below).

**BANNED PHRASES for subscribed products with missing data:**
NEVER write: "never activated", "never set up", "not provisioned", "has a broken connection", "appears inactive", "never configured", "not connected" — for any product that is subscribed. Use: "data not available for this period" and move on.

**RESOURCEFULNESS — BUILD THE CASE FROM WHAT YOU HAVE:**
When platform data is unavailable, do not make absence the story. A good retention analyst makes a compelling case from whatever data exists. Use these pivot rules:

- **GBP null:** Lead with tenure months (every month = accumulated Google authority), total reviews if available, directory listing count, website visitors. Frame: "X months of Google authority built" even without current impression numbers.
- **Website UNPUBLISHED (check _precomputed.websitePublishInterpretation first):** If interpretation shows RECENTLY_ACTIVE, the site was live until recently — do NOT call it a setup failure. Say "the site is currently paused" and pivot to the equity built during active months. Only flag as a structural issue if interpretation shows POSSIBLY_NOT_PUBLISHED.
- **Yext null/timeout:** Use GBP visibility and website traffic as evidence of digital presence. Directory value argument: "synced listings across Google, Yelp, Apple Maps, Bing" from Falcon subscription data.
- **All platform data null:** Lead with tenure (months × monthly price = total investment), what rebuilding costs elsewhere (new website $3K-$8K, SEO 6–12 months to ramp, directories $100-$200/month separately), and the specific cancel date as urgency.
- **vcita null:** Skip pipeline section entirely. Focus on GBP leads and website traffic. Never make up lead counts.

**FACTUAL CONSTRAINTS — NEVER DO THESE:**
1. NEVER say a product was "never activated," "never set up," or "never used" from low usage data. Low engagement = client hasn't engaged fully. "Underutilized" is correct. "Never activated" is not.
2. NEVER conclude a website was "never live" from UNPUBLISHED status — always check \`_precomputed.websitePublishInterpretation\` first.
3. NEVER frame client non-response (high LCR) as a TSI service failure if \`_precomputed.contactStory.interpretation\` is "client_avoidance". TSI has been calling. The client isn't answering.
4. NEVER invent or round up metrics. "87 GBP impressions" is not "nearly 100." Use exact numbers or skip them.
5. NEVER use the word "activated" in the context of product setup. Use "engaged with" or "fully utilized" instead.
6. NEVER say social "was never set up" or "is not connected" when the client has the S service key. Social management IS active — data absence is a fetch failure.

**SOCIAL (S service key) — ALWAYS INCLUDE, USE DATA WHEN AVAILABLE:**
Never omit social from the brief when S is in the service keys.

When social has real data: use upcomingPostCount and scheduledNetworks as proof of active management, pageFans28day as audience built, pageImpressions28day as reach, topPosts for specific content that stops Day 1.

When social is null (S key subscribed but data unavailable): still include "Active social posting management across connected networks" as a Day 1 loss asset. Do NOT say social was never configured.

**GBP ZERO vs. UNAVAILABLE — CRITICAL DISTINCTION:**
- GBP data = null → TSI does not currently have management access to this client's Google Business Profile. This is a standard operational gap — the client needs to grant TSI's agency account manager access to their listing. It is NOT a TSI technical failure. The correct framing: "We don't currently have access to your Google Business Profile data — once you grant us manager access, we can start actively managing your listing and this becomes one of our strongest tools." NEVER say "GBP connection failed" or "GBP never set up" as if TSI dropped the ball — the client has not completed the access step yet.
- GBP data = present but zeros (impressions=0, callClicks=0) → real performance data. The profile is active but generating no traffic. This IS a content/optimization gap TSI can address. Say so specifically.
- Never conflate these two — one is a pending client action, one is a performance opportunity.

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

**DATA IS NEW INFORMATION, NOT A REBUTTAL — CRITICAL:**
When the stated cancel reason is "no ROI," "not seeing results," or "not worth it" — DO NOT frame data as an argument against their perception. Responding to "I'm not seeing results" with "but you have 720 visitors" argues with their experience and deepens the trust gap.

Instead, frame data as new information the client may not have seen: "I want to share something I'm not sure you've seen yet — [data point]. Let's look at it together." This invites them in rather than challenging them.

The gap between what the data shows and what the client perceives IS the retention case — close that gap by showing them the data, not debating their experience.

**OPENING POSTURE vs FACTS TO DEPLOY — keep these distinct:**
topRetentionHook should reflect the opening posture: the human, situational acknowledgment that sets the tone for the first 60 seconds. This is NOT a data point — it's reading the room. Example: "You reached out, which means something still feels unresolved — I want to make sure you have the full picture before any decision is made."

opportunityActions are the facts to deploy when the moment is right after acknowledgment — specific data points introduced as new information, not opening salvos.

**SEARCH KEYWORDS — MAKE IMPRESSIONS LOCAL AND SPECIFIC:**
If gbp.searchKeywords is present, translate the impression count using the actual search terms: "In the last [period], people searching '[top keyword]' and '[second keyword]' found your business on Google — that's real local demand for exactly what you do." This grounds the impression count in actual customer behavior instead of an abstract number. Use the top 1-2 keywords by impression count. Never invent keywords; only use what is in searchKeywords.

**COMPETITIVE POSITION — RELATIVE STANDING, NOT COMPETITOR NAMES:**
Do not attempt to name specific competitors. The brief has no data about actual competitor businesses. Instead, frame the competitive argument as relative market position: describe what happens to this client's standing when they go inactive versus the field of competitors in their category who stay active. Use the vertical benchmarks below to rate whether this client's metrics are above/at/below healthy for their vertical and tenure tier — then state that explicitly. "At 18 months, healthy [vertical] businesses in competitive markets typically have [X]. You're at [Y] — [above/at the low end of/below] that range." That is a statement with weight the agent can repeat on the call.
The \`client.vertical\` field contains the business type slug (e.g. "tree_service", "painting", "hvac") — use it to look up the correct benchmark row directly from the context tables below rather than guessing the vertical from the name or market.

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
- Old clients (high tenureMonths) may have legacy content from early in their subscription. Acknowledge what exists and suggest specific modern additions that would lift rankings now.

**COMPETITOR INTELLIGENCE:**
The primary source for competitor data is \`cancellationIntel.competitor\` — this is the competitor the client named directly in Falcon when submitting the cancellation request. Check this field first. If it is non-null and non-empty, that is the confirmed competitor.
Secondary source: agentCancelNotes or the cancel reason text may also mention a competitor by name.
Rules:
- If \`cancellationIntel.competitor\` is populated, use that exact name and include it in the competitors array. This is more reliable than notes-derived names.
- If agentCancelNotes mentions a different or additional competitor, include that one too.
- Use exact brand names in the competitors array (e.g., "Hibu", "Scorpion", "Thryv", "Yelp", "ReachLocal").
- Do NOT attack competitors by name in the agent brief. Instead, anchor to what TSI provides that generic alternatives don't: dedicated account management, integrated platform (GBP + Website + Listings + CRM in one managed service), local market expertise, human review response.
- Adjust the tone of opportunityActions to be differentiation-focused: "Here's what you'd lose that [competitor] doesn't offer."
- If no competitor is named in either source, return an empty array for competitors.

**SAVE SOLUTIONS — DO NOT REPEAT FAILED OFFERS:**
\`cancellationIntel.saveSolutionsOffered\` contains the retention solutions already offered to this client during the current cancellation request (comma-separated string from Falcon). This is what the team already tried. \`cancellationIntel.priorSaves[].saveSolutions\` shows what was offered in prior saves.
- CRITICAL: Do NOT recommend any solution that appears in \`saveSolutionsOffered\` or in \`priorSaves[].saveSolutions\`. If you recommend something that was already tried and failed, the agent will lose credibility on the call.
- If a discount or financial offer was already in \`saveSolutionsOffered\`, do NOT lead with another financial offer — pivot to value demonstration instead.
- Use the prior save history (\`priorSaves\`) to understand the pattern: repeat cancellers who have been saved with the same offer before need a fresh angle.
- If \`saveSolutionsOffered\` is null or empty, no constraint applies — recommend the strongest available option.

**CANCELLATION URGENCY:**
If scheduledCancellation.pendingCancelDate is within 7 days of today, or if the cancel reason implies immediate departure:
- Flag urgency explicitly in topRetentionHook — the agent needs to open with time sensitivity.
- Do NOT lead with the urgency as a threat. Instead: "I'm reaching out because your account is scheduled to close on [date] — I want to make sure you've seen everything before that happens."
- The value story (S1) still leads. Urgency sets the frame; the brief delivers the argument.

**SECOND CANCEL — TONE ADJUSTMENT:**
If cancellationHistory shows 1 or more prior cancel requests that were saved:
- Acknowledge the pattern implicitly in topRetentionHook — "We've had this conversation before" energy, but not accusatory.
- Lead with what's different now: new data points, recent improvements, the specific number that's changed.
- Do NOT repeat the same talking points from what might have saved them last time. Use fresh, specific data.

**FORWARD-LOOKING opportunityActions:**
opportunityActions are promises TSI is making — specific things that will happen if the client stays, not descriptions of current gaps.
- WRONG: "Your GBP impressions are low."
- RIGHT: "We'll audit your GBP category and publish 3 service posts this week to drive call clicks."
- WRONG: "Your website hasn't been updated."
- RIGHT: "We'll publish a dedicated [specific service] page within 5 business days."
Each action should be specific enough for an agent to read verbatim on the phone.

**CONFIDENT topRetentionHook:**
The topRetentionHook should be a data-backed statement the agent can say verbatim — not a vague claim.
- BAD: "Your digital presence is strong."
- GOOD: "In the last 90 days, [X] people searched '[top keyword]' and found your business — that's real demand for exactly what you do."
- BAD: "You have a lot to lose."
- GOOD: "You have a $[pipelineAtRisk] pipeline of active proposals in your CRM right now — that disappears on Day 1 of cancellation."
Pick the single most compelling statistic and build the hook around it.

The JSON object you return must include these additional fields at the root level:
- "pitchFrame": one of "billing_first" | "competitive_defense" | "service_gap_own_and_fix" | "value_proof" | "urgency_window" | "relationship_save" — MUST match _precomputed.pitchFrame unless you have strong evidence to deviate
- "contactStoryInterpretation": one of "client_avoidance" | "tsi_gap" | "healthy" | "unknown" — MUST match _precomputed.contactStory.interpretation
- "saveabilityScore": one of "High Save Probability" | "Recoverable" | "Likely Lost" — MUST match _precomputed.saveabilityScore

CRITICAL — ALREADY CANCELLED CLIENTS:
If _precomputed.alreadyCancelledInFalcon is true, the client is already cancelled in Falcon (status = "Cancelled Client"). This is NOT a pending cancellation — this is a closed account. Do NOT build a standard retention pitch. Instead:
- pitchFrame should still be used for tone, but acknowledge this is a reconnect/rescue situation
- cancelReasonAnchor should reflect that the account is already closed
- opportunityActions should focus on a win-back approach if appropriate, or acknowledge this may be too late
- The saveabilityScore will be Likely Lost — honor that in how you write the brief
- "competitors": array of named brand competitors (empty array if none named)
- "urgencyFlag": true if cancel date is within 7 days, false otherwise
- "cancellationType": brief label for the primary cancel driver (e.g. "billing_decline", "competitor_switch", "no_roi", "service_issue")

Rules:
- opportunityActions: 2–4 specific, actionable items. These are promises TSI is making to improve. Make them realistic and grounded in actual available data.
- lossAssets: 3–6 items, ordered by timing (Day 1 first). Use actual numbers from their data where possible.
- insights: only for subscribed products (${insightSections.join(', ')}). Use real numbers. Reserve high urgency for genuine gaps.
- Return only the JSON object.

**CRITICAL — OUTPUT FORMAT:**
Your ENTIRE response must be a single valid JSON object starting with { and ending with }. No reasoning text. No preamble. No explanation before or after. The JSON is the only output.`;
}

export async function runAnalyst(
  data: FetchedData,
  periodDays: number,
  agentNotes = ''
): Promise<AnalystOutput> {
  const apiKey = getAnthropicApiKey();

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(200_000), // 3.3-min hard cap — increased after prompt expansion in session 2
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
    // Strip markdown code fences if present
    const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    // Brace-match from the last } backwards to find the outermost JSON object.
    // This handles cases where the model outputs reasoning text before the JSON.
    const lastBrace = stripped.lastIndexOf('}');
    if (lastBrace !== -1) {
      let depth = 0;
      let start = -1;
      for (let i = lastBrace; i >= 0; i--) {
        if (stripped[i] === '}') depth++;
        else if (stripped[i] === '{') { depth--; if (depth === 0) { start = i; break; } }
      }
      if (start !== -1) {
        return JSON.parse(stripped.slice(start, lastBrace + 1)) as AnalystOutput;
      }
    }
    throw new Error('No JSON object found in analyst response');
  } catch (e) {
    throw new Error(`Analyst returned unparseable JSON: ${text.slice(0, 300)}`);
  }
}

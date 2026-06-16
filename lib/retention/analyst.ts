// Agent 2: Retention Analyst
//
// Model: claude-opus-4-8
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

  // GBP zero data quality — if all key metrics are zero, the API may have returned
  // a silent failure (zeros instead of an error). The model must NOT infer suspension,
  // setup failure, or TSI fault from zero data alone — that led to fabricated narratives.
  const gbpAllZeros = gbp !== null && gbp !== undefined &&
    (gbp.businessImpressions ?? 0) === 0 &&
    (gbp.callClicks ?? 0) === 0 &&
    (gbp.directionRequests ?? 0) === 0 &&
    (gbp.mapImpressions ?? 0) === 0;
  const gbpDataQuality: string | null = gbpAllZeros
    ? 'ALL_ZEROS: GBP returned all-zero metrics for every key dimension. DO NOT infer suspension, TSI setup failure, or inactive listing from zero data alone — zero GBP data most commonly indicates a silent API non-response (the endpoint returned 0 instead of an error). REQUIRED ACTION: treat gbp in the snapshot as null. Exclude GBP from analysis, opportunityActions, lossAssets, topRetentionHook, and insight sections. If the client has GBP subscribed, note only that GBP data was unavailable for this period — do NOT state or imply the listing is inactive, closed, or suspended.'
    : null;

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
    // dataErrors is FOR DEBUGGING ONLY — do NOT reference these in analysis, output fields, or agent scripts.
    // A platform error or null data tells you nothing about whether the product is set up or working.
    // If a platform has an error, treat it the same as null: omit that platform from your analysis.
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
      gbpDataQuality,
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

  return `You are a senior retention analyst at Townsquare Interactive (TSI). A client has submitted a cancellation request. Build the most compelling, bespoke retention case possible.

${context}

---

## CLIENT DATA (${periodDays} days ending today, ${currentMonth} ${currentYear})

${snapshot}

---

## QUALITY CONTRACT — enforced before finalizing any field

**Evidence requirement:** Every claim must cite a specific number from the input data. "Impressions are strong" is invalid. "847 impressions in 90 days for a 23-month account" is valid. No cited number = delete the claim.

**Delete the generic:** Would this sentence be true for any SMB client at any digital agency? Yes = delete it. Only client-specific, data-backed statements belong here.

**Cap findings:** opportunityActions: 2–3 items maximum. Pick the ones with the most supporting evidence (largest delta vs. benchmark, highest dollar or volume). Do not pad.

**Platform focus:** For each subscribed platform with data, identify the SINGLE most anomalous metric vs. benchmark for this client's tenure tier. Write only about that. Skip platforms where nothing is anomalous. Two platforms with sharp specific analysis beats six mentioned shallowly.

---

## _precomputed — READ FIRST, THESE OVERRIDE YOUR ANALYSIS

Pre-calculated from deterministic signals. Do NOT recalculate. Do NOT contradict them. Build from them.

- **pitchFrame = "${pitchFrame}"** — governs how Section 1 opens. Use this exact value in your pitchFrame output field.
- **saveabilityScore = "${saveabilityScore}"** — use this value. Do not override it.
- **contactStory.interpretation = "${contactStoryInterpretation}"** — if "client_avoidance": TSI has been calling, the client is not answering. This is NOT a TSI service failure. Do not frame it as one.
- **websitePublishInterpretation** — check _precomputed block in the snapshot. If RECENTLY_ACTIVE, POST_CANCEL_UNPUBLISHED, or HAS_TRAFFIC: the site WAS live. Do NOT write "never published," "never went live," or "unpublished since day one."
${pitchFrame === 'billing_first' ? `
**BILLING FIRST:** Payment failure triggered this cancellation. opportunityActions[0].description must begin with payment resolution: "Let's make sure we can keep the account active. Our billing team can work with you on the payment situation." Only then pivot to platform value.` : ''}${pitchFrame === 'competitive_defense' ? `
**COMPETITIVE DEFENSE:** Validate their conclusion, don't argue it. Emphasize switching costs: site transfer risk, rebuilding SEO from zero, CRM data loss, GBP posting continuity loss. Pivot: "What if we matched what they're offering AND you avoided the switching risk?"` : ''}${pitchFrame === 'service_gap_own_and_fix' ? `
**SERVICE GAP:** One sentence naming the specific gap (use the actual data point), immediately followed by the specific fix within 7 days. No extended apology.` : ''}${pitchFrame === 'relationship_save' ? `
**RELATIONSHIP SAVE:** "I'm glad we finally connected — I've been trying to reach you." TSI has been calling. Frame as TSI being persistent and waiting, not absent.` : ''}${pitchFrame === 'urgency_window' ? `
**URGENCY WINDOW:** Cancel date within 7 days. Open with time awareness, then deliver the full value case.` : ''}

---

## HARD CONSTRAINTS

- **Z clients** (serviceKeys has 'Z', no 'V'): NEVER reference revenue, pipeline, invoices, payments, or dollar amounts from vcita. pipelineAtRisk = 0.
- **Null platform data = fetch failed.** Do NOT reference that platform anywhere — not in analysis, opportunityActions, lossAssets, or topRetentionHook. Do not explain the absence. Build only from platforms with real data.
- **Subscribed product + null data:** Never write "activated," "never set up," "broken connection," "never configured," "never active." Skip the platform.
- **Vendor names:** "BMP" not "vcita" · "Directories" not "Yext" · "Website" not "Duda" · "GBP" is fine.
- **Already-tried offers:** cancellationIntel.saveSolutionsOffered has been tried and failed. Exclude anything on that list from opportunityActions.
- **dataErrors:** Internal debug data. Never reference in analysis or output fields.
- **Cancelled client:** If _precomputed.alreadyCancelledInFalcon = true, this is a closed account. Build a win-back approach. saveabilityScore = Likely Lost.

---

## TRANSLATE EVERY METRIC

Never state a raw number without its plain-English business meaning. The agent is on a live call.
- "385 GBP call clicks" becomes "385 people found your phone number on Google and called — 385 potential customers who actively tried to reach you"
- "247 direction requests" becomes "247 people asked Google Maps to navigate to your location — customers actively trying to find your door"
- "12 new leads" becomes "12 people submitted inquiry forms asking about your services"
This applies to every number: GBP, Yext, Duda, vcita, SOCI.

---

## USE NAMED DATA

When present, use it verbatim:
- **recentLeadNames:** Reference actual names. Filter spam first (skip info@, sales@, company names; use only personal first/last names with personal-looking email domains). "People like [Name] and [Name] reached out through your website."
- **estimateSample** (V clients only): "A $X quote to [Name] is in your pipeline right now — that disappears Day 1."
- **reviews.samples.comment:** Quote verbatim. "[Reviewer] left a 5-star review saying '[quote]' — that's the reputation you've built in [market]."
- **gbp.searchKeywords:** Name the actual terms. "People searching '[top keyword]' found your business — that's real local demand."

---

## OUTPUT RULES

Return ONLY the JSON object. Begin with { and end with }. No preamble, no reasoning text, no explanation.

- **opportunityActions (2–3):** Forward-looking TSI commitments — "We'll publish a [specific] page within 5 days," NOT "Your website is missing content." Grounded in actual client data.
- **lossAssets (3–6):** Ordered Day 1 first. Use actual numbers.
- **insights:** Only for subscribed products (${insightSections.join(', ')}). Real numbers only. Reserve high urgency for genuine performance gaps.
- **topRetentionHook:** Must contain a specific number from their data. "Your presence is strong" is invalid. "385 people called you from Google in 90 days" is valid.
- **pitchFrame, contactStoryInterpretation, saveabilityScore:** Must match _precomputed values.
- **competitors:** Named brand competitors only (e.g. ["Hibu", "Scorpion"]). Empty array if none.
- **urgencyFlag:** true if cancel date within 7 days.
- **cancellationType:** billing_decline | competitor_switch | no_roi | service_issue | other.

Required JSON fields: clientProfile, cancellationRisk, cancelReasonAnchor, topRetentionHook, verticalContext, competitiveBenchmark, seasonalContext, opportunityActions (title/description/expectedImpact each), lossAssets (asset/disappearsBy/impact each), insights (section/coreArgument/keyDataPoints/urgencyLevel/urgencyReason each), pipelineAtRisk, tenureMonths, monthlyPrice, serviceKeys, pitchFrame, contactStoryInterpretation, saveabilityScore, alreadyCancelledInFalcon, competitors, urgencyFlag, cancellationType.

Insights — one entry per subscribed product:
${insightsSpec}`;
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
      model: 'claude-opus-4-8',
      max_tokens: 6000,
      messages: [{ role: 'user', content: buildAnalystPrompt(data, periodDays, agentNotes) }],
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`Analyst (Opus) error: ${response.status} ${response.statusText}${errBody ? ` — ${errBody.slice(0, 200)}` : ''}`);
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

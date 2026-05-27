# tsi-report-api — Component Reference

## app/api/report/route.ts

**Purpose:** Main report API route. Orchestrates all platform fetches for a given client.

**Auth:** `x-api-key` header required. Value must match `TSI_API_KEY` Vercel env var. Returns 401 if missing or wrong.

**Parameters:**
- `gpid` (string, required) — GPID e.g. `TI CASAED001`. Resolved to all platform IDs via `resolveFromGpid()`.
- `days` (number, optional, default 30) — reporting period

**Flow:** Auth check → `resolveFromGpid(gpid)` → fans out to GBP/GBP Reviews/Duda/Yext/vcita via `Promise.allSettled` → returns `ReportData`

**Error handling:** Per-platform errors captured in `errors` field without blocking other platforms.

---

## app/api/retention/route.ts

**Purpose:** Cancellation retention brief API. Triggered by Freshdesk "Cancellation Request" webhook or GET for manual testing.

**Auth:** `x-api-key` header. Returns 401 if missing or wrong.

**Webhook payload (POST):**
```json
{
  "id": 1132061,
  "type": "Cancellation Request",
  "custom_fields": {
    "cf_gf_gpid": "TI HDHAUL001",
    "cf_cancel_type": "standard"
  },
  "description_text": "agent notes",
  "days": 90
}
```

**GET (manual/Postman):** `?gpid=TI+HDHAUL001&days=90`

**Non-live gate:** `cancelType === 'non_live'` returns 422 immediately — insufficient platform data.

**Dedup gate:** Returns cached brief if one exists within last 7 days. Bypass with `forceRefresh=true`.

**Pipeline:**
1. Agent 1 — Fetcher (no model): GPID → all platform data via `fetchClientData`
2. Freshdesk conversation fetch: first 5 conversation entries from cancel ticket (non-blocking)
3. Agents 2 + 4 (parallel): Analyst (Sonnet) + Gap Auditor (Sonnet)
4. Agent 3 — Formatter (Sonnet): structures three-section CSR brief
5. Agent 5 — Note Writer (Haiku): posts internal note to Freshdesk ticket
6. MongoDB write: persists full event

**Freshdesk write gate:** `FRESHDESK_WRITE_ENABLED=true` env var required. Currently `false` — do NOT enable until production go-live is confirmed by Brett.

---

## lib/resolve.ts

**Purpose:** Resolves all platform IDs from a GPID. Called by both report and retention routes.

**Export:** `resolveFromGpid(gpid: string): Promise<ResolvedParams>`

**ResolvedParams:** `{ clientId, vcitaId, dudaSiteName, gbpLocationId, businessName }`

**Flow:**
1. Falcon reverse-lookup by GPID (TI-13737): `clients(filter: { externalServiceId: { gpId: $gpid } })`
   - Returns clientId, vcitaId, dudaSiteName, businessName directly
   - `dudaSiteName` is guaranteed active/published site (TI-13738)
2. Yext entity: GPID → `googlePlaceId` + `googleAccountId`
   - `googlePlaceId` is the primary GBP lookup key (exact, stable, no name fragility)
   - `googleAccountId` kept as last-resort fallback
3. GBP lookup — four-tier priority:
   a. Agency Account filtered by `metadata.placeId="{placeId}"` (preferred — 1 API call, exact match)
   b. Agency Account filtered by `storeCode="{GPID_no_spaces}-001"` (e.g. `TIJULEEA001-001`)
   c. Agency Account filtered by `title="{businessName}"` (fragile — name mismatches cause silent nulls)
   d. Client's own Google account filtered by title (last resort — usually inaccessible)

**Falcon ExternalServiceIdFilter schema:**
`{ gpId, dudaSiteName, vcitaBusinessId, yextId, sociAccountId, freshdeskCompanyId, pageRankUrl }`

**GBP Agency Account:** `accounts/105329348540167006988` (LOCATION_GROUP) — 9,638 TSI client locations  
**GBP OAuth account:** `gbp.agency@townsquaredigital.com` — authorized 2026-05-21 via `generate-token.js`  
**Google Cloud project:** `rosy-strata-448619-k8` (org: `townsquaregbp.com`) — OAuth app set to External/Production  
**StoreCode format:** `{GPID with spaces removed}-001` — e.g. `"TI JULEEA001"` → `"TIJULEEA001-001"`  
**Confirmed working:** TI JULEEA001 → `locations/11851525588319014417`, 1,083 impressions (2026-05-21)

**Deployed:** `dpl_67nS4qD2V46MRFMxTde3RRinJpWH` (2026-05-21)

---

## lib/secrets.ts

**Purpose:** AWS Secrets Manager client. Retrieves all platform credentials.

**Cache:** In-memory map per Lambda invocation to avoid redundant AWS calls.

**Exports:** `getFalconCredentials`, `getGbpCredentials`, `getDudaCredentials`, `getYextCredentials`, `getVcitaCredentials`, `getFreshdeskCredentials`

**Secret names:** `tsi/mcp/falcon`, `tsi/mcp/gbp`, `tsi/mcp/duda`, `tsi/mcp/yext`, `tsi/mcp/vcita`, `tsi/mcp/freshdesk`

---

## lib/falcon.ts

**Purpose:** Falcon GraphQL client. Fetches client metadata AND activity data in a single call by Falcon internal ID.

**Export:** `getClientById(clientId: string, periodDays?: number): Promise<{ client: FalconClient, activities: ActivityData }>`

**client fields:** `{ id, name, status, tsiMarket, price, gpPaymentStatus, gpid, freshdeskId, vcitaId, subscription }`

**GraphQL:** `externalServiceIds { id name }` — maps: `finance=gpid`, `ticketing=freshdeskId`, `crm=vcitaId`

**Commitment terms (added 2026-05-20):** `subscription.information.commitmentTerms { contractLengthMonths, contractStartDate, contractEndDate }`. Mapped to `FalconClient.subscription.commitmentTerms: CommitmentTerms | null`.

**Scheduled cancellation (added 2026-05-21):** `subscription.information.scheduledCancellation { pendingCancelDate, cancellationDate, requestDate, cancelStatus, reason, notes }`. `FalconClient.subscription.scheduledCancellation: ScheduledCancellation | null`. Used by formatter as fallback when `contractEndDate` is null.

**endDate (added 2026-05-21):** `subscription.information.endDate` — `"0000-00-00"` for M2M clients; actual date string for contract clients.

**Billing events (added 2026-05-21):** `ClientActivityItem` union now includes `BillingHistoryItem { event, date, amount, status, notes }` and `CancellationLifecycleItem { event, date, cancelStatus, reason, pendingCancelDate }`. `BillingHistoryItem` activities extracted as `FalconClient.billingEvents: FalconBillingEvent[]` — all events returned (not period-filtered) for 12-month lookback.

**Cancellation history (added 2026-05-21):** `CancellationLifecycleItem` activities extracted as `FalconClient.cancellationHistory: FalconCancellationEvent[]` — all lifecycle events (not period-filtered). Used by gap auditor `cancellation_history` dimension to score past cancel patterns, save outcomes, competitor mentions.

**activities:** Last 100 activities via `activities(limit: 100)` union (`Ticket | Interaction | BillingHistoryItem | CancellationLifecycleItem | Note`), filtered in-process by `periodDays`. Returns `{ openTickets, resolvedThisPeriod, totalThisPeriod, recentTickets, callsThisPeriod, smsThisPeriod }`.

**Ticket blocklist (updated 2026-05-27):** Three filter functions applied in `buildActivityData()`:
- `isCancelTicket()` — filters out Cancellation Request tickets (retention trigger, not a service event)
- `isARTicket()` — filters out Accounts Receivable tickets (`/accounts?\s*receivable/i` on `ticketType`). Added 2026-05-26.
- `isAccountResolutionTicket()` — filters out Account Resolution tickets (`/account\s*resolution/i` on `ticketType`). Added 2026-05-27. These are billing/payment workflow artifacts created automatically on billing declines — not client service events. Flagging them as open TSI obligations was incorrect.

Falcon returns all Freshdesk ticket types unfiltered; blocklist approach is correct.

**GraphQL aliases required:** `ticketType: type`, `ticketStatus: status`, `interactionType: type`, `interactionStatus: status`, `interactionCreatedAt: createdAt` — avoids type conflicts in the union.

---

## lib/platforms/gbp.ts

**Purpose:** GBP insights, live post count, and reviews.

**Exports:**
- `getGbpInsights(locationId, periodDays)` — 7 metrics via `getDailyMetricsTimeSeries` + `getGbpPostsLive`. Returns totals including `postsLive`.
- `getGbpPostsLive(locationId, accessToken?)` — counts LIVE posts via GBP v4 API.
- `getGbpReviews(locationId)` — last 10 reviews via v4 API.

**Auth:** OAuth2 refresh token flow using `tsi/mcp/gbp` secret.

**Casa Edit location:** `locations/9343709211746831348`

**GbpInsights fields:** `{ businessImpressions, mapImpressions, searchImpressions, callClicks, websiteClicks, directionRequests, postsLive, periodStart, periodEnd }`

---

## lib/platforms/yext.ts

**Purpose:** Yext listings sync status + analytics.

**Export:** `getYextData(gpid, periodDays?)` — GPID → Yext accountId by removing spaces (e.g. `TI CASAED001` → `TICASAED001`)

**API:** `api.yextapis.com` (NOT `api.yext.com`) · version `20230301`

**Analytics quirks:**
- `TOTAL_LISTINGS_IMPRESSIONS` returns as `"Total Listings Impressions"` (title case) in JSON — TypeScript interface must use the title-case key
- `TOTAL_LISTINGS_ACTIONS` returns uppercase — inconsistent with above
- Do NOT include `locationIds` filter in the analytics body — silently zeroes impression/action metrics
- Date range required: `startDate` + `endDate` in filters, `dimensions: ['MONTHS']`

**Returns:** `{ locationId, syncedListings, totalListings, impressions, actions, accuracy, actionBreakdown }`

**actionBreakdown** (added 2026-05-20): `{ tapToCall, drivingDirections, website }` — sourced from a second analytics call using `dimensions: ['ACTION']`. All actions currently come from Google (Yext site ID 715). Null if the second fetch fails. Used in retention briefs to give agents specific talking points ("341 calls, 239 directions, 210 website clicks") rather than an opaque aggregate.

**Period label:** Both analyst.ts and gap-auditor.ts now include `periodNote: "All metrics cover the last N days"` in the listings snapshot so the model always knows the timeframe.

---

## lib/platforms/duda.ts

**Purpose:** Duda website stats, blog content, and site update history.

**Export:** `getDudaData(siteName, periodDays)` — takes Duda's internal `site_name` identifier directly.

**Fetches (parallel):** site details, analytics, blog posts, pages list, activity log (last 50).

**API:** Base URL `https://api.duda.co`. Auth: Basic using `tsi/mcp/duda` secret.

**Analytics response keys:** `VISITORS`, `VISITS`, `PAGE_VIEWS` (uppercase).

**Important:** Partner API does NOT support domain-based lookup. Always use `site_name`.

**Returns:**
- `siteAlias`, `lastPublished`, `pageViews`, `uniqueVisitors`, `visits`, `periodStart`, `periodEnd`
- `totalPages` — count of pages from `/pages` endpoint
- `publishedPosts` — `[{ type: 'Blog', title, url, display, date }]` from blog endpoint
- `siteUpdates` — `[{ date, label, detail }]` filtered from activity log where `activity === 'publish_site'`

**Known site_names:**
- Casa Edit Studio (`casaeditstudio.com`): `932be2da`

---

## lib/platforms/vcita.ts

**Purpose:** vcita CRM — leads, invoices, estimates, payments, bookings, conversations.

**Current status:** ✅ Working — calls `api.vcita.biz` directly. Lambda IPs are NOT blocked.

**Auth:**
- Directory token from `tsi/mcp/vcita` AWS secret
- `x-on-behalf-of: {vcita hex business UID}` header required for all business-scoped endpoints

**No MCP proxy needed.** `developers.intandem.tech/mcp` returns 403 from non-Desktop IPs — not viable for Lambda.

**Business UID mapping (Falcon vcitaId → vcita hex UID):**
- `VCITA_UID_MAP` in this file — add new clients here
- To find hex UID for a new client: `GET /platform/v1/businesses?email={adminEmail}`
- Casa Edit Studio: `2483531` → `qtv9l5beq59cl2cu` (admin: sam@casaeditstudio.com)

**Endpoints:**
- `GET /platform/v1/clients?search_by=updated_at&updated_at[gte]={since}&per_page=100`
- `GET /platform/v1/invoices?per_page=100`
- `GET /platform/v1/estimates?per_page=100`
- `GET /platform/v1/payments?per_page=100`
- `GET /platform/v1/scheduling/appointments?per_page=50`
- `GET /platform/v1/conversations?per_page=100`

**Returns:**
- `totalLeads`, `newLeads`, `openInvoices`, `totalRevenue`
- `activePipeline` — sum of approved/invoiced estimate totals
- `upcomingBookings` — future appointments not cancelled/completed
- `conversations` — count in reporting period
- `invoiceItems`, `estimateItems`, `paymentItems`

---

## lib/platforms/soci.ts

**Purpose:** SOCI social media platform integration. Full analytics integration for clients with the `S` service key.

**Export:** `getSociData(gpid: string, businessName: string): Promise<SociData | null>`

**Auth:** `soci-key` header (not `Authorization: Bearer`, not `X-Api-Key`)

**Base URL:** `https://app.meetsoci.com/api` · TSI account ID: `3232`

**GPID lookup:** `GET /account/3232/get_projects?search={businessName}` first, then `search={gpid}`. Each project has a `GPID` field (uppercase). Finds exact match.

**Two-phase fetch:**
1. Phase 1: `GET /project/{id}/remote_list` → extracts `fb_pages[0].remote_network_id` (SOCI's internal network profile ID — NOT the Facebook page ID). E.g. project `190167` → FB network ID `270049`.
2. Phase 2: 8 parallel fetches using both `projectId` and `fbNetworkId`

**Confirmed working endpoints (all 8):**
- `GET /promote/{id}/get_upcoming_messages?account_id=3232` — upcoming posts
- `GET /promote/{id}/get?date_from={today}&date_to={today}&limit=50` — today's sent posts
- `GET /project/{id}/remote_list` — network profiles including `remote_network_id`
- `GET /project/{id}/get_page_metrics_summary` — 28-day reach/engaged users/page likes
- `GET /facebook/{network_id}/get_insights` — FB page fans, impressions, engagement (requires `remote_network_id`, NOT project_id)
- `GET /facebook/{network_id}/top_posts` — top 5 posts by impressions
- `GET /project/{id}/get_engagement_sentiment_summary` — sentiment breakdown
- `GET /project/{id}/get_peak_time_summary` — post timing data
- `GET /project/{id}/get_fan_engagement_demographics_summary` — fan demographics

**SociData fields (updated 2026-05-20):**
- `projectId`, `fbNetworkId` — resolved IDs
- `upcomingPostCount`, `recentlySentCount`, `scheduledNetworks`, `upcomingPosts`
- `pageMetrics` — 28-day reach, engaged users, page likes (SociPageMetrics)
- `fbInsights` — pageFans28day, pageImpressions28day, pageEngagedUsers28day, pagePostEngagements28day, etc. (SociFbInsights)
- `topPosts` — top 5 posts with impressions, engagedUsers, postClicks (SociTopPost[])
- `sentiment` — positive/neutral/negative/avgSentiment (SociSentiment)
- `peakHours` — SociPeakHour[]
- `demographics` — women/men by age group (SociDemographics)
- `reviewCounts` — per-network review counts

**Key gotcha:** `facebook/{id}/get_insights` and `top_posts` require the `remote_network_id` (SOCI internal, e.g. `270049`), NOT the project_id (`190167`) and NOT the Facebook page ID (`1022725351151814`). Passing the wrong ID returns "Invalid project_network id".

---

## lib/platforms/freshdesk.ts

**Purpose:** Freshdesk ticket conversation fetch for the retention pipeline.

**Export:** `getTicketConversations(ticketId: number, limit?: number): Promise<string | null>`

**Auth:** Basic auth — `Buffer.from(\`${apiKey}:X\`).toString('base64')`

**Endpoint:** `GET /api/v2/tickets/{ticketId}/conversations`

**Returns:** Labeled plaintext — `[CLIENT — 2026-05-19]: ...`, `[INTERNAL NOTE — ...]`, `[AGENT REPLY — ...]`. Never throws — returns null on any failure.

**Timeout:** `AbortSignal.timeout(8000)` on the fetch call — critical. Without this, a slow/unreachable Freshdesk endpoint hangs indefinitely and Vercel will kill the function. POST path was failing at ~125s due to missing timeout; GET path (which skips this call) ran fine. Fix confirmed.

**Used by:** `app/api/retention/route.ts` to enrich analyst context with actual human conversation beyond the auto-generated ticket description.

---

## lib/retention/fetcher.ts

**Purpose:** Agent 1 (no model). Resolves GPID → all platform data. Orchestrates all fetches for the retention pipeline.

**Export:** `fetchClientData(gpid: string, periodDays: number): Promise<FetchedData>`

**Uses `resolveFromGpid(gpid)`** to get clientId, vcitaId, dudaSiteName, gbpLocationId, businessName.

---

## lib/retention/analyst.ts

**Purpose:** Agent 2 (Sonnet, max_tokens=6000). Reasoning step — builds bespoke retention case.

**Service key handling:** Falcon returns bundled strings e.g. `["WOYTZ"]` — must `flatMap((k: string) => k.split(''))` before checking individual keys. Fixed from initial `["W","O","Y","T","Z"]` assumption.

**NULL data rule:** null platform data ≠ absent product. Analyst instructed: only conclude a product is absent if `subscribedProducts` explicitly shows false. Null = fetch failed.

**Sections generated:** gbp always, plus listings/reputation (Y), website (W or O), pipeline (V or Z), social (S) based on serviceKeys.

**V vs Z enforcement:** Z (Lead Nurturing only) — pipeline dollar fields masked. V (full BMP) — all fields included.

**dataErrors field:** surfaced to analyst so it knows which nulls are fetch failures vs. genuine empty data.

**Commitment terms (added 2026-05-20):** `contractTerms` block included in analyst snapshot: `contractLengthMonths`, `contractType` (month-to-month/3-month/6-month), `contractEndDate`, `isInCommitment`, `daysRemainingInCommitment`. Analyst informs the model of contract status context without generating date calculations.

**JSON parsing:** Code fence stripping applied before extraction — `text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '')` — Sonnet 4.6 sometimes wraps output in ` ```json ``` ` fences despite explicit instructions. Prompt also says: "Return only the JSON object."

---

## lib/retention/gap-auditor.ts

**Purpose:** Agent 4 (Sonnet, parallel with Agent 2). Produces a full account health index — this is the primary learning dataset for the future proactive retention model that will identify at-risk clients BEFORE they request cancellation.

**10 dimensions (expanded 2026-05-21):** `gbp`, `website`, `listings`, `reputation`, `pipeline`, `service`, `financial`, `structural`, `cancellation_history`, `social`

**New dimensions (added 2026-05-21):**
- **financial** — contract type (M2M vs contract), commitment status, discount history (12-month and all-time), concession eligibility. Score reflects churn risk and Economics section availability, not revenue.
- **structural** — setup completeness across all subscribed products: GBP resolved, website published + page count, social connected, posts live. `tsiOwned: true` — setup gaps are TSI's problem.
- **cancellation_history** — past cancel requests, save outcomes, cancel reasons, competitors mentioned, current scheduled cancellation status. First-time vs. repeat pattern matters for pitch strategy.
- **social** — promoted from snapshot-only to scored dimension. Scoring: scheduling activity, audience trend, engagement quality. N/A if not subscribed.

**Snapshot additions (2026-05-21):** `contractStatus` (full contract/M2M/commitment details), `billing` (billingEvents12mo + discountEvents), `cancellationHistory` (all lifecycle events + derived counts), `leadSamples` in pipeline snapshot, full social data (demographics, topPosts, engagedUsers).

**Data sources for new dimensions:**
- `client.billingEvents` — `FalconBillingEvent[]` extracted from Falcon `BillingHistoryItem` activities
- `client.cancellationHistory` — `FalconCancellationEvent[]` extracted from Falcon `CancellationLifecycleItem` activities (added 2026-05-21)
- `client.subscription.scheduledCancellation`, `.endDate`, `.commitmentTerms` — contract signals
- `vcita.leadSamples` — named lead samples from vcita

**max_tokens:** 6000 (increased from 4000 to accommodate 10-dimension output)

**Same service key and dataErrors handling as analyst.ts.**

**JSON parsing:** Same code fence stripping as analyst.ts — applied before `{...}` extraction.

---

## lib/retention/formatter.ts

**Purpose:** Agent 3 (Sonnet). Transforms analyst output into three-section CSR brief.

**Sections:**
- `agentBrief` — read before dialing: snapshot, contractNote, cancel read, lead-with, vertical note
- `section1` — Opportunity: "If I could get you more business, would you stay?"
- `section2` — Fear/Loss: "Here's exactly what you'd lose and when"
- `section3` — Economics: Kendal Bledsoe's financial guidelines, LAST RESORT framing (integrated 2026-05-20)

**Section 3 structure (real, as of 2026-05-20):**
- `headline` — reluctant final framing; must not sound like an easy offer
- `openingCondition` — internal agent signal: only open after S1 AND S2 explicitly rejected
- `eligibilityNotes` — client-specific constraints (past due, free month cap, 2x/yr limit)
- `escalationSequence` — 5 ordered `FinancialOption` objects: agent_discount → manager_discount → free_month → downgrade → credit
- `agentScript` — how agent opens Section 3; reluctant, no specific prices
- `emailVersion` — value recap first, financial options in paragraph 2 only

**Vendor name rule (added 2026-05-26):** Sonnet prompt includes explicit rule — "BMP"/"Growth Management" not vcita, "Directories" not Yext, "Website" not Duda. GBP/Google Business Profile is fine.

**Section 3 behavioral constraint:** Financial options are LAST RESORT. The formatter prompt explicitly instructs that agents offering financial concessions too early is an existing behavior TSI is working to reduce. Tone must be reluctant and measured, not a deal offer.

**Free month cap logic:** `buildSection3Guidelines(monthlyPrice)` — if `analyst.monthlyPrice > 500`, free month = $500 credit (not full month). If ≤ $500, full free month applies.

**Commitment terms (added 2026-05-20):** `buildContractNote(commitmentTerms)` computes contract status in TypeScript (not LLM-generated, to avoid hallucination on date calculations). Returns null for month-to-month clients. Returns formatted string for 3- or 6-month contracts with: term label, end date, days remaining (if active) or completion date (if expired). Hardcoded as `contractNote` in `agentBrief` JSON output. `runFormatter` accepts `commitmentTerms: CommitmentTerms | null = null`.

**max_tokens:** 5000 (increased from 4000 to accommodate Section 3 escalation sequence)

Each section includes `agentScript` (phone) and `emailVersion` (follow-up email).

**JSON parsing:** Code fence stripping + explicit prompt rule: "Return ONLY the raw JSON object. No markdown. No code fences. No \`\`\`json prefix. The response must start with { and end with }."

---

## lib/retention/note-writer.ts

**Purpose:** Agent 5. Formats retention brief as Freshdesk internal note and posts to the cancel ticket.

**Architecture (hybrid rendering — as of 2026-05-20):**
- **Haiku (max_tokens=2000)** generates narrative sections only: `agentBrief`, `section1`, `section2`
- **TypeScript** renders Section 3 entirely via `renderFinancialOption()` and `buildSection3Block()` — structured `escalationSequence` array must never be delegated to model interpretation. Haiku was truncating or skipping the expansion of typed arrays in earlier builds.
- The two outputs are concatenated: `narrativeHtml + '\n' + section3Html`

**Gated:** Only fires when `FRESHDESK_WRITE_ENABLED=true`. Currently `false` (env var ID `o0Sl8OowmtlNMh2f`).

**Signature (updated 2026-05-26):** `writeRetentionNote(ticketId, brief, gapAudit, clientName, agentNotes, serviceKeys: string[] = [], monthlyPrice: number | null = null)`

**Header (updated 2026-05-26):**
- Client name, tenure, at-risk value (pipeline $ if > 0, else `~Annual value: ~$X/yr`, never "$0")
- Products line — TypeScript-rendered from `serviceKeys` via `SERVICE_KEY_LABELS` map, never vendor names
- TSI service gap flag if present

**SERVICE_KEY_LABELS:** W→Website, O→SEO, Y→Directories, T→Targeting Ads, S→Social, E→E-Commerce, F→Facebook Ads, V→BMP, Z→BMP Lite, C→Call Trace, P→Call Trace Pro

**Vendor name rule (added 2026-05-26):** Never expose third-party vendor names. "BMP"/"Growth Management" not vcita. "Directories" not Yext. "Website" not Duda. GBP/Google Business Profile is fine.

**Notable highlights (added 2026-05-26):** Haiku instructed to add 1-2 "Notable:" bullets from brief data if anything genuinely stands out (strong GBP metric, high review count, significant lead volume, major gap). Skip if nothing notable.

**CRITICAL — batch run safety:** NEVER use `forceRefresh:true` in batch runs. It bypasses `noteAlreadyPostedForTicket` idempotency. If a call silently succeeds and appears to time out, retrying with `forceRefresh` posts a duplicate note. `forceRefresh` is debug-only for intentional single-ticket reruns.

**Note structure:**
1. Header — client name, tenure, at-risk value (dynamic), products line, TSI service gap flag
2. Before you call — snapshot, `contractNote` (if not month-to-month), cancel read, lead-with, vertical context
3. Section 1 — Opportunity: headline, commitments list, agent script
4. Section 2 — Fear/Loss: headline, loss timeline, years-of-work statement, agent script
5. Section 3 — Economics (LAST RESORT): opening condition, eligibility notes, opening script, 5-step escalation sequence (each step: label, manager flag, eligibility, script), top gaps footer
6. Generation footer with date

**`renderFinancialOption(opt, stepNumber)`:** TypeScript function. Renders a single `FinancialOption` as an `<li>` with step number, label, manager flag (⚠️ MANAGER REQUIRED or agent-approved), eligibility, and quoted script.

**`buildSection3Block(brief, gapAudit, topGaps)`:** TypeScript function. Builds the entire Section 3 HTML block: opening condition, eligibility notes, agent script, escalation sequence list, top gaps footer, generation date. Never touches the model.

**Haiku prompt note:** Receives only `agentBrief`, `section1`, `section2` data (not `section3`). `contractNote` hardcoded as a literal string in the prompt (no conditional model instruction). Ends with: "Do NOT add a closing `<hr>` — the system appends Section 3 after your output."

**Freshdesk write timeout:** `AbortSignal.timeout(15000)` on the note POST call — fail fast, never stall the pipeline.

---

## lib/retention/store.ts

**Purpose:** MongoDB persistence. Writes full retention event (raw data + all agent outputs) for audit trail and dedup gate.

**Exports:** `writeRetentionEvent`, `getRecentRetentionEvent` (dedup check within N days)

---

## types/report.ts

All TypeScript types for the report API response.

**Key type:** `ReportData` — `{ meta, client, gbp, gbpReviews, duda, yext, vcita, activities, soci, errors }`

**SOCI types (added 2026-05-20):** `SociPageMetrics`, `SociFbInsights`, `SociTopPost`, `SociSentiment`, `SociPeakHour`, `SociDemographics` — all exported from this file. `SociData` updated to include `fbNetworkId`, `pageMetrics`, `fbInsights`, `topPosts`, `sentiment`, `peakHours`, `demographics`, `reviewCounts`.

**CommitmentTerms (added 2026-05-20):** `{ contractLengthMonths: number | null, contractStartDate: string | null, contractEndDate: string | null }` — sourced from Falcon `subscription.information.commitmentTerms`. Added to `FalconClient.subscription`.

**FalconCancellationEvent (added 2026-05-21):** `{ event, date, cancelStatus, reason, pendingCancelDate }` — extracted from `CancellationLifecycleItem` in Falcon activities. Stored as `FalconClient.cancellationHistory: FalconCancellationEvent[]`.

---

## types/retention.ts

TypeScript types for the retention pipeline.

**Key types:** `FetchedData`, `AnalystOutput`, `GapAuditResult`, `RetentionBrief`, `RetentionEventDoc`

**RetentionBrief:** `{ agentBrief, section1, section2, section3, pipelineAtRisk, tenureMonths }`

**AnalystOutput** includes `monthlyPrice: number` — pass-through from `client.price` in Falcon, used by formatter for Section 3 free month cap check ($500 threshold).

**AgentBrief** includes `contractNote: string | null` (added 2026-05-20) — pre-computed contract status string from `buildContractNote()`. Null for month-to-month clients. Non-null for 3- or 6-month contracts with end date, days remaining, or completion date.

**Section3Economics fields:** `headline`, `openingCondition`, `eligibilityNotes`, `escalationSequence: FinancialOption[]`, `agentScript`, `emailVersion`

**FinancialOption fields:** `type` (agent_discount | manager_discount | free_month | downgrade | credit), `requiresManager: boolean`, `label`, `eligibility`, `script`

**GapAuditResult.dimensions (expanded 2026-05-21):** Now 10 dimensions — `gbp`, `website`, `listings`, `reputation`, `pipeline`, `service`, `financial`, `structural`, `cancellation_history`, `social`. `PrioritizedGap.dimension` union updated to include all 10 keys.

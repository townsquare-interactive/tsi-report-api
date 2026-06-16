# tsi-report-api — Component Reference

## app/api/report/route.ts

**Purpose:** Main report API route. Orchestrates all platform fetches for a given client.

**Auth:** `x-api-key` header via `verifyKey()` from `lib/auth.ts` — accepts TSI_API_KEY (admin) OR TSI_API_KEY_MANNY (read-only). Returns 401 if missing or wrong.

**Parameters:**
- `gpid` (string, required) — GPID e.g. `TI CASAED001`. Resolved to all platform IDs via `resolveFromGpid()`.
- `days` (number, optional, default 30) — reporting period

**Flow:** Auth check → `resolveFromGpid(gpid)` → fans out to GBP/GBP Reviews/Duda/Yext/vcita via `Promise.allSettled` → returns `ReportData`

**GBP org passthrough (updated 2026-06-08):** Destructures `gbpOrg` from `ResolvedParams` and passes it to `getGbpInsights(locationId, days, gbpOrg)` and `getGbpReviews(locationId, gbpOrg)` so the metrics/reviews calls use the same OAuth token as the org that resolved the location. Matches the same fix applied to `lib/retention/fetcher.ts`.

**Error handling:** Per-platform errors captured in `errors` field without blocking other platforms.

---

## app/api/retention/route.ts

**Purpose:** Cancellation retention brief API. Triggered by Freshdesk "Cancellation Request" webhook or GET for manual testing.

**Auth:** `x-api-key` header via `verifyAdminKey()` from `lib/auth.ts` — admin key only (TSI_API_KEY). Returns 401 if missing or wrong.

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

**Parallel fetch (updated 2026-05-28):** `fetchClientData` (Agent 1) and `getTicketConversations` now run concurrently via `Promise.allSettled`. Previous sequencing added ~1–2s per run. Fetcher failure is fatal (502); conversation fetch is non-blocking (returns null on error, never fails the pipeline).

**Pipeline:**
1. Agent 1 — Fetcher (no model) + Freshdesk conversations: run in parallel via `Promise.allSettled`
2. Agents 2 + 4 (parallel): Analyst (Sonnet) + Gap Auditor (Sonnet)
3. Agent 3 — Formatter (Sonnet): structures three-section CSR brief
4. Agent 5 — Note Writer (Haiku): posts internal note to Freshdesk ticket
6. MongoDB write: persists full event

**Freshdesk write gate:** `FRESHDESK_WRITE_ENABLED=true` env var required. Currently `false` — do NOT enable until production go-live is confirmed by Brett.

---

## lib/resolve.ts

**Purpose:** Resolves all platform IDs from a GPID. Called by both report and retention routes.

**Export:** `resolveFromGpid(gpid: string): Promise<ResolvedParams>`

**ResolvedParams:** `{ clientId, vcitaId, dudaSiteName, gbpLocationId, gbpOrg, businessName }`

`gbpOrg` — which TSI GBP org account resolved the location (`agency` | `middleman` | `original` | `suspended` | `null`). Passed to `gbp.ts` so metrics/reviews calls use the same token that found the location.

**Flow:**
1. Falcon reverse-lookup by GPID (TI-13737): `clients(filter: { externalServiceId: { gpId: $gpid } })`
   - Returns clientId, vcitaId, dudaSiteName, businessName directly
   - `dudaSiteName` is guaranteed active/published site (TI-13738)
2. Yext entity: GPID → `googlePlaceId` + `googleAccountId`
   - `googlePlaceId` is the primary GBP lookup key (exact, stable, no name fragility)
   - `googleAccountId` retained for signature compat but not used (TSI OAuth has no access to client accounts)
3. GBP multi-org cascade — searches 4 TSI org accounts in order: **Agency → Middleman → Original → Suspended**
   Within each org, all location groups are searched using the same 5-step cascade:
   a. `metadata.placeId` filter — exact, fast, stable (preferred)
   b. `storeCode="{GPID}-001"` — both space-preserved and no-space formats
   c. `phone="{mainPhone}"` — from Yext, reliable for clients with blank/CID storeCodes
   d. `title="{businessName}"` — exact match (fragile)
   e. `title:"{first 2 words}"` → `title:"{first word}"` — contains fallback with overlap validation
   Each strategy is exhausted across ALL accounts in an org before the next strategy is tried, preventing a weak title match in account A from beating a clean storeCode match in account B.

**GBP org accounts (location groups only):**
- **Agency** (`accounts/105329348540167006988`) — 9,638 locations; most active TSI customers
- **Middleman** — 3 groups: `105184842354302665018` (GBP TSI), `115706322102031373902` (MANAGER ACCESS), `104352906497501100185` (PRIMARY OWNER)
- **Original** — 4 groups: `110889275658012598851` (TSIGMB), `116740707640110849659` (X-Don't Put New), `109048502680893737205` (Y-No Directory), `107749218258047067322` (TRANSFER FROM LEGACY)
- **Suspended** — 4 groups: `100171665983162263460` (SUSPENDED GROUP), `103754244781720486229` (VERIFIED FROM SUSPENDED), `113850092905456226575` (NO CLIENT OWNER), `115636265935701117146` (Bad Store Codes)

**GBP OAuth accounts (one refresh token per org):** stored in AWS secret `tsi/mcp/gbp` as `refresh_token` (agency), `refresh_token_middleman`, `refresh_token_original`, `refresh_token_suspended`  
**StoreCode format:** `{GPID}-001` (spaces preserved) — e.g. `"TI JULEEA001"` → `"TI JULEEA001-001"`  
**Google Cloud project:** `rosy-strata-448619-k8` (org: `townsquaregbp.com`) — OAuth app set to External/Production

---

## lib/secrets.ts

**Purpose:** AWS Secrets Manager client. Retrieves all platform credentials.

**Cache:** In-memory map per Lambda invocation to avoid redundant AWS calls.

**Exports:** `getFalconCredentials`, `getGbpCredentials`, `getDudaCredentials`, `getYextCredentials`, `getVcitaCredentials`, `getFreshdeskCredentials`

**Secret names:** `tsi/mcp/falcon`, `tsi/mcp/gbp`, `tsi/mcp/duda`, `tsi/mcp/yext`, `tsi/mcp/vcita`, `tsi/mcp/freshdesk`

**`tsi/mcp/gbp` keys (updated 2026-06-08):** `client_id`, `client_secret`, `refresh_token` (agency), `refresh_token_middleman`, `refresh_token_original`, `refresh_token_suspended`. `getGbpCredentials()` returns all four refresh tokens; `resolve.ts` uses each org's token to search that org's location groups.

---

## lib/falcon.ts

**Purpose:** Falcon GraphQL client. Fetches client metadata AND activity data in a single call by Falcon internal ID.

**Export:** `getClientById(clientId: string, periodDays?: number): Promise<{ client: FalconClient, activities: ActivityData }>`

**client fields (updated 2026-05-28):** `{ id, name, status, tsiMarket, price, gpPaymentStatus, gpid, freshdeskId, vcitaId, subscription, billingEvents, cancellationHistory, servicing, contentGenActivity, latestSaveEvent, paymentStatus }`

**servicing (added 2026-05-28):** `ClientServicingInfo | null` — extracted from `clientServicingInformation.information`. Includes LAC (lastAttemptedContact), LCR (lastClientResponse/lastClientReached), and qualitative service notes. Used by analyst to distinguish TSI ghosting vs. responsive client context before the cancel call.

**contentGenActivity (added 2026-05-28):** `ContentGenActivity | null` — extracted from the most recent `contentGenActivity` from Falcon's `ContentGenActivityItem` union type. Captures last content generation event for the client (blog, social copy, etc.). Used by analyst to assess whether content production has been active.

**latestSaveEvent (added 2026-05-28):** `FalconCancellationEvent | null` — the most recent event where `cancelStatus === 'save'` from `cancellationHistory`. Shortcut for analyst to see last successful retention without parsing the full history array.

**paymentStatus (added 2026-05-28):** `string | null` — extracted from `subscription.information.paymentStatus`. Surfaces current billing standing (e.g. "current", "past_due") without requiring analyst to dig through billingEvents.

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

**Cross-account GPID filter (added 2026-06-16):** `buildActivityData()` now accepts a `gpid` parameter (passed from `getClientById` via `client.gpid`). After the type-based blocklist, a second filter removes any ticket whose body text contains a GPID pattern (`/\bTI\s+[A-Z][A-Z0-9]{5,14}\b/g`) that doesn't match the current client's GPID. Tickets with no GPID in the body are always kept. Root cause: Falcon's `activities(limit: 100)` query returns all tickets for a Falcon client ID without GPID validation — a misfiled After-Hours STA ticket for `TI AFTERHO001Z` (ASUS Plumbing) appeared in `TI ACESPL001`'s activity feed because both were under the same Falcon client ID. The analyst read "permanently closed Google Business Profile" from that ticket body and fabricated a GBP suspension narrative. This filter prevents cross-account contamination regardless of the filing error source.

**GraphQL aliases required:** `ticketType: type`, `ticketStatus: status`, `interactionType: type`, `interactionStatus: status`, `interactionCreatedAt: createdAt` — avoids type conflicts in the union.

---

## lib/platforms/gbp.ts

**Purpose:** GBP insights, search keywords, live post count, and reviews.

**Exports:**
- `getGbpInsights(locationId, periodDays, org?)` — 7 metrics via `getDailyMetricsTimeSeries` + `getGbpPostsLive` + `getGbpSearchKeywords` (all parallel). Returns totals including `postsLive` and `searchKeywords`. `org` param selects the correct OAuth token for the org that owns this location.
- `getGbpPostsLive(locationId, accessToken?)` — counts LIVE posts via GBP v4 API.
- `getGbpReviews(locationId, org?)` — last 10 reviews via v4 API. `org` param selects the correct OAuth token.

**Timeouts (added 2026-05-28):** All fetch calls carry `AbortSignal.timeout()` — 8s on OAuth token refresh, 10s on all GBP API calls. Prevents a slow Google endpoint from hanging the Vercel function indefinitely.

**Auth:** OAuth2 refresh token flow using `tsi/mcp/gbp` secret.

**Casa Edit location:** `locations/9343709211746831348`

**GbpInsights fields (updated 2026-05-28):** `{ businessImpressions, mapImpressions, searchImpressions, callClicks, websiteClicks, directionRequests, postsLive, periodStart, periodEnd, searchKeywords }`

**searchKeywords (added 2026-05-28):** `Array<{ keyword: string; impressions: number }> | null` — top 5 search queries that triggered impressions for this business, sorted by impression count. Fetched via `getGbpSearchKeywords()` (internal) using the GBP Performance API `searchkeywords/impressions/monthly` endpoint. Same OAuth credentials as `getDailyMetricsTimeSeries`. Below-threshold entries (Google suppresses counts < ~10-25) are filtered out. Returns null when the endpoint returns no above-threshold keywords. Used by analyst to ground impression counts in actual customer search behavior: "X people searched '[keyword]' and found you."

---

## lib/platforms/yext.ts

**Purpose:** Yext listings sync status + analytics.

**Export:** `getYextData(gpid, periodDays?)` — GPID → Yext accountId by removing spaces (e.g. `TI CASAED001` → `TICASAED001`)

**Timeouts (added 2026-05-28):** All fetch calls carry `AbortSignal.timeout(10_000)`.

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

**Timeouts (added 2026-05-28):** Shared `opts = { signal: AbortSignal.timeout(10_000), headers }` applied to all 5 parallel fetches.

**API:** Base URL `https://api.duda.co`. Auth: Basic using `tsi/mcp/duda` secret.

**Analytics response keys:** `VISITORS`, `VISITS`, `PAGE_VIEWS` (uppercase).

**Important:** Partner API does NOT support domain-based lookup. Always use `site_name`.

**RawDudaPage (updated 2026-05-28):** The local interface for Duda's `/pages` API response was renamed from `DudaPage` to `RawDudaPage` to avoid a TypeScript import conflict — `DudaPage` is also exported from `@/types/report` and used as the public-facing type. The local interface (`id`, `title`, `path`, `seo_enabled`) is used only during the fetch/transform step; results are mapped to the exported `DudaPage` type before being returned.

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

**Timeouts (added 2026-05-28):** `vcitaGet` helper carries `AbortSignal.timeout(10_000)`. 403 responses treated as empty (feature not enabled), not errors.

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

**Localization enrichments (added 2026-05-28):**
- **Review text + reviewer names:** GBP review samples now include `comment` (first 150 chars) and `reviewer` (when not Anonymous). Analyst instructed to quote actual customer language verbatim — "Sarah M. left a 5-star review saying '...'" — far more compelling than bare ratings. The `GbpReview.comment` field was already fetched by `getGbpReviews()`; it was being silently dropped from the analyst snapshot.
- **GBP search keywords:** `gbp.searchKeywords` now passed to analyst from `GbpInsights.searchKeywords`. Analyst instructed to ground impression counts in actual search terms: "X people searched '[keyword]' and found you" instead of an abstract impression count.
- **Estimate client names (V clients only):** `estimateSample` added to V-key vcitaSnapshot — filtered to sent/approved/viewed estimates with named client contacts, up to 3. Analyst instructed to use in lossAssets: "a $X quote to [client name] is sitting in your pipeline right now — that disappears Day 1." Only fires when the client has open named estimates; absent for Z clients and V clients with no active pipeline.
- **competitiveBenchmark field (new):** Required output field — 1 sentence explicitly stating whether this client's key metric is above/at/below healthy for their vertical and tenure tier, using specific threshold from the context.ts benchmark table and actual client value. Flows to formatter → `agentBrief.verticalNote`. Transforms floating metrics into actionable competitive judgments the agent can say on the call.
- **Competitive framing rewritten:** Prompt no longer asks the analyst to name specific competitors (no competitor data available — would force fabrication). Now requires relative market position framing: what happens to this client's Google standing when they go inactive while competitors in their category stay active.

**leadNames filter fix (2026-05-28):** `l.name?.trim() && l.name !== 'Unnamed client'` — added `trim()` guard to prevent whitespace-only strings from passing the filter.

**Error body capture (added 2026-05-28):** See gap-auditor.ts note above.

**JSON parsing:** Code fence stripping applied before extraction — `text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '')` — Sonnet 4.6 sometimes wraps output in ` ```json ``` ` fences despite explicit instructions. Prompt also says: "Return only the JSON object."

---

## lib/retention/gap-auditor.ts

**Purpose:** Agent 4 (Sonnet, parallel with Agent 2). Produces a full account health index — this is the primary learning dataset for the future proactive retention model that will identify at-risk clients BEFORE they request cancellation.

**10 dimensions (expanded 2026-05-21):** `gbp`, `website`, `listings`, `reputation`, `pipeline`, `service`, `financial`, `structural`, `cancellation_history`, `social`

**Ticket blocklist in local filter (updated 2026-05-28):** The gap auditor builds `openTicketDetails` from `activities.recentTickets` with a local filter. Previously this only excluded Cancellation Request tickets (`/cancellation/i`). Now mirrors the full blocklist from `lib/falcon.ts`: also excludes Accounts Receivable (`/accounts?\s*receivable/i`) and Account Resolution (`/account\s*resolution/i`) tickets. The `hasBlockedTickets` flag also applies the full filter. Without this, billing workflow tickets (Account Resolution, AR) were appearing in `openTicketDetails`, the model correctly reported them as blocked tickets, and they surfaced in brief headers as TSI service failures — which is wrong. Prompt instruction also updated to explicitly tell the model to ignore these types.

**Error body capture (added 2026-05-28):** Anthropic API errors now capture response body: `const errBody = await response.text().catch(() => ''); throw new Error(\`... ${errBody.slice(0, 200)}\`)`. Applied to gap-auditor, analyst, formatter, and note-writer. Previously errors were `"Sonnet error: 529 "` with no context on what the API actually said.

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

**Anti-generic quality gate (added 2026-05-28):** Formatter prompt now includes an explicit test: "Could you copy this sentence onto a different client's brief with no changes? If yes, it's too generic." S1 agentScript must contain (a) client business name or market, (b) at least one specific number, and (c) a specific TSI commitment — all three required. Formatter also instructed to use review quotes and estimate client names when the analyst has surfaced them. `verticalNote` in `agentBrief` now required to carry the analyst's `competitiveBenchmark` statement verbatim or paraphrased — actual metric vs. actual threshold, not vague assessment language.

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

**HTML code fence stripping (added 2026-05-28):** Haiku intermittently wraps its HTML output in ` ```html ``` ` fences despite explicit prompt instructions — identical to the JSON fence issue on Sonnet agents. Raw Haiku output is now stripped before concatenation with Section 3: `.replace(/^```(?:html)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()`. Without this, fences rendered literally in Freshdesk notes.

**Gated:** Only fires when `FRESHDESK_WRITE_ENABLED=true`. Currently `false` (env var ID `o0Sl8OowmtlNMh2f`).

**Signature (updated 2026-05-26):** `writeRetentionNote(ticketId, brief, gapAudit, clientName, agentNotes, serviceKeys: string[] = [], monthlyPrice: number | null = null)`

**Header (updated 2026-05-26):**
- Client name, tenure, at-risk value (pipeline $ if > 0, else `~Annual value: ~$X/yr`, never "$0")
- Products line — TypeScript-rendered from `serviceKeys` via `SERVICE_KEY_LABELS` map, never vendor names
- TSI service gap flag if present

**SERVICE_KEY_LABELS:** W→Website, O→SEO, Y→Directories, T→Targeting Ads, S→Social, E→E-Commerce, F→Facebook Ads, V→BMP, Z→Lead Nurturing, C→Call Trace, P→Call Trace Pro

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

**Exports:** `writeRetentionEvent`, `getRecentRetentionEvent` (dedup check within N days), `noteAlreadyPostedForTicket` (idempotency check before Freshdesk write)

**Connection singleton (added 2026-05-28):** Module-level `connectionPromise: Promise<Db> | null` pattern replaces the previous `dbInstance` approach. All callers await the same in-flight Promise — prevents concurrent Lambda cold starts from racing to open multiple connections. `serverSelectionTimeoutMS: 5000`, `connectTimeoutMS: 10000`.

**`getRetentionHistory` fix (2026-05-28):** `.toArray()` now properly awaited before the `as RetentionEventDoc[]` cast. Previous version cast the `Promise` directly, which TypeScript strict mode correctly rejected.

---

## types/report.ts

All TypeScript types for the report API response.

**Key type:** `ReportData` — `{ meta, client, gbp, gbpReviews, duda, yext, vcita, activities, soci, errors }`

**GbpInsights.searchKeywords (added 2026-05-28):** `Array<{ keyword: string; impressions: number }> | null` — see `lib/platforms/gbp.ts` section above.

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

**AnalystOutput.competitiveBenchmark (added 2026-05-28):** `string` — required field. One sentence explicitly stating client's relative standing vs. the vertical health benchmark thresholds in `context.ts`. Example: "At 22 months, healthy exterior contractors show 1,000+ GBP impressions/month; this client is at 847 — low end of normal." Flows to formatter for use in `agentBrief.verticalNote`.

**Section3Economics fields:** `headline`, `openingCondition`, `eligibilityNotes`, `escalationSequence: FinancialOption[]`, `agentScript`, `emailVersion`

**FinancialOption fields:** `type` (agent_discount | manager_discount | free_month | downgrade | credit), `requiresManager: boolean`, `label`, `eligibility`, `script`

**GapAuditResult.dimensions (expanded 2026-05-21):** Now 10 dimensions — `gbp`, `website`, `listings`, `reputation`, `pipeline`, `service`, `financial`, `structural`, `cancellation_history`, `social`. `PrioritizedGap.dimension` union updated to include all 10 keys.

---

## Dead Code Removed (2026-05-28)

- **`lib/client-params.ts`** — legacy static client lookup table, superseded by `lib/resolve.ts` dynamic GPID resolution. Zero imports confirmed before deletion.
- **`lib/retention.ts`** — deprecated empty orchestrator stub, superseded by `app/api/retention/route.ts`. Zero imports confirmed before deletion.

---

## Changes — 2026-05-28 v2

### lib/falcon.ts

**New Falcon fields (added):** CLIENT_QUERY now fetches:
- `clientServicingInformation { information { lastAttemptedContact, responded, lastValueProvided, teamDivision { code label }, serviceTeam { members { name email role { code label } } } } }` — authoritative contact dates (LAC/LCR) and assigned service rep info
- `contentGenActivity { lastCompletedAt, lastPageType }` — last Client Hub content automation run (Geo/FAQ/Blog only)
- `retention { latestSaveEvent { savedAt } }` — most recent save from a prior cancellation
- `billing { paymentStatus }` — CURRENT | PAST_DUE (null until Falcon dev resolves permissions; wired up, field exists in query)

**LAC vs LCR distinction:** LAC (`lastAttemptedContact`) = every call attempt including voicemails. LCR (`responded`) = date client actually held a real conversation with TSI. These replace ticket `updatedAt` as the authoritative contact signal throughout the pipeline.

**New FalconClient fields:** `paymentStatus`, `servicing: ClientServicingInfo | null`, `contentGenActivity: ContentGenActivity | null`, `latestSaveEvent: { savedAt: string | null } | null`.

**New types in types/report.ts:** `TeamMember`, `ClientServicingInfo`, `ContentGenActivity`, `DudaPage`.

### lib/platforms/duda.ts

**Page inventory passthrough (added):** `getDudaData` now returns `pages: DudaPage[]` — full page list with `{ title, path }` for each site page. Previously only `totalPages: number` (count) was returned. The Duda pages endpoint was already being called; titles and paths were discarded. Used by analyst to classify page types (service, geo, FAQ, blog) and make specific content recommendations.

**DudaSiteStats updated:** New field `pages: DudaPage[]` added alongside existing `totalPages: number`.

### lib/retention/gap-auditor.ts

**LAC/LCR in service dimension (updated):** `service` snapshot now includes `lastAttemptedContact`, `daysSinceLAC`, `lastClientResponse`, `daysSinceLCR`, `teamDivision`, `serviceTeam`. `daysSinceLastTouchpoint` (which was incorrectly based on ticket `updatedAt`) renamed to `daysSinceLastTicketUpdate` and demoted to secondary signal only.

**Contact story framing (added to prompt):** Model now distinguishes between "TSI not calling" (tsiOwned=true, real gap) and "client not answering" (tsiOwned=false, client avoidance pattern). Critical for avoiding false service-gap flags on accounts where TSI is actively calling but the client is unresponsive.

**Ticket subject reading (added to prompt):** Model now instructed to read ticket `subject` text when assessing whether an open ticket is a real service gap — not just the `type` field. AE Request tickets with subjects indicating radio market referrals are explicitly called out as NOT service failures. General principle: use the actual request context, not surface-level type matching.

**contentGenActivity in snapshot (added):** Client Hub automation signal passed through with explicit note that it is NOT the full content picture — Duda is source of truth for all site content.

### lib/retention/analyst.ts

**12-point prompt overhaul (2026-05-28 v2):**
1. **LAC/LCR contact story** — servicing block added to snapshot; model instructed to distinguish TSI-not-calling from client-not-answering; team member names surfaced
2. **No mea culpa** — explicit rule: never write language implying TSI failed the client as a stated fact; forward-looking commitments only
3. **Billing decline playbook** — if paymentStatus=PAST_DUE, fix-payment-first framing before value conversation; billing decline + long tenure → likely cashflow issue not value dissatisfaction
4. **Specific content types** — service pages, geo pages, FAQ pages, hyper-local blog posts named explicitly; websitePageInventory field shows actual current pages; model told to identify what type is missing and recommend it specifically
5. **GBP zero vs unavailable** — null GBP = fetch failed (flag as setup issue, do NOT say "zero impressions"); GBP present with zeros = real data (content/optimization gap, TSI can address)
6. **Named leads drive specific actions** — already in prompt; reinforced in opportunityActions rule
7. **Competitor intelligence** — when competitor named in agentCancelNotes or cancellation history, analyst includes competitive positioning; no fabrication; "another vendor" framing in agent script
8. **Cancellation urgency flag** — if pendingCancelDate within 7 days, flag "URGENT — cancellation scheduled within 7 days" in cancellationRisk
9. **Second cancel tone change** — if priorCancelRequests > 0, sharper/more direct pitch; "You've come back to us before — what specifically would make this time different?"
10. **Present-tense opportunityActions** — rules updated: write as forward-looking TSI commitments, not problem confessions
11. **topRetentionHook** — must be confident, present-tense, specific statement with real number (not a question, not "What if we...")
12. **websitePageInventory in snapshot** — `duda.pages.slice(0, 30)` added to analyst snapshot

### lib/retention/formatter.ts

**$1 pipeline artifact fix (added):** `pipelineAtRiskOverride` computed before passing to prompt. If `analyst.pipelineAtRisk < 50`, falls back to `monthlyPrice * 12` (annual subscription value). Prevents "$1 pipeline" or "$0 pipeline" from being stated as a client asset figure when vcita pipeline is genuinely empty for non-V or early-stage V clients.

**S2 speakability constraint (added to prompt):** Every sentence in agentScript (Section 2) must be speakable in a single breath. Max 15 words per sentence. No compound clauses. Tested: if a sentence has more than one comma, break it into two.

**Competitors extraction (added):** Formatter prompt now instructs the model to populate `competitors: string[]` in the output JSON — actual named business/brand competitors from cancel reason or analyst findings. Empty array if none named. Used by MongoDB for future competitive intelligence aggregation.

**buildFormatterPrompt signature:** Added `pipelineAtRiskOverride: number` parameter. Two hardcoded `${analyst.pipelineAtRisk}` references replaced with `${pipelineAtRiskOverride}`.

### lib/retention/store.ts

**competitors field (added):** `RetentionEventDoc` now includes `competitors?: string[]` — array of named competitors extracted by the formatter. Persisted to MongoDB for future competitive intel. Wired in `route.ts`: `competitors: retentionBrief?.competitors ?? []`.

### lib/retention/types.ts

**RetentionBrief.competitors (added):** `competitors?: string[]` — optional array of named competitors. Populated by formatter, stored in MongoDB.

### app/api/retention/route.ts

**competitors wired to MongoDB doc (added):** `competitors: retentionBrief?.competitors ?? []` added to `RetentionEventDoc` write.

---

## lib/retention/types.ts

**Purpose:** All TypeScript types for the retention pipeline. Single source of truth — imported by analyst, gap-auditor, formatter, note-writer, store, and route.

**Key types:**

- `FetchedData` — output of Agent 1 (fetcher): `{ client: FalconClient, activities: ActivityData, gbp, gbpReviews, duda, yext, vcita, soci, conversations, dataErrors }`
- `AnalystOutput` — output of Agent 2: retention reasoning, bespoke analysis. Includes `competitiveBenchmark`, `competitors`, `pipelineAtRisk`, `monthlyPrice`, `lossAssets`, `opportunityActions`, `topRetentionHook`, `urgencyFlag`, `cancellationType`
- `GapAuditResult` — output of Agent 4: 10-dimension account health index. **Updated 2026-05-28:** Added `prioritizedGaps: PrioritizedGap[]` (ranked list of actionable gaps with dimension, description, severity, tsiOwned flag) and `topGap: string` (single most important gap in one sentence). These fields power the top-gaps footer in the Freshdesk note (Section 3).
- `RetentionBrief` — output of Agent 3 (formatter): `{ agentBrief, section1, section2, section3 }`. Includes `competitors: string[]` (added 2026-05-28) — competitor names mentioned by client, stored to MongoDB for trend analysis.
- `PrioritizedGap` — `{ dimension: string, description: string, severity: 'high' | 'medium' | 'low', tsiOwned: boolean }`
- `FinancialOption` — one step in the Section 3 escalation sequence: `{ type, label, requiresManagerApproval, eligibility, agentScript }`
- `CommitmentTerms`, `ScheduledCancellation`, `FalconBillingEvent`, `FalconCancellationEvent` — Falcon subscription and history shapes
- `ClientServicingInfo` — LAC/LCR servicing data from Falcon (added 2026-05-28)
- `ContentGenActivity` — content generation activity from Falcon (added 2026-05-28)

---

## types/report.ts

**Purpose:** Public TypeScript types for the `/api/report` route and shared platform data shapes. Imported by platform files and the report route.

**Key types:** `ReportData`, `GbpInsights`, `GbpReview`, `DudaPage`, `DudaSiteStats`, `YextData`, `VcitaData`, `SociData`, `SociTopPost`, `SociSentiment`, `SociPeakHour`, `SociDemographics`

**SociTopPost (corrected 2026-05-28):** `{ id, message, impressions, impressionsOrganic, impressionsViral, engagedUsers, postClicks, scheduledTime }` — field names must match `lib/platforms/soci.ts` exactly. Earlier reconstruction used wrong names (engagements, createdTime) causing TypeScript errors.

**DudaPage (used in report only):** `{ id, title, path, seo_enabled }` — NOT the same as `RawDudaPage` in `lib/platforms/duda.ts`. The `duda.ts` fetch uses `RawDudaPage` locally; results are typed as `DudaPage` on the way out.

---

## Changelog — 2026-05-28 (Session 2) — Falcon Field Expansion

### types/report.ts

**`ScheduledCancellation` (updated):** Added `competitor: string | null` (competitor named in the current cancel request) and `saveSolutions: string | null` (comma-separated list of retention solutions already offered in this cancel event).

**`FalconCancellationEvent` (updated):** Added `competitor: string | null`, `saveSolutions: string | null`, `savedBy: string | null` (rep name who saved the account), `savedAt: string | null` (ISO date of save), `lifecycleAction: string | null` (Falcon lifecycle action label). All sourced from `CancellationLifecycleItem` fields in the Falcon GraphQL schema.

**`FalconClient` (updated):** Added `vertical: string | null` (business type slug from `business.vertical`, e.g. "tree_service", "painting") and `gccDate: string | null` (Go-Current-Client date — the date of the onboarding call, often null).

**`ActivityTicket` (updated):** Added `body: string | null` — full ticket body text, used by gap auditor to make content-based gap decisions (e.g., determining whether an "AE Request" is a radio market referral vs. a real service issue).

### lib/falcon.ts

**`CLIENT_QUERY` (updated):** Now fetches `gccDate`, `business { vertical }`, `scheduledCancellation { competitor saveSolutions savedBy savedAt cancelCreatedDate }`, and `CancellationLifecycleItem` with `competitor`, `saveSolutions`, `savedBy`, `savedAt`, `lifecycleAction`. Also fetches `Ticket.body` for ticket content reading.

**`RawFalconClient` (updated):** Added `gccDate` and `business: { vertical: string | null }` fields.

**`RawCancellationLifecycleItem` (updated):** Added `competitor`, `saveSolutions`, `savedBy`, `savedAt`, `lifecycleAction`.

**`cancellationHistory` extraction (updated):** Map now extracts all new fields from `CancellationLifecycleItem`. `competitor` coerced via `|| null` (Falcon returns `""` not null when blank). `saveSolutions`, `savedBy`, `savedAt`, `lifecycleAction` extracted directly.

**`scheduledCancellation` extraction (updated):** `competitor` and `saveSolutions` added to the extracted object from `ScheduledCancellation`.

**`FalconClient` construction (updated):** `vertical: raw.business?.vertical ?? null` and `gccDate: raw.gccDate ?? null` added. `recentTickets` map now includes `body: t.body ?? null`.

### lib/retention/analyst.ts

**Client snapshot (updated):** `client` object in snapshot now includes `vertical` (business type slug) and `gccDate` (onboarding call date). Both documented with inline comments for model clarity.

**`cancellationIntel` block (new):** Added to snapshot after `paymentStatus`:
- `competitor`: named competitor from current cancel request (`scheduledCancellation.competitor`)
- `saveSolutionsOffered`: what was already tried in this cancel event (`scheduledCancellation.saveSolutions`)
- `priorCancelCount`: count of prior cancel requests in history
- `priorSaves`: up to 3 most recent saves with date, savedBy, saveSolutions, competitor

**COMPETITOR INTELLIGENCE prompt rule (updated):** Primary source is now `cancellationIntel.competitor` (Falcon data from the cancel request) — check this first. `agentCancelNotes` and cancel reason are secondary. If `cancellationIntel.competitor` is non-null, use the exact name and include in competitors array.

**SAVE SOLUTIONS rule (new):** Model is instructed not to recommend any solution appearing in `cancellationIntel.saveSolutionsOffered` or `priorSaves[].saveSolutions` — it has already been tried. If a financial offer was already made, pivot to value demonstration instead of offering another discount.

**COMPETITIVE POSITION rule (updated):** Notes that `client.vertical` slug can be used to look up the correct benchmark row directly from the context tables — no need to guess the vertical from the business name or market.

### lib/retention/gap-auditor.ts

**Client snapshot (updated):** `client` object now includes `vertical: client.vertical` (business type slug).

**`openTicketDetails` map (updated):** Now includes `body: t.body?.slice(0, 300).trim() ?? null` — truncated ticket body text for gap classification.

**`cancellationHistory` snapshot (updated):** Now includes:
- `competitorsNamed`: array of competitor names across all history events (pattern intelligence)
- `priorSaveSolutions`: array of `{ date, saveSolutions, savedBy }` from prior saves (what was tried before)
- `currentScheduledCancellation`: object now includes `competitor` and `saveSolutions` fields inline

**Cancellation History benchmark table (updated):** Added rows for `competitorsNamed`, `priorSaveSolutions`, `currentScheduledCancellation.saveSolutions`, and `currentScheduledCancellation.competitor`.

**`cancellation_history` output dimension (updated):** `actual` object now includes `competitorsNamed`, `currentCompetitor`, and `saveSolutionsAlreadyOffered`. Narrative and action instructions updated to surface competitor name and warn the CSR if prior save solutions have already been exhausted.

**TICKET SUBJECT + BODY READING rule (updated):** Model now reads both `subject` AND `body` when classifying open tickets as real service gaps vs. workflow artifacts.

---

## Fable 5 Prompt Improvements (2026-06-12)

Root cause identified by Anthropic's claude-fable-5 (Mythos-class model): **instruction overload / skim-compliance**. 300–400 line prompts with 20+ equal-weight CRITICAL sections cause models to satisfy every rule shallowly rather than deeply engaging. Changes below address this across all three narrative prompt files.

### lib/retention/analyst.ts

**Prompt rewrite — 255 lines → 90 lines:**

Previous prompt had 20+ CRITICAL instruction blocks all weighted equally (NULL DATA, ZERO DATA, DUDA UNPUBLISHED, BANNED PHRASES, ABSENT DATA, SOCIAL, GBP DATA, etc.) causing skim-compliance. Replaced with:

1. **Quality Contract (4 falsifiable rules, top of prompt):**
   - Evidence requirement: every claim must cite a specific number from input data
   - Delete the generic: if a sentence would be true for any SMB client, delete it
   - Cap findings: opportunityActions 2–3 max, pick by evidence strength
   - Platform focus: one most-anomalous metric per platform, skip if nothing anomalous

2. **_precomputed block surfaced as highest priority:** `pitchFrame`, `saveabilityScore`, `contactStory.interpretation`, and `websitePublishInterpretation` are injected as `"READ FIRST, THESE OVERRIDE YOUR ANALYSIS"` — not buried in a CRITICAL block that gets skimmed.

3. **Hard constraints compressed to a bullet list:** All data rules (Z clients, null data = skip, vendor names, failed offers, etc.) in one compact block instead of 8 separate CRITICAL sections.

4. **One platform rule:** "For each subscribed platform with data, identify the SINGLE most anomalous metric vs. benchmark for this client's tenure tier. Write only about that. Skip platforms where nothing is anomalous." Replaces 6+ per-platform instruction blocks.

5. **opportunityActions capped at 2–3:** Previous cap was 2–4. Fable 5 identified padding as a quality killer.

### lib/retention/formatter.ts

**Generic style prose replaced with concrete contrast examples:**

Previous: "Every section must feel bespoke. If you find yourself writing a generic sentence, stop and replace it with a specific one. The agent can tell when a script was generated from a template."

Replaced with three BAD/GOOD pairs showing exactly what generic vs. specific looks like — numbers, names, specific assets — so the model has concrete examples to pattern-match against rather 
// TSI Institutional Knowledge — Retention Context Library
//
// This is the analyst's full background briefing. It encodes:
//   - What TSI sells and what each service key maps to
//   - Strict product evaluation rules (don't score what they don't have)
//   - What clients lose at cancellation, with timelines
//   - Bespoke analysis directives: vertical, seasonal, geographic, cancel-reason-anchored
//   - The three-section conversation framework for retention agents
//
// Injected into the analyst and formatter prompts.
// Update this file as patterns emerge from real cancellation cases.

export const TSI_CONTEXT = `
## What TSI Does

Townsquare Interactive (TSI) is a digital marketing platform serving 23,000+ small businesses across the US.
TSI manages a bundle of interconnected services — not a single product. When a client cancels, everything
goes offline at once. That bundled dependency is the core retention argument.

---

## Product Service Key Map

Every TSI client has a set of service keys in Falcon. These determine exactly which products they subscribe to.
**You MUST check serviceKeys before evaluating any platform dimension.** Never reference, score, or discuss a
product the client does not subscribe to.

**CRITICAL — CLIENT-FACING PRODUCT NAMES:** TSI never exposes third-party vendor names to clients or agents.
Use ONLY the TSI product names below in all output — briefs, scripts, loss timelines, and section content.
- Say "BMP" or "Growth Management" — NEVER "vcita"
- Say "Directories" or "Directory Listings" — NEVER "Yext"
- Say "Website" — NEVER "Duda"
- Say "GBP" or "Google Business Profile" — this one is fine as-is (it IS the client's Google listing)

| Key | Product | Data Sources |
|-----|---------|-------------|
| W   | Website (Duda) | Duda: traffic, pages, content, site updates |
| O   | SEO | Duda: published posts, site updates; GBP: rankings signal |
| Y   | Directory Listing & Reputation Monitoring | Yext: sync rate, accuracy, impressions; GBP: reviews |
| T   | Targeting Ads | No current data source — note as "ads client" but don't score |
| S   | Social Media | SOCI: scheduled posts, engagement |
| E   | E-Commerce | Duda: store/product data |
| F   | Facebook Ads | No current data source — note as "ads client" but don't score |
| V   | Growth Management (BMP full) | vcita: ALL metrics including revenue, invoices, pipeline, payments |
| Z   | Lead Nurturing (BMP lite) | vcita: leads, bookings, conversations ONLY — NO payments, NO revenue, NO pipeline |
| C   | Call Trace | Falcon activities: inbound call logs |
| P   | Call Trace Pro | Falcon activities: calls + AI answering assistant (expanded C) |

**CRITICAL: V vs Z BMP Distinction**
Every TSI client has either V or Z — it is a core product in all packages.
- V = Growth Management: full CRM, scheduling, marketing, AND payments/invoicing
  → Evaluate all vcita dimensions including revenue, pipeline, open invoices
- Z = Lead Nurturing ONLY: CRM and scheduling, NO payments module
  → Evaluate ONLY leads, bookings, and conversations
  → NEVER mention revenue, pipeline dollars, invoices, or payments for a Z client
  → Showing a Z client a "$0 pipeline" or "pipeline at risk" number is factually wrong — they don't have that product

---

## Product Evaluation Rules

Apply these rules before scoring any dimension in the brief or gap audit:

**Not subscribed → skip entirely**
- No W in serviceKeys → skip all website/Duda evaluation
- No O in serviceKeys → do not flag missing blog posts or missing site updates as an SEO gap
- No Y in serviceKeys → skip directory listings and Yext entirely
- No Y → skip review monitoring (reviews are part of the Y product)
- Has Z but not V → evaluate vcita for leads, bookings, conversations ONLY
- No C and no P → client does not have call trace; do not evaluate call volume as a metric
- T, F → ads products with no data source; acknowledge if present but do not score

**Subscribed but zero engagement → adoption gap (may be TSI-owned)**
- Product in serviceKeys + zero usage → this is a value gap worth flagging
- If client is <90 days old AND product shows zero engagement → likely onboarding/adoption gap, TSI-owned
- If client is 12+ months old AND product shows zero engagement → chronic adoption failure, flag seriously

**Service-area business exception (applies to Y/listings)**
- Some businesses serve customers on-site at the customer's location (plumbers, electricians, cleaners, landscapers)
- These businesses cannot publish a physical street address on many directory platforms by design
- For service-area businesses: incomplete directory sync is EXPECTED and NOT a gap
- If the client's business type suggests service-area, do not penalize for lower sync counts

---

## The Tenure Curve

| Phase | Months | What's Happening | Cancellation Risk Profile |
|-------|--------|------------------|--------------------------|
| Onboarding | 0–3 | Setup and launch. GBP/SEO impact minimal. Content and listings being built. | Highest — impatience, premature judgment |
| Growth | 3–12 | Results compounding. GBP impressions typically 2–3x baseline by month 6. Directories fully synced. | Moderate — often triggered by a slow month or competitor pitch |
| Mature | 12–24 | Established presence. Keyword authority, GBP signals, and listing accuracy all compounding. | Lower — usually driven by cash flow or misaligned expectations, rarely platform performance |
| Veteran | 24+ | Deep value integration. Site, SEO, GBP, listings, CRM all interdependent. | Low — cancellation here destroys years of accumulated value |

Key insight: the longer a client has been live, the more value is at stake. A 3-year client canceling loses
3 years of SEO momentum, GBP authority, listing accuracy, and CRM history all at once.

---

## What Clients Lose on Day One of Cancellation

Use this to build the Fear/Loss section timeline. Be specific about timing — clients rarely understand how fast the decay happens.

**Immediate (Day 1–7)**
- Website goes offline. TSI hosts the site. Domain detaches and goes dark unless the client has a separate host.
- BMP access ends. Lead history, booking records, invoice data, and conversation threads all become inaccessible.
- GBP management stops. TSI's team no longer handles posts, photo updates, Q&A, or category optimization.

**Short-term (Day 7–30)**
- Directory listings begin drifting. Without Directories sync, NAP data (name, address, phone) starts becoming inconsistent across Google, Yelp, Apple Maps, Bing, Facebook, Foursquare, etc.
- All suppressed duplicate listings resurface. TSI actively suppresses conflicting duplicates — when sync ends, those duplicates come back and compete with the real listing.
- Email continuity breaks if using TSI-hosted email through BMP.

**Medium-term (Day 30–90)**
- GBP organic performance typically declines 20–40% without active management. Posts go stale, ranking signals weaken.
- Inconsistent NAP across directories is a direct local SEO penalty. Google's trust in the business location decreases.
- A competitor who maintains active listings and GBP management gains relative ground.

**Long-term (Month 3+)**
- All SEO content momentum stops. Blog posts, geo-targeted landing pages, and keyword rankings built over months don't transfer. A new provider starts from zero.
- New provider onboarding typically takes 60–90 days before any impact is visible — meaning the client is dark for potentially 4–5 months total.
- If they try to rebuild independently, they face: new site build (cost), re-listing management (time), new CRM migration (data loss), starting GBP from a degraded baseline.

---

## Bespoke Analysis Directives

Every retention brief must feel like it was written specifically for this client, not generated from a template.
Before writing anything, reason through these lenses:

**Vertical/Industry Analysis**
- What type of business is this? (Use Falcon market data, vcita usage patterns, GBP category)
- What does success look like for this vertical? (e.g., HVAC: high call volume + seasonal bookings; attorney: long-form SEO content + form leads; restaurant: GBP impressions + direction requests)
- What are the typical lead sources and conversion paths for this industry?
- What do business owners in this vertical care most about when evaluating marketing ROI?

**Seasonal Intelligence**
- **First question — before anything else:** Does this vertical have genuine seasonal demand variation? Many SMBs do NOT. Ask this explicitly before invoking any seasonal argument.
- LOW-seasonality businesses (no meaningful monthly variation): tattoo studios, barbershops, nail salons, mobile phone repair, locksmiths, electricians, plumbers, general contractors, pest control, most professional services (attorneys, accountants, consultants), cleaning services, auto repair, urgent care clinics. For these verticals, seasonal framing is almost always wrong — do not use it.
- MODERATE-seasonality businesses (some seasonal pattern but demand exists year-round): restaurants and food service, gyms and fitness studios, home improvement, retail. Mention seasonality only if the current month clearly aligns with a known slow or peak period.
- HIGH-seasonality businesses (demand is genuinely driven by a specific season or climate pattern): HVAC (summer AC / winter heat), landscaping and lawn care, snow removal, pool service, irrigation and sprinkler systems, seasonal tourism, tax preparation (Q1 only), holiday retail.
- If this is a LOW-seasonality vertical, do NOT mention peak season, slow season, or seasonal dips. Flat metrics for a plumber or electrician are flat metrics — not a seasonal story.
- If this is HIGH-seasonality: name the exact driver (e.g., "HVAC demand drops in Feb because heating season ended"), cite the current month, and be specific about whether this is the slow period or peak period.
- Example (HIGH): A landscaping company canceling in November — off-season, low GBP traffic is expected. Do NOT treat as failure.
- Example (HIGH): An HVAC company canceling in February — slow season. Frame lower bookings as seasonal, not a platform problem.
- Example (LOW): A tattoo studio with flat GBP impressions — no seasonal explanation applies. Evaluate as a genuine trend, not a seasonal dip.

**Geographic Context**
- What market is the client in? (Falcon tsiMarket field)
- Is it a competitive urban market or a lower-competition rural/suburban market?
- Are GBP impressions low because the market is genuinely hard, or because there's a real gap?
- Local competitor context if available

**Cancel Reason as Pitch Anchor**
- If agent notes contain a reason, anchor the entire brief to that reason
- "Too expensive" → lead with ROI data, anchor Section 3 to downgrade options
- "Not seeing results" → lead with what IS performing, contextualize what's still in ramp
- "Found cheaper option elsewhere" → emphasize the bundle cost to rebuild independently
- "Going out of business" → skip retention entirely, focus on asset preservation (domain, data export)
- "Double non-payment" → 50% of these are actual dissatisfaction vs. forgotten credit card; probe first

**Tenure-Based Framing**
- 0–3 months: "You're in the ramp phase — the best data is 6 months away. Canceling now means starting from zero with a new provider."
- 4–12 months: "Your results are compounding right now. This is the worst possible time to hit pause."
- 12–24 months: "You've built [X] impressions, [Y] reviews, [Z] years of SEO momentum. Every month you maintain this, it gets harder for competitors to catch up."
- 24+ months: "You have [X] years of Google authority. That took [X] years to build. You can't buy it back — you'd have to rebuild it."

---

## The Three-Section Conversation Framework

Retention agents should follow this sequence. The brief is structured to support each section in order.

**Section 1 — Opportunity (lead with this)**
"If I could wave a magic wand and get you more business over the next 30–60 days, would it change your mind?"
- Present 1–4 specific, actionable things TSI can do to improve their performance
- These should be real, achievable, and tied to their actual data gaps
- This section is about hope and improvement — not defending past performance

**Section 2 — Fear/Loss (only if Section 1 fails)**
"Before you go, can I show you exactly what you'd lose and when it happens?"
- Timeline of what goes offline and when
- Specific things the client has built that will be lost or degraded
- Asset value summary: years of SEO work, GBP authority, review count, listing accuracy
- "Is it okay if all of that happens?"

**Section 3 — Economics (only if Section 1 and 2 fail)**
"If I could make this cheaper, would that change things?"
- Present downgrade options at lower price points
- Never lead with price — it devalues what they already have
- This section exists only when the client has rejected both opportunity and loss arguments
- Financial guidelines will be provided separately

---

## Common Cancellation Signals and Retention Angles

| Signal | Likely Cause | Retention Angle |
|--------|-------------|-----------------|
| Low BMP activity (Lead Nurturing client) | CRM not adopted; client doesn't know how to use it | Platform adoption gap; TSI can train them |
| Low BMP activity (Growth Management client) | Not using payments/pipeline; missing revenue tracking | Show what pipeline visibility could mean for cash flow |
| No new reviews in 90 days | Client not asking customers for reviews | Teach the review ask — this is a behavior change, not a platform failure |
| GBP impressions flat or declining | Seasonal dip, niche market, or genuine gap | Distinguish seasonal from trend; show direction requests and calls |
| Low website traffic | New site in SEO ramp, or stale content | Show content published; contextualize vs. SEO ramp timeline |
| No site updates in 60+ days | TSI not publishing content | Flag as TSI service gap — this is our deliverable |
| Open/blocked Freshdesk tickets | Unresolved service issues | Acknowledge, take ownership, commit to resolution before the call ends |
| Payment issues | Cash flow pressure | Flexible billing, value anchoring, downgrade options |
| "Getting a better deal elsewhere" | Competitor pitch | Itemize rebuild cost: new site + new SEO + new CRM + new listings + 90-day ramp lag |
| Canceling during ramp phase (0–3mo) | Impatience, premature judgment | Show trajectory vs. benchmarks; what the data will look like at month 6 |
| Double non-payment | Could be genuine dissatisfaction OR forgotten payment method | Probe intent first — 50% are recoverable with a payment update |

---

## Vertical Health Benchmarks

Use these reference thresholds when writing verticalContext and competitiveBenchmark. They represent
what a healthy, actively managed TSI client looks like at each tenure tier for common verticals.
These are internal TSI benchmarks based on the client portfolio — not industry-wide statistics.

**How to use:** Look up the client's vertical category and tenure tier. Compare their actual metrics
to the thresholds. State the comparison explicitly in verticalContext and competitiveBenchmark: "At [X] months,
healthy [vertical] businesses typically have [Y]. This client is at [Z] — [above/at/below] that range."

**Tenure tiers:**
- **Onboarding:** 0–6 months (still ramping, lower benchmarks apply)
- **Growth:** 6–24 months (full ramp, approaching steady state)
- **Mature:** 24+ months (established, should be at or above benchmarks)

### HVAC (Heating, Ventilation, Air Conditioning)

| Metric | Onboarding (0–6 mo) | Growth (6–24 mo) | Mature (24+ mo) |
|--------|--------------------|--------------------|-----------------|
| GBP impressions/mo | 600–1,200 | 1,200–2,500 | 2,000–4,000 |
| Call clicks/mo | 20–50 | 50–120 | 100–200 |
| Direction requests/mo | 10–30 | 30–80 | 60–150 |
| Reviews total | 5–15 | 15–40 | 35+ |
| Avg rating | 4.0+ | 4.2+ | 4.3+ |

### Exterior Contractors (Painting, Roofing, Concrete, Siding)

| Metric | Onboarding (0–6 mo) | Growth (6–24 mo) | Mature (24+ mo) |
|--------|--------------------|--------------------|-----------------|
| GBP impressions/mo | 500–1,000 | 1,000–2,000 | 1,800–3,500 |
| Call clicks/mo | 15–40 | 40–100 | 80–180 |
| Direction requests/mo | 8–25 | 25–70 | 50–120 |
| Reviews total | 5–12 | 12–30 | 28+ |
| Avg rating | 4.0+ | 4.2+ | 4.4+ |

### Landscaping and Lawn Care

| Metric | Onboarding (0–6 mo) | Growth (6–24 mo) | Mature (24+ mo) |
|--------|--------------------|--------------------|-----------------|
| GBP impressions/mo | 400–900 | 900–1,800 | 1,600–3,000 |
| Call clicks/mo | 12–35 | 35–90 | 70–150 |
| Direction requests/mo | 8–20 | 20–60 | 45–100 |
| Reviews total | 4–10 | 10–25 | 22+ |
| Avg rating | 4.0+ | 4.2+ | 4.3+ |

### Plumbing and Electrical

| Metric | Onboarding (0–6 mo) | Growth (6–24 mo) | Mature (24+ mo) |
|--------|--------------------|--------------------|-----------------|
| GBP impressions/mo | 700–1,400 | 1,400–2,800 | 2,400–4,500 |
| Call clicks/mo | 25–60 | 60–140 | 120–240 |
| Direction requests/mo | 12–35 | 35–90 | 70–160 |
| Reviews total | 6–18 | 18–45 | 40+ |
| Avg rating | 4.1+ | 4.3+ | 4.4+ |

### Restaurants and Food Service

| Metric | Onboarding (0–6 mo) | Growth (6–24 mo) | Mature (24+ mo) |
|--------|--------------------|--------------------|-----------------|
| GBP impressions/mo | 1,000–2,500 | 2,500–5,000 | 4,500–9,000 |
| Call clicks/mo | 30–80 | 80–200 | 160–350 |
| Direction requests/mo | 40–100 | 100–250 | 200–450 |
| Reviews total | 10–30 | 30–80 | 70+ |
| Avg rating | 3.9+ | 4.0+ | 4.2+ |

### Auto Services (Repair, Detailing, Tires)

| Metric | Onboarding (0–6 mo) | Growth (6–24 mo) | Mature (24+ mo) |
|--------|--------------------|--------------------|-----------------|
| GBP impressions/mo | 600–1,300 | 1,300–2,600 | 2,200–4,200 |
| Call clicks/mo | 20–55 | 55–130 | 110–220 |
| Direction requests/mo | 15–40 | 40–100 | 80–170 |
| Reviews total | 8–20 | 20–50 | 45+ |
| Avg rating | 4.0+ | 4.2+ | 4.3+ |

### Personal Services (Salons, Spas, Tattoo, Fitness)

| Metric | Onboarding (0–6 mo) | Growth (6–24 mo) | Mature (24+ mo) |
|--------|--------------------|--------------------|-----------------|
| GBP impressions/mo | 400–800 | 800–1,600 | 1,400–2,800 |
| Call clicks/mo | 10–30 | 30–75 | 60–130 |
| Direction requests/mo | 10–30 | 30–80 | 65–140 |
| Reviews total | 5–15 | 15–40 | 35+ |
| Avg rating | 4.1+ | 4.3+ | 4.4+ |

### Professional Services (Attorneys, Accountants, Insurance, Real Estate)

| Metric | Onboarding (0–6 mo) | Growth (6–24 mo) | Mature (24+ mo) |
|--------|--------------------|--------------------|-----------------|
| GBP impressions/mo | 300–700 | 700–1,400 | 1,200–2,500 |
| Call clicks/mo | 8–25 | 25–65 | 55–120 |
| Direction requests/mo | 5–15 | 15–40 | 35–80 |
| Reviews total | 4–12 | 12–30 | 25+ |
| Avg rating | 4.2+ | 4.3+ | 4.5+ |

### Home Services (General Contractors, Remodeling, Cleaning)

| Metric | Onboarding (0–6 mo) | Growth (6–24 mo) | Mature (24+ mo) |
|--------|--------------------|--------------------|-----------------|
| GBP impressions/mo | 450–950 | 950–1,900 | 1,700–3,200 |
| Call clicks/mo | 14–38 | 38–95 | 75–160 |
| Direction requests/mo | 8–22 | 22–65 | 50–110 |
| Reviews total | 5–14 | 14–35 | 30+ |
| Avg rating | 4.0+ | 4.2+ | 4.3+ |


---

## Notes from Past Cases

*(Fill in as patterns emerge — e.g., "HVAC clients in southern markets spike cancellations in Feb/Mar — slow season")*
`.trim();

// Export a getter so callers can inject context length conditionally
export function getRetentionContext(includeNotes = true): string {
  if (includeNotes) return TSI_CONTEXT;
  // Strip the Notes section for token-sensitive prompts
  return TSI_CONTEXT.split('## Notes from Past Cases')[0].trim();
}

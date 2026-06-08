# tsi-report-api — Architecture

## Overview

Two-endpoint Next.js API for client intelligence and retention automation. All platform IDs are auto-resolved from a GPID.

## Endpoints

```
GET  /api/report?gpid=TI+HDHAUL001&days=30       — Full platform report
POST /api/retention                               — 5-agent AI retention brief
```

## GPID Resolution Chain (`lib/resolve.ts`)

```
GPID (e.g. "TI ROOFIN047")
  │
  ▼ Step 1: Falcon GraphQL
  │   → clientId, vcitaId, dudaSiteName, businessName
  │
  ▼ Step 2: Yext Entity Lookup (non-fatal)
  │   → googlePlaceId (preferred GBP key)
  │   → googleAccountId (fallback)
  │
  ▼ Step 3: GBP Multi-Org Location Resolution (updated 2026-06-08)
      Searches 4 TSI org accounts in order: Agency → Middleman → Original → Suspended
      Within each org, all location groups searched using 5-step cascade:
        a) metadata.placeId filter (exact — preferred)
        b) storeCode "{GPID}-001" (spaces preserved, e.g. "TI ROOFIN047-001")
        c) storeCode "{GPID_no_spaces}-001" (e.g. "TIROOFIN047-001" — older clients)
        d) title exact match (fragile)
        e) title-contains match (partial name — handles "Eash Co. LLC" vs "Eash Co.")
      → { gbpLocationId, gbpOrg } (both null if not found in any org)
```

**GBP Orgs (searched in this order):**
- Agency: `accounts/105329348540167006988` (~9,638 locations) — `refresh_token`
- Middleman: 3 location groups (~3,444 locations) — `refresh_token_middleman`
- Original: 4 location groups (~24k locations) — `refresh_token_original`
- Suspended: 4 location groups (~1,845 locations) — `refresh_token_suspended`

**Credentials:** All 4 refresh tokens in `tsi/mcp/gbp` AWS secret. See Obsidian `Integrations/gbp`.  
**StoreCode note:** Some clients have numeric CID storeCodes (e.g. Eash Co. = `02378400463851801322`) — found via title-contains fallback.

**GBP null** = location not found in any of the 4 TSI org accounts. Rare — check `[GBP] No match in org` log lines to confirm which orgs were searched.

## Data Flow — `/api/report`

```
resolveFromGpid(gpid) → clientId, vcitaId, dudaSiteName, gbpLocationId, gbpOrg
  │
  ▼ (parallel via Promise.allSettled)
┌─────────────────────────────────────────────────────────────┐
│  GBP insights  │  Duda stats  │  Yext listings  │  vcita  │
└─────────────────────────────────────────────────────────────┘
  + Falcon GraphQL (full client metadata)
```

## Data Flow — `/api/retention`

```
POST body → Dedup gate (MongoDB) → Agent 1 Fetcher → Agents 2+4 parallel
→ Agent 3 Formatter → Agent 5 Note Writer (gated) → MongoDB write
```

## Credential Architecture

All credentials in **AWS Secrets Manager (us-east-1)** under `tsi/` namespace.

| Secret | Contents |
|--------|----------|
| `tsi/mcp/gbp` | GBP OAuth: client_id, client_secret, refresh_token (agency), refresh_token_middleman, refresh_token_original, refresh_token_suspended |
| `tsi/mcp/falcon` | Falcon GraphQL API key + endpoint |
| `tsi/mcp/duda` | Duda API username + password |
| `tsi/mcp/yext` | Yext API key |
| `tsi/mcp/vcita` | vcita API token |
| `tsi/mcp/freshdesk` | Freshdesk API key + domain |
| `tsi/mcp/soci` | SOCI API key |

## Key Files

| File | Purpose |
|------|---------|
| `lib/resolve.ts` | GPID → all platform IDs (full GBP resolution chain) |
| `lib/platforms/gbp.ts` | GBP insights, reviews, search keywords |
| `lib/retention/analyst.ts` | Agent 2: retention reasoning + pitchFrame |
| `lib/retention/formatter.ts` | Agent 3: three-section CSR brief |
| `lib/retention/note-writer.ts` | Agent 5: Freshdesk HTML note |
| `lib/retention/context.ts` | TSI institutional knowledge |
| `lib/retention/store.ts` | MongoDB persistence + dedup |
| `types/report.ts` | TypeScript types |

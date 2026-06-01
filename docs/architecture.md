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
  ▼ Step 3: GBP Location Resolution (4 fallback levels)
      a) Agency account + Place ID filter
      b) Agency account + storeCode = {GPID_no_spaces}-001  (e.g. TIROOFIN047-001)
      c) Agency account + title filter (fragile)
      d) Client own Google account + title (safety net)
      → gbpLocationId (null if all 4 fail)
```

**GBP Agency Account:** `accounts/105329348540167006988` (9,638 TSI locations)
**GBP OAuth:** `gbp.agency@townsquaredigital.com` — credentials in `tsi/mcp/gbp` (AWS Secrets Manager)
**StoreCode format:** `{GPID_no_spaces}-001` — e.g. `TI ROOFIN047` → `TIROOFIN047-001`
**Auth fixed:** 2026-05-21 — see `docs/integrations/gbp-auth-brief.md` or Obsidian `Integrations/gbp-auth-brief`

## Data Flow — `/api/report`

```
resolveFromGpid(gpid) → clientId, vcitaId, dudaSiteName, gbpLocationId
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
| `tsi/mcp/gbp` | GBP OAuth: client_id, client_secret, refresh_token |
| `tsi/mcp/falcon` | Falcon GraphQL API key + endpoint |
| `tsi/mcp/duda` | Duda API username + password |
| `tsi/mcp/yext` | Yext API key |
| `tsi/mcp/vcita` | vcita API token |
| `tsi/mcp/freshdesk` | Freshdesk API key + domain |
| `tsi/mcp/soci` | SOCI API key |

## Key Files

| File | Purpose |
|------|---------|
| `lib/resolve.ts` | GPID → all platform IDs (GBP resolution chain) |
| `lib/platforms/gbp.ts` | GBP insights, reviews, search keywords |
| `lib/retention/analyst.ts` | Agent 2: retention reasoning + pitchFrame |
| `lib/retention/formatter.ts` | Agent 3: three-section CSR brief |
| `lib/retention/note-writer.ts` | Agent 5: Freshdesk HTML note |
| `lib/retention/context.ts` | TSI institutional knowledge |
| `lib/retention/store.ts` | MongoDB persistence + dedup |
| `types/report.ts` | TypeScript types |

# tsi-report-api — Architecture

## Overview

Two-endpoint Next.js API for client intelligence and retention automation. All platform IDs are auto-resolved from a GPID — no manual ID passing required.

## Endpoints

```
GET  /api/report?gpid=TI+HDHAUL001&days=30       — Full platform report (GBP, Yext, vcita, Duda, Freshdesk)
POST /api/retention                               — 5-agent AI retention brief (webhook or manual curl)
```

## GPID Resolution Chain (`lib/resolve.ts`)

Every request starts with a GPID and resolves all platform IDs automatically:

```
GPID (e.g. "TI ROOFIN047")
  │
  ▼ Step 1: Falcon GraphQL
  │   filter: { externalServiceId: { gpId: $gpid } }
  │   → clientId, vcitaId, dudaSiteName, businessName
  │
  ▼ Step 2: Yext Entity Lookup (non-fatal)
  │   account: {GPID_no_spaces}, entity: {GPID_no_spaces}-001
  │   → googlePlaceId (preferred GBP key)
  │   → googleAccountId (fallback)
  │
  ▼ Step 3: GBP Location Resolution (4 fallback levels)
      a) Agency account + Place ID filter (exact, fast — preferred)
      b) Agency account + storeCode = {GPID_no_spaces}-001  (e.g. TIROOFIN047-001)
      c) Agency account + title filter (fragile — name mismatch = null)
      d) Client's own Google account + title (safety net)
      → gbpLocationId (null if all 4 fail — GBP fetch is skipped)
```

**GBP Agency Account:** `accounts/105329348540167006988` (9,638+ TSI client locations)
**GBP OAuth account:** `gbp.agency@townsquaredigital.com` — credentials in AWS Secrets Manager `tsi/mcp/gbp`
**StoreCode format:** `{GPID_no_spaces}-001` — e.g. `TI ROOFIN047` → `TIROOFIN047-001` ✓ confirmed in GBP Manager

**Known issue (2026-06-01):** GBP returning null for all clients — suspected OAuth refresh token expiry.
Diagnosis: check Vercel logs for `[GBP] OAuth token refresh FAILED` entries.
Fix: update refresh token in AWS Secrets Manager `tsi/mcp/gbp`.

## Data Flow — `/api/report`

```
resolveFromGpid(gpid) → clientId, vcitaId, dudaSiteName, gbpLocationId
  │
  ▼ (parallel via Promise.allSettled)
┌─────────────────────────────────────────────────────────────┐
│  GBP insights  │  Duda stats  │  Yext listings  │  vcita  │
└─────────────────────────────────────────────────────────────┘
  + Falcon GraphQL (full client metadata)
  │
  ▼
Compiled ReportData JSON — errors captured per platform, never blocking others
```

## Data Flow — `/api/retention`

```
POST body: { id, type, custom_fields.cf_gf_gpid, description_text }
  │
  ▼ Dedup gate (MongoDB — skip if brief < 7 days old; bypass with forceRefresh=true)
  │
  ▼ Agent 1: Fetcher (no model)
  │   resolveFromGpid → fetchClientData (Falcon + all platforms) + getTicketConversations
  │   (both run in parallel via Promise.allSettled)
  │
  ▼ Agents 2 + 4: An
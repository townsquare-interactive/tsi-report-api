# tsi-report-api — Architecture

## Overview

Single Next.js API route that accepts a Falcon client ID and returns a compiled JSON report pulling data from all TSI platform integrations. Purpose: give any TSI developer a single endpoint to retrieve all report data for a given client without needing to build their own MCP or platform connections.

## Endpoint

```
GET /api/report?clientId=129598&days=30&gbpLocationId=locations/9343709211746831348
```

### Parameters
| Param | Required | Description |
|-------|----------|-------------|
| `clientId` | Yes | Falcon internal client ID (e.g. `129598` for Casa Edit Studios) |
| `days` | No | Reporting period in days (default: 30, max: 365) |
| `gbpLocationId` | No | GBP location resource name. If omitted, GBP data is skipped. |

## Data Flow

```
Request
  │
  ▼
Falcon GraphQL ──► Gets: client name, status, GPID, Freshdesk ID, vcita ID
  │
  ▼ (parallel)
┌─────────────────────────────────────────────────────┐
│  GBP API   │  Duda API  │  Yext API  │  vcita API  │  Freshdesk API  │
└─────────────────────────────────────────────────────┘
  │
  ▼
Compiled JSON response (errors captured per platform, never blocks others)
```

## Credential Architecture

All platform credentials are stored in **AWS Secrets Manager (us-east-1)** under the `tsi/` namespace. The only env vars needed at the Vercel project level are the AWS IAM access key pair.

| Secret Name | Contents |
|-------------|----------|
| `tsi/mcp/falcon` | Falcon GraphQL API key + endpoint |
| `tsi/mcp/gbp` | GBP OAuth client ID, client secret, refresh token |
| `tsi/mcp/duda` | Duda API username + password |
| `tsi/mcp/yext` | Yext API key + account ID |
| `tsi/mcp/vcita` | vcita API token |
| `tsi/mcp/freshdesk` | Freshdesk API key + domain |

## Key Files

| File | Purpose |
|------|---------|
| `app/api/report/route.ts` | Main API route — orchestrates all fetches |
| `lib/secrets.ts` | AWS Secrets Manager client with per-platform accessors |
| `lib/falcon.ts` | Falcon GraphQL client — GPID/platform ID lookup |
| `lib/platforms/gbp.ts` | GBP insights + reviews |
| `lib/platforms/duda.ts` | Duda site stats |
| `lib/platforms/yext.ts` | Yext listings data |
| `lib/platforms/vcita.ts` | vcita leads, invoices, bookings |
| `lib/platforms/freshdesk.ts` | Freshdesk tickets |
| `types/report.ts` | TypeScript types for all response shapes |

## Known Limitations (v1)

- **GBP location ID**: Must be passed as a query param. Future: build a GPID → GBP location ID mapping table.
- **Duda site lookup**: Searches by client name (substring). If name doesn't match, returns error in the `errors` field.
- **Yext location lookup**: Searches by GPID as external ID or client name. May miss if neither matches.
- **Response is not cached**: Every call hits all platform APIs. Add Redis or Vercel KV caching once stable.

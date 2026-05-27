// Client parameter lookup table — keyed by GPID (the finance external service ID in Falcon)
//
// This is the single place where platform-specific IDs are stored per client.
// The API accepts only `gpid` — everything else is resolved from this map.
//
// To onboard a new client:
//   1. clientId     — Falcon internal ID (numeric string from Falcon admin)
//   2. dudaSiteName — run: mcp__duda__get_site_details(domain="clientdomain.com") → site_name field
//   3. gbpLocationId — run: mcp__gbp__gbp_list_locations → find by business name → use name field
//
// dudaSiteName and gbpLocationId are optional — omit if client doesn't have that platform.

export interface ClientParams {
  clientId: string;
  dudaSiteName?: string;
  gbpLocationId?: string;
}

const CLIENT_PARAMS: Record<string, ClientParams> = {
  'TI CASAED001': {
    clientId: '129598',
    dudaSiteName: '932be2da',
    gbpLocationId: 'locations/9343709211746831348',
  },
  // Add new clients here:
  // 'TI BIGESS001': {
  //   clientId: 'XXXXX',
  //   dudaSiteName: 'XXXXXXXX',
  //   gbpLocationId: 'locations/XXXXXXXXXXXXXXXXX',
  // },
};

export function getClientParams(gpid: string): ClientParams | null {
  return CLIENT_PARAMS[gpid] ?? null;
}

// Dynamic resolution of all platform IDs from a GPID.
//
// Flow (updated for TI-13737 + TI-13738 + Place ID fix + Agency Account migration + multi-org GBP):
//   1. Falcon reverse-lookup: GPID → client directly via externalServiceId filter
//      Returns: clientId, vcitaId, dudaSiteName (active site per TI-13738), businessName
//   2. Yext entity: GPID → googleAccountId + googlePlaceId
//      googlePlaceId used for direct GBP lookup (fast, exact, no name-mismatch fragility)
//      googleAccountId kept as last-resort fallback
//   3. GBP multi-org lookup — searches 4 TSI org accounts in order:
//      Agency → Middleman → Original → Suspended
//      Within each org, all location groups are searched using the same cascade:
//        a) metadata.placeId filter (exact, fast — preferred)
//        b) storeCode filter: GPID + "-001" (both space-preserved and no-space formats)
//        c) phone filter (from Yext mainPhone)
//        d) title exact match
//        e) title-contains (2 words then 1 word, stripping LLC/Inc/Corp etc.)
//      Returns locationId + which org resolved it (used by gbp.ts to select the right token)
//
// Org account IDs (location groups only — not the org root accounts):
//   Agency:    accounts/105329348540167006988 (9,638 locations — most active TSI customers)
//   Middleman: accounts/105184842354302665018 (GBP TSI)
//              accounts/115706322102031373902 (MANAGER ACCESS ONLY)
//              accounts/104352906497501100185 (PRIMARY OWNER)
//   Original:  accounts/110889275658012598851 (TSIGMB)
//              accounts/116740707640110849659 (X - Don't Put New)
//              accounts/109048502680893737205 (Y - No Directory Listing)
//              accounts/107749218258047067322 (TRANSFER FROM LEGACY)
//   Suspended: accounts/100171665983162263460 (SUSPENDED GROUP)
//              accounts/103754244781720486229 (VERIFIED FROM SUSPENDED)
//              accounts/113850092905456226575 (NO CLIENT OWNER)
//              accounts/115636265935701117146 (Bad Store Codes)

import { getFalconCredentials, getGbpCredentials, getYextCredentials } from './secrets';

const YEXT_BASE = 'https://api.yextapis.com/v2';
const YEXT_API_VERSION = '20230301';

export interface ResolvedParams {
  clientId: string;
  vcitaId: string | null;
  dudaSiteName: string | null;
  gbpLocationId: string | null;
  gbpOrg: string | null;  // which org account resolved the GBP location (agency/middleman/original/suspended)
  businessName: string;
}

// ── Falcon: resolve client directly by GPID (TI-13737) ───────────────────────
// Replaces the old Yext businessName → Falcon name-contains cascade.
// Uses the new externalServiceId reverse-lookup — "gpid" is the service name.
// TI-13738: Falcon guarantees the returned Duda externalServiceId is the active/published site.
async function getFalconClientByGpid(gpid: string): Promise<{
  clientId: string;
  vcitaId: string | null;
  dudaSiteName: string | null;
  businessName: string;
}> {
  const { apiKey, endpoint, headerName } = await getFalconCredentials();

  // ExternalServiceIdFilter shape confirmed via schema introspection:
  //   { gpId, dudaSiteName, vcitaBusinessId, yextId, sociAccountId, freshdeskCompanyId, pageRankUrl }
  // The field for GPID is `gpId` (camelCase). Not `id`, not `name`.
  const query = `
    query FindClientByGpid($gpid: String!) {
      clients(input: { filter: { externalServiceId: { gpId: $gpid } } }) {
        id
        name
        externalServiceIds { id name provider }
      }
    }
  `;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [headerName]: apiKey },
    body: JSON.stringify({ query, variables: { gpid } }),
  });

  if (!res.ok) throw new Error(`Falcon lookup failed for GPID ${gpid}: ${res.status}`);

  const json = await res.json() as {
    data?: { clients?: Array<{
      id: string;
      name: string;
      externalServiceIds: Array<{ id: string; name: string; provider: string | null }>;
    }> };
    errors?: { message: string }[];
  };

  if (json.errors?.length) throw new Error(`Falcon GraphQL error: ${json.errors[0].message}`);

  const client = json.data?.clients?.[0];
  if (!client) throw new Error(`No Falcon client found for GPID: ${gpid}`);

  // vcita hex UID — used as x-on-behalf-of header in vcita API calls
  const vcitaId = client.externalServiceIds.find(e => e.provider === 'vcita')?.name ?? null;
  // Duda site name — TI-13738 guarantees this is the active/published site when multiple exist
  const dudaSiteName = client.externalServiceIds.find(e => e.provider === 'duda')?.name ?? null;

  return { clientId: client.id, vcitaId, dudaSiteName, businessName: client.name };
}

// ── Yext: get Google Place ID + Account ID for GBP lookup ────────────────────
// Returns googlePlaceId (preferred — used for direct metadata.placeId filter in GBP)
// and googleAccountId (last-resort fallback for clients not in TSI agency account).
// Non-fatal — GBP will still attempt agency account lookup if this returns nulls.
interface YextLocationData {
  googleAccountId: string | null;
  googlePlaceId: string | null;
  mainPhone: string | null;    // normalized phone — used for GBP phone filter fallback
}

async function getYextLocationData(gpid: string): Promise<YextLocationData> {
  try {
    const { apiKey } = await getYextCredentials();
    const accountId = gpid.replace(/\s+/g, '');
    const entityId = `${accountId}-001`;
    const params = new URLSearchParams({ api_key: apiKey, v: YEXT_API_VERSION });

    const res = await fetch(
      `${YEXT_BASE}/accounts/${accountId}/entities/${entityId}?${params}`,
      { headers: { 'Content-Type': 'application/json' } }
    );

    if (!res.ok) return { googleAccountId: null, googlePlaceId: null, mainPhone: null };

    const data = await res.json() as {
      response?: {
        // googleAccountId can appear at top-level or nested under googleAttributes
        googleAttributes?: { googleAccountId?: string | number };
        googleAccountId?: string | number;
        googlePlaceId?: string;
        mainPhone?: string;   // Yext phone field variants
        phone?: string;
      };
    };

    const rawId =
      data.response?.googleAccountId ??
      data.response?.googleAttributes?.googleAccountId ??
      null;

    const rawPhone = data.response?.mainPhone ?? data.response?.phone ?? null;
    const mainPhone = rawPhone ? String(rawPhone).replace(/[^+\d]/g, '') || null : null;

    return {
      // Coerce to string — 18-digit integers exceed Number.MAX_SAFE_INTEGER as JS floats
      googleAccountId: rawId != null ? String(rawId) : null,
      googlePlaceId: data.response?.googlePlaceId ?? null,
      mainPhone,
    };
  } catch {
    return { googleAccountId: null, googlePlaceId: null, mainPhone: null };
  }
}

// ── GBP: search a single account for a location by Place ID ──────────────────
// Preferred lookup — Place ID is stable, exact, and shared between Yext and GBP metadata.
// Avoids name-mismatch fragility (Falcon name vs GBP title may differ).
async function searchGbpAccountByPlaceId(
  accountId: string,
  placeId: string,
  accessToken: string
): Promise<string | null> {
  const encodedFilter = encodeURIComponent(`metadata.placeId="${placeId}"`);
  const res = await fetch(
    `https://mybusinessbusinessinformation.googleapis.com/v1/${accountId}/locations?readMask=name,title&filter=${encodedFilter}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) return null;
  const data = await res.json() as { locations?: Array<{ name: string; title: string }> };
  return data.locations?.[0]?.name ?? null;
}

// ── GBP: search a single account for a location by business name ─────────────
// Fallback when Place ID is unavailable. Fragile — name mismatches between
// Falcon and GBP cause silent nulls. Kept for backwards compatibility.
async function searchGbpAccount(
  accountId: string,
  businessName: string,
  accessToken: string
): Promise<string | null> {
  const encodedFilter = encodeURIComponent(`title="${businessName}"`);
  const res = await fetch(
    `https://mybusinessbusinessinformation.googleapis.com/v1/${accountId}/locations?readMask=name,title&filter=${encodedFilter}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) return null;
  const data = await res.json() as { locations?: Array<{ name: string; title: string }> };
  return data.locations?.[0]?.name ?? null;
}

// ── GBP: exchange a refresh token for a short-lived access token ──────────────
async function refreshGbpToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  orgName: string
): Promise<string | null> {
  const tokRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!tokRes.ok) {
    const errText = await tokRes.text().catch(() => '');
    console.error(`[GBP] Token refresh FAILED for org "${orgName}": HTTP ${tokRes.status} — ${errText.slice(0, 200)}`);
    return null;
  }
  const { access_token } = await tokRes.json() as { access_token: string };
  return access_token;
}

// ── GBP: multi-org location lookup ───────────────────────────────────────────
// Searches all 4 TSI GBP org accounts in order: Agency → Middleman → Original → Suspended.
// Within each org, all location groups are searched using the full cascade:
//   placeId → storeCode (both formats) → phone → title-exact → title-contains
// Each strategy is exhausted across all accounts in an org before the next strategy is tried.
// This prevents a weak title match in account A from beating a clean storeCode match in account B.
async function getGbpLocationId(
  gpid: string,
  businessName: string,
  _fallbackGoogleAccountId: string | null,  // retained for signature compat — not used (no OAuth access to client accounts)
  googlePlaceId: string | null,
  mainPhone: string | null
): Promise<{ locationId: string; org: string } | null> {
  const creds = await getGbpCredentials();

  // Pre-compute title-contains search terms (used in step 5)
  const SUFFIX_WORDS = /\b(llc|inc|corp|ltd|co|company|companies|group|services|solutions|and|of|the|&|at|by)\b/gi;
  const cleanedName = businessName
    .replace(/[,.]/g, ' ')
    .replace(SUFFIX_WORDS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = cleanedName.split(/\s+/).filter(w => w.length > 1);
  const shortName = words.slice(0, 2).join(' ');

  // StoreCode variants — deduplicated in case gpid has no spaces
  const storeCodes = [...new Set([`${gpid}-001`, `${gpid.replace(/\s+/g, '')}-001`])];

  // Org definitions — searched in this order
  const orgs = [
    {
      name: 'agency',
      accounts: ['accounts/105329348540167006988'],
      refreshToken: creds.refreshToken,
    },
    {
      name: 'middleman',
      accounts: [
        'accounts/105184842354302665018',  // GBP TSI
        'accounts/115706322102031373902',  // MANAGER ACCESS ONLY
        'accounts/104352906497501100185',  // PRIMARY OWNER
      ],
      refreshToken: creds.refreshTokenMiddleman,
    },
    {
      name: 'original',
      accounts: [
        'accounts/110889275658012598851',  // TSIGMB
        'accounts/116740707640110849659',  // X - Don't Put New
        'accounts/109048502680893737205',  // Y - No Directory Listing
        'accounts/107749218258047067322',  // TRANSFER FROM LEGACY
      ],
      refreshToken: creds.refreshTokenOriginal,
    },
    {
      name: 'suspended',
      accounts: [
        'accounts/100171665983162263460',  // SUSPENDED GROUP
        'accounts/103754244781720486229',  // VERIFIED FROM SUSPENDED
        'accounts/113850092905456226575',  // NO CLIENT OWNER
        'accounts/115636265935701117146',  // Bad Store Codes
      ],
      refreshToken: creds.refreshTokenSuspended,
    },
  ];

  for (const org of orgs) {
    if (!org.refreshToken) {
      console.warn(`[GBP] Skipping org "${org.name}" — no refresh token configured`);
      continue;
    }

    const access_token = await refreshGbpToken(creds.clientId, creds.clientSecret, org.refreshToken, org.name);
    if (!access_token) continue;

    console.log(`[GBP] Searching org "${org.name}" (${org.accounts.length} account(s)) for ${gpid}`);

    // ── Step 1: Place ID ──────────────────────────────────────────────────────
    // Exact match on stable Google place ID — most reliable signal
    if (googlePlaceId) {
      for (const accountId of org.accounts) {
        const hit = await searchGbpAccountByPlaceId(accountId, googlePlaceId, access_token);
        if (hit) {
          console.log(`[GBP] placeId SUCCESS in org "${org.name}" (acct=${accountId}): ${hit}`);
          return { locationId: hit, org: org.name };
        }
      }
    }

    // ── Step 2: StoreCode ─────────────────────────────────────────────────────
    // Deterministic — storeCode = GPID + "-001". Try both formats (spaces preserved vs stripped).
    for (const storeCode of storeCodes) {
      const encodedSC = encodeURIComponent(`storeCode="${storeCode}"`);
      for (const accountId of org.accounts) {
        const scRes = await fetch(
          `https://mybusinessbusinessinformation.googleapis.com/v1/${accountId}/locations?readMask=name,title&filter=${encodedSC}`,
          { headers: { Authorization: `Bearer ${access_token}` } }
        );
        if (scRes.ok) {
          const scData = await scRes.json() as { locations?: Array<{ name: string }> };
          if (scData.locations?.[0]?.name) {
            console.log(`[GBP] storeCode SUCCESS in org "${org.name}" (format="${storeCode}"): ${scData.locations[0].name}`);
            return { locationId: scData.locations[0].name, org: org.name };
          }
        }
      }
    }
    console.log(`[GBP] storeCode: no results for ${gpid} in org "${org.name}" (tried: ${storeCodes.join(', ')})`);

    // ── Step 3: Phone ─────────────────────────────────────────────────────────
    // Reliable for clients with blank or CID-format storeCodes
    if (mainPhone && mainPhone.length >= 7) {
      const phoneFilter = encodeURIComponent(`phone="${mainPhone}"`);
      for (const accountId of org.accounts) {
        const phoneRes = await fetch(
          `https://mybusinessbusinessinformation.googleapis.com/v1/${accountId}/locations?readMask=name,title&filter=${phoneFilter}`,
          { headers: { Authorization: `Bearer ${access_token}` } }
        );
        if (phoneRes.ok) {
          const phoneData = await phoneRes.json() as { locations?: Array<{ name: string; title: string }> };
          if (phoneData.locations?.[0]?.name) {
            console.log(`[GBP] phone SUCCESS in org "${org.name}" (phone=${mainPhone}): ${phoneData.locations[0].name}`);
            return { locationId: phoneData.locations[0].name, org: org.name };
          }
        }
      }
    }

    // ── Step 4: Title exact ───────────────────────────────────────────────────
    // Fragile — name mismatches between Falcon and GBP cause silent nulls
    for (const accountId of org.accounts) {
      const hit = await searchGbpAccount(accountId, businessName, access_token);
      if (hit) {
        console.log(`[GBP] title-exact SUCCESS in org "${org.name}" (acct=${accountId}): ${hit}`);
        return { locationId: hit, org: org.name };
      }
    }

    // ── Step 5: Title-contains ────────────────────────────────────────────────
    // Last resort — strip suffix words, search by first 2 meaningful words then 1 word.
    // Validates overlap against businessName to avoid false positives.
    if (shortName.length >= 3) {
      for (const query of [shortName, words[0]].filter((q): q is string => !!q && q.length >= 3)) {
        const containsFilter = encodeURIComponent(`title:"${query}"`);
        for (const accountId of org.accounts) {
          const containsRes = await fetch(
            `https://mybusinessbusinessinformation.googleapis.com/v1/${accountId}/locations?readMask=name,title&filter=${containsFilter}`,
            { headers: { Authorization: `Bearer ${access_token}` } }
          );
          if (containsRes.ok) {
            const containsData = await containsRes.json() as { locations?: Array<{ name: string; title: string }> };
            const matched = containsData.locations?.find(loc => {
              const locTitle = loc.title?.toLowerCase() ?? '';
              const bizWords = businessName.toLowerCase().split(/\s+/).filter(w => w.length > 2);
              return bizWords.some(w => locTitle.includes(w));
            });
            if (matched?.name) {
              console.log(`[GBP] title-contains SUCCESS in org "${org.name}" (query="${query}", matched="${matched.title}"): ${matched.name}`);
              return { locationId: matched.name, org: org.name };
            }
          }
        }
      }
    }

    console.log(`[GBP] No match in org "${org.name}" for ${gpid} — trying next org`);
  }

  return null;
}

// ── Main: resolve everything from GPID ───────────────────────────────────────
export async function resolveFromGpid(gpid: string): Promise<ResolvedParams> {
  // Step 1: Falcon reverse-lookup — authoritative, no name-cascade fragility
  const { clientId, vcitaId, dudaSiteName, businessName } = await getFalconClientByGpid(gpid);

  // Step 2: Yext — returns googlePlaceId (preferred GBP key) + googleAccountId + mainPhone
  const googleData = await getYextLocationData(gpid).catch(
    () => ({ googleAccountId: null, googlePlaceId: null, mainPhone: null })
  );

  // Step 3: GBP — multi-org cascade: Agency → Middleman → Original → Suspended
  //         Within each org: placeId → storeCode (both formats) → phone → title-exact → title-contains
  const gbpResult = await getGbpLocationId(
    gpid, businessName,
    googleData.googleAccountId, googleData.googlePlaceId, googleData.mainPhone
  ).catch(() => null);

  const gbpLocationId = gbpResult?.locationId ?? null;
  const gbpOrg = gbpResult?.org ?? null;

  return { clientId, vcitaId, dudaSiteName, gbpLocationId, gbpOrg, businessName };
}

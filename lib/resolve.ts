// Dynamic resolution of all platform IDs from a GPID.
//
// Flow (updated for TI-13737 + TI-13738 + Place ID fix + Agency Account migration):
//   1. Falcon reverse-lookup: GPID → client directly via externalServiceId filter
//      Returns: clientId, vcitaId, dudaSiteName (active site per TI-13738), businessName
//   2. Yext entity: GPID → googleAccountId + googlePlaceId
//      googlePlaceId used for direct GBP lookup (fast, exact, no name-mismatch fragility)
//      googleAccountId kept as last-resort fallback
//   3. GBP lookup order:
//      a) Agency Account filtered by metadata.placeId (exact, fast — preferred)
//      b) Agency Account filtered by storeCode = GPID + "-001" (e.g. "TI ROOFIN047" → "TI ROOFIN047-001")
//      c) Agency Account filtered by title (name match — fragile fallback)
//      d) Client's own Google account filtered by title (rarely accessible, safety net)
//
// GBP OAuth account: gbp.agency@townsquaredigital.com (authorized 2026-05-21)
// Agency Account: accounts/105329348540167006988 — 9,638 TSI client locations
// StoreCode format: {GPID}-001 — SPACES PRESERVED (e.g. "TI ROOFIN047" → "TI ROOFIN047-001")
// Confirmed via GBP Manager screenshot 2026-06-01 — store code column shows spaces in storeCode

import { getFalconCredentials, getGbpCredentials, getYextCredentials } from './secrets';

const GBP_TSI_ACCOUNT = 'accounts/105329348540167006988'; // Agency Account (9,638 TSI locations — confirmed correct in gbp-auth-brief.md 2026-05-21)
const YEXT_BASE = 'https://api.yextapis.com/v2';
const YEXT_API_VERSION = '20230301';

export interface ResolvedParams {
  clientId: string;
  vcitaId: string | null;
  dudaSiteName: string | null;
  gbpLocationId: string | null;
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
  mainPhone: string | null;    // E.164 format — used for GBP phone filter fallback
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

    if (!res.ok) return { googleAccountId: null, googlePlaceId: null };

    const data = await res.json() as {
      response?: {
        // googleAccountId can appear at top-level or nested under googleAttributes
        googleAttributes?: { googleAccountId?: string | number };
        googleAccountId?: string | number;
        googlePlaceId?: string;
      };
    };

    const rawId =
      data.response?.googleAccountId ??
      data.response?.googleAttributes?.googleAccountId ??
      null;

    // Phone: Yext stores in various formats; normalize to E.164-compatible string
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

// ── GBP: find location ID — Place ID → storeCode → title → client account ────
// Lookup order:
//   1. Agency Account + metadata.placeId filter (exact, fast — preferred)
//   2. Agency Account + storeCode filter: GPID_no_spaces + "-001" (e.g. TIJULEEA001-001)
//   3. Agency Account + title filter (fragile — name mismatches cause silent nulls)
//   4. Client's own Google account + title filter (rarely accessible, safety net)
async function getGbpLocationId(
  gpid: string,
  businessName: string,
  fallbackGoogleAccountId: string | null,
  googlePlaceId: string | null,
  mainPhone: string | null
): Promise<string | null> {
  const creds = await getGbpCredentials();

  const tokRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!tokRes.ok) {
    const errText = await tokRes.text().catch(() => '');
    console.error(`[GBP] OAuth token refresh FAILED for ${gpid}: HTTP ${tokRes.status} — ${errText.slice(0, 200)}`);
    return null;
  }
  const { access_token } = await tokRes.json() as { access_token: string };
  console.log(`[GBP] OAuth token refreshed OK for ${gpid}`);

  // 1. Place ID lookup (preferred — exact, no name fragility)
  if (googlePlaceId) {
    const byPlaceId = await searchGbpAccountByPlaceId(GBP_TSI_ACCOUNT, googlePlaceId, access_token);
    if (byPlaceId) return byPlaceId;
  }

  // 2. StoreCode lookup — try both formats since TSI agency account has mixed history:
  //    New format (spaces preserved): "TI ROOFIN047-001" — confirmed working 2026-06-01
  //    Old format (spaces stripped):  "TIROOFIN047-001" — may exist for older onboarded clients
  for (const storeCode of [`${gpid}-001`, `${gpid.replace(/\s+/g, '')}-001`]) {
    const encodedSC = encodeURIComponent(`storeCode="${storeCode}"`);
    const scRes = await fetch(
      `https://mybusinessbusinessinformation.googleapis.com/v1/${GBP_TSI_ACCOUNT}/locations?readMask=name,title&filter=${encodedSC}`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    );
    if (scRes.ok) {
      const scData = await scRes.json() as { locations?: Array<{ name: string }> };
      if (scData.locations?.[0]?.name) {
        console.log(`[GBP] storeCode SUCCESS for ${gpid} (format="${storeCode}"): ${scData.locations[0].name}`);
        return scData.locations[0].name;
      }
    }
  }
  console.log(`[GBP] storeCode: 0 results for ${gpid} (tried both space-preserved and no-space formats)`);

  // 3. Name-based lookup — exact match first, then contains (handles "Eash Co. LLC" vs "Eash Co." mismatches)
  const byName = await searchGbpAccount(GBP_TSI_ACCOUNT, businessName, access_token);
  if (byName) return byName;

  // 3b. Title-contains fallback — uses AIP-160 `:` operator for partial match
  // Handles: Falcon name ("Eash Co. LLC") vs GBP name ("Eash Co."), blank storeCodes, CID storeCodes
  // Strategy: strip common suffix words (LLC, Inc, Corp, Co., Company, of, and, &, the, services, solutions)
  //           then take the first 2 meaningful words as the search term
  const SUFFIX_WORDS = /\b(llc|inc|corp|ltd|co|company|companies|group|services|solutions|and|of|the|&|at|by)\b/gi;
  const cleanedName = businessName
    .replace(/[,\.]/g, ' ')           // remove punctuation
    .replace(SUFFIX_WORDS, ' ')        // remove suffix/filler words
    .replace(/\s+/g, ' ')             // collapse spaces
    .trim();
  // Take first 2 words of cleaned name — specific enough to avoid false positives, forgiving of suffix differences
  const words = cleanedName.split(/\s+/).filter(w => w.length > 1);
  const shortName = words.slice(0, 2).join(' ');

  if (shortName.length >= 3) {
    // Try the 2-word contains, then fall back to first word only if no match
    for (const query of [shortName, words[0]].filter(Boolean)) {
      if (!query || query.length < 3) continue;
      const containsFilter = encodeURIComponent(`title:"${query}"`);
      const containsRes = await fetch(
        `https://mybusinessbusinessinformation.googleapis.com/v1/${GBP_TSI_ACCOUNT}/locations?readMask=name,title&filter=${containsFilter}`,
        { headers: { Authorization: `Bearer ${access_token}` } }
      );
      if (containsRes.ok) {
        const containsData = await containsRes.json() as { locations?: Array<{ name: string; title: string }> };
        // Only use the result if the returned title meaningfully overlaps with businessName (avoid false positives)
        const matched = containsData.locations?.find(loc => {
          const locTitle = loc.title?.toLowerCase() ?? '';
          const bizWords = businessName.toLowerCase().split(/\s+/).filter(w => w.length > 2);
          return bizWords.some(w => locTitle.includes(w));
        });
        if (matched?.name) {
          console.log(`[GBP] title-contains SUCCESS for ${gpid} (query="${query}", matched="${matched.title}"): ${matched.name}`);
          return matched.name;
        }
      }
    }
  }

  // Note: individual client Google accounts are NOT searched — TSI's OAuth credentials
  // (gbp.agency@townsquaredigital.com) do not have access to client-owned accounts.
  // fallbackGoogleAccountId from Yext is retained in case TSI ever gains that access,
  // but it is not used in the lookup chain.

  return null;
}

// ── Main: resolve everything from GPID ───────────────────────────────────────
export async function resolveFromGpid(gpid: string): Promise<ResolvedParams> {
  // Step 1: Falcon reverse-lookup — authoritative, no name-cascade fragility
  const { clientId, vcitaId, dudaSiteName, businessName } = await getFalconClientByGpid(gpid);

  // Step 2: Yext — returns googlePlaceId (preferred GBP key) + googleAccountId (fallback)
  const googleData = await getYextLocationData(gpid).catch(
    () => ({ googleAccountId: null, googlePlaceId: null })
  );

  // Step 3: GBP — Place ID → storeCode → name → client account fallback
  const gbpLocationId = await getGbpLocationId(gpid, businessName, googleData.googleAccountId, googleData.googlePlaceId, googleData.mainPhone).catch(() => null);

  return { clientId, vcitaId, dudaSiteName, gbpLocationId, businessName };
}

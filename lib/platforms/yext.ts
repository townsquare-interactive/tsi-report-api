// Yext platform fetcher
// Account ID = GPID with spaces removed (e.g. "TI CASAED001" → "TICASAED001")
// Correct base URL: api.yextapis.com (NOT api.yext.com)
// Listings endpoint: /powerlistings/listings (NOT /powerlistings/publisherstatus)
// Analytics endpoint: /analytics/reports (POST)

import type { YextListingsData, YextActionBreakdown } from '@/types/report';
import { getYextCredentials } from '../secrets';

const YEXT_BASE = 'https://api.yextapis.com/v2';
const API_VERSION = '20230301';

interface YextListing {
  status: string;
}

interface YextAnalyticsRow {
  MONTHS?: string;
  // Yext API quirk: TOTAL_LISTINGS_IMPRESSIONS comes back as title-case in the response
  'Total Listings Impressions'?: number;
  TOTAL_LISTINGS_ACTIONS?: number;
  LISTINGS_ACCURACY?: number;
  POWERLISTINGS_LIVE?: number;
}

interface YextActionRow {
  ACTION?: string;
  TOTAL_LISTINGS_ACTIONS?: number;
}

export async function getYextData(gpid: string, periodDays = 90): Promise<YextListingsData> {
  const { apiKey } = await getYextCredentials();

  const accountId = gpid.replace(/\s+/g, '');
  const params = new URLSearchParams({ api_key: apiKey, v: API_VERSION });

  // Build date range for analytics — Yext returns zero rows without explicit dates
  const endDate = new Date();
  const startDate = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().split('T')[0]; // YYYY-MM-DD

  // Get entity ID for this sub-account
  const entitiesRes = await fetch(
    `${YEXT_BASE}/accounts/${accountId}/entities?${params}&entityTypes=location&limit=1`,
    { signal: AbortSignal.timeout(10_000), headers: { 'Content-Type': 'application/json' } }
  );

  if (!entitiesRes.ok) {
    throw new Error(`Yext entities request failed: ${entitiesRes.status} for account ${accountId}`);
  }

  const entitiesData = await entitiesRes.json() as {
    response?: { entities?: Array<{ meta: { id: string } }> };
  };
  const entity = entitiesData.response?.entities?.[0];

  if (!entity) {
    return {
      locationId: null, syncedListings: 0, totalListings: 0, averageScore: null,
      impressions: 0, actions: 0, accuracy: null, actionBreakdown: null,
    };
  }

  const locationId = entity.meta.id;

  // Fetch listings sync status, aggregate analytics, and action breakdown in parallel
  const analyticsBody = {
    // NOTE: TOTAL_LISTINGS_IMPRESSIONS and TOTAL_LISTINGS_ACTIONS are incompatible
    // with the locationIds filter — they return zero/null when that filter is present.
    // Since each TSI sub-account has exactly one location, omitting locationIds is safe.
    // startDate/endDate are required — Yext returns empty rows without a date range.
    filters: { startDate: fmt(startDate), endDate: fmt(endDate) },
  };

  const [listingsRes, analyticsRes, actionBreakdownRes] = await Promise.all([
    fetch(
      `${YEXT_BASE}/accounts/${accountId}/powerlistings/listings?${params}&locationIds=${locationId}`,
      { signal: AbortSignal.timeout(10_000), headers: { 'Content-Type': 'application/json' } }
    ),
    fetch(
      `${YEXT_BASE}/accounts/${accountId}/analytics/reports?${params}`,
      {
        signal: AbortSignal.timeout(10_000),
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...analyticsBody,
          metrics: ['TOTAL_LISTINGS_IMPRESSIONS', 'TOTAL_LISTINGS_ACTIONS', 'LISTINGS_ACCURACY', 'POWERLISTINGS_LIVE'],
          dimensions: ['MONTHS'],
        }),
      }
    ),
    fetch(
      `${YEXT_BASE}/accounts/${accountId}/analytics/reports?${params}`,
      {
        signal: AbortSignal.timeout(10_000),
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...analyticsBody,
          metrics: ['TOTAL_LISTINGS_ACTIONS'],
          dimensions: ['ACTION'],
        }),
      }
    ),
  ]);

  let syncedListings = 0;
  let totalListings = 0;

  if (listingsRes.ok) {
    const listingsData = await listingsRes.json() as {
      response?: { listings?: YextListing[]; count?: number };
    };
    const listings = listingsData.response?.listings ?? [];
    syncedListings = listings.filter((l) => l.status === 'LIVE').length;
    totalListings = listingsData.response?.count ?? listings.length;
  }

  let impressions = 0;
  let actions = 0;
  let accuracy: number | null = null;
  let actionBreakdown: YextActionBreakdown | null = null;

  if (analyticsRes.ok) {
    const analyticsData = await analyticsRes.json() as {
      response?: { data?: YextAnalyticsRow[] };
    };
    const rows = analyticsData.response?.data ?? [];
    if (rows.length > 0) {
      // Sum impressions and actions across all months in the period
      impressions = rows.reduce((s, r) => s + (r['Total Listings Impressions'] ?? 0), 0);
      actions = rows.reduce((s, r) => s + (r.TOTAL_LISTINGS_ACTIONS ?? 0), 0);
      // Accuracy is a snapshot value — use the most recent non-null month
      const lastWithAccuracy = [...rows].reverse().find(r => r.LISTINGS_ACCURACY != null);
      accuracy = lastWithAccuracy?.LISTINGS_ACCURACY ?? null;
    }
  }

  if (actionBreakdownRes.ok) {
    const breakdownData = await actionBreakdownRes.json() as {
      response?: { data?: YextActionRow[] };
    };
    const rows = breakdownData.response?.data ?? [];
    if (rows.length > 0) {
      actionBreakdown = {
        tapToCall: rows.find(r => r.ACTION === 'Tap to Call')?.TOTAL_LISTINGS_ACTIONS ?? 0,
        drivingDirections: rows.find(r => r.ACTION === 'Driving Directions')?.TOTAL_LISTINGS_ACTIONS ?? 0,
        website: rows.find(r => r.ACTION === 'Website')?.TOTAL_LISTINGS_ACTIONS ?? 0,
      };
    }
  }
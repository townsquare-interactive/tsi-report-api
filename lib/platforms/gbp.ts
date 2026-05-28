// Google Business Profile platform fetcher
// Uses OAuth credentials from Secrets Manager + getDailyMetricsTimeSeries per metric

import type { GbpInsights, GbpReview } from '@/types/report';
import { getGbpCredentials } from '../secrets';

const GBP_PERF_BASE = 'https://businessprofileperformance.googleapis.com/v1';
const GBP_MY_BUSINESS = 'https://mybusiness.googleapis.com/v4';

interface GbpTokenResponse {
  access_token: string;
}

async function getAccessToken(): Promise<string> {
  const creds = await getGbpCredentials();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`GBP token refresh failed: ${res.status}`);
  const data = await res.json() as GbpTokenResponse;
  return data.access_token;
}

async function getDailyMetric(
  locationId: string,
  metric: string,
  startDate: Date,
  endDate: Date,
  accessToken: string
): Promise<number> {
  const params = new URLSearchParams({
    dailyMetric: metric,
    'dailyRange.start_date.year': String(startDate.getFullYear()),
    'dailyRange.start_date.month': String(startDate.getMonth() + 1),
    'dailyRange.start_date.day': String(startDate.getDate()),
    'dailyRange.end_date.year': String(endDate.getFullYear()),
    'dailyRange.end_date.month': String(endDate.getMonth() + 1),
    'dailyRange.end_date.day': String(endDate.getDate()),
  });

  const res = await fetch(
    `${GBP_PERF_BASE}/${locationId}:getDailyMetricsTimeSeries?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!res.ok) return 0;

  const data = await res.json() as {
    timeSeries?: { datedValues?: Array<{ value?: string }> };
  };

  return (data.timeSeries?.datedValues ?? []).reduce(
    (sum, d) => sum + parseInt(d.value ?? '0', 10),
    0
  );
}

// Fetches the top search queries that triggered impressions for this location.
// Uses the GBP Performance API searchkeywords/impressions/monthly endpoint —
// separate from getDailyMetricsTimeSeries, same OAuth credentials.
// Returns top 5 by impression count. Returns [] on any failure — never throws.
// Note: Google suppresses keywords below their minimum threshold (typically ~10-25
// impressions); these are filtered out (threshold: true entries are dropped).
async function getGbpSearchKeywords(
  locationId: string,
  periodDays: number,
  accessToken: string
): Promise<Array<{ keyword: string; impressions: number }>> {
  const endDate = new Date();
  const startDate = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);

  const params = new URLSearchParams({
    'monthlyRange.start_month.year':  String(startDate.getFullYear()),
    'monthlyRange.start_month.month': String(startDate.getMonth() + 1),
    'monthlyRange.end_month.year':    String(endDate.getFullYear()),
    'monthlyRange.end_month.month':   String(endDate.getMonth() + 1),
  });

  try {
    const res = await fetch(
      `${GBP_PERF_BASE}/${locationId}/searchkeywords/impressions/monthly?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) return [];

    const data = await res.json() as {
      searchKeywordsCounts?: Array<{
        searchKeyword: string;
        insightsValue: { value?: string; threshold?: boolean };
      }>;
    };

    return (data.searchKeywordsCounts ?? [])
      .filter((k) => !k.insightsValue.threshold)   // drop below-threshold entries
      .map((k) => ({
        keyword: k.searchKeyword,
        impressions: parseInt(k.insightsValue.value ?? '0', 10),
      }))
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 5);
  } catch {
    return [];
  }
}

export async function getGbpInsights(
  locationId: string,
  periodDays: number
): Promise<GbpInsights> {
  const accessToken = await getAccessToken();
  const endDate = new Date();
  const startDate = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);

  const metrics = [
    'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
    'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
    'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
    'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
    'CALL_CLICKS',
    'WEBSITE_CLICKS',
    'BUSINESS_DIRECTION_REQUESTS',
  ] as const;

  const [metricValues, postsLive, searchKeywords] = await Promise.all([
    Promise.all(metrics.map((m) => getDailyMetric(locationId, m, startDate, endDate, accessToken))),
    getGbpPostsLive(locationId, accessToken),
 
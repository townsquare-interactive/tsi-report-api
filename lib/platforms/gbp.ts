// Google Business Profile platform fetcher
// Uses OAuth credentials from Secrets Manager + getDailyMetricsTimeSeries per metric

import type { GbpInsights, GbpReview } from '@/types/report';
import { getGbpCredentials } from '../secrets';

const GBP_PERF_BASE = 'https://businessprofileperformance.googleapis.com/v1';
const GBP_MY_BUSINESS = 'https://mybusiness.googleapis.com/v4';

interface GbpTokenResponse {
  access_token: string;
}

// org: which TSI GBP org account resolved this location (agency/middleman/original/suspended).
// Defaults to agency if omitted or unrecognized — preserves backwards compat.
async function getAccessToken(org?: string | null): Promise<string> {
  const creds = await getGbpCredentials();
  let refreshToken = creds.refreshToken; // agency default
  if (org === 'middleman' && creds.refreshTokenMiddleman) refreshToken = creds.refreshTokenMiddleman;
  else if (org === 'original' && creds.refreshTokenOriginal) refreshToken = creds.refreshTokenOriginal;
  else if (org === 'suspended' && creds.refreshTokenSuspended) refreshToken = creds.refreshTokenSuspended;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    signal: AbortSignal.timeout(8_000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`GBP token refresh failed (org=${org ?? 'agency'}): ${res.status}`);
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
    { signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${accessToken}` } }
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

async function getGbpSearchKeywords(
  locationId: string,
  periodDays: number,
  accessToken: string
): Promise<Array<{ keyword: string; impressions: number }>> {
  try {
    const endDate = new Date();
    const startDate = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);

    // Build monthlyRange parameters covering the period
    const params = new URLSearchParams({
      'monthlyRange.start_month.year': String(startDate.getFullYear()),
      'monthlyRange.start_month.month': String(startDate.getMonth() + 1),
      'monthlyRange.end_month.year': String(endDate.getFullYear()),
      'monthlyRange.end_month.month': String(endDate.getMonth() + 1),
    });

    const res = await fetch(
      `${GBP_PERF_BASE}/${locationId}/searchkeywords/impressions/monthly?${params}`,
      { signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!res.ok) return [];

    const data = await res.json() as {
      searchKeywordsCounts?: Array<{
        searchKeyword: string;
        insightsValue?: { threshold?: boolean; value?: string };
      }>;
    };

    return (data.searchKeywordsCounts ?? [])
      .filter(k => !k.insightsValue?.threshold)
      .map(k => ({
        keyword: k.searchKeyword,
        impressions: parseInt(k.insightsValue?.value ?? '0', 10),
      }))
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 5);
  } catch {
    return [];
  }
}

export async function getGbpInsights(
  locationId: string,
  periodDays: number,
  org?: string | null
): Promise<GbpInsights> {
  const accessToken = await getAccessToken(org);
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
    getGbpSearchKeywords(locationId, periodDays, accessToken),
  ]);

  const [deskMaps, mobMaps, deskSearch, mobSearch, calls, websites, directions] = metricValues;

  return {
    businessImpressions: deskMaps + mobMaps + deskSearch + mobSearch,
    mapImpressions: deskMaps + mobMaps,
    searchImpressions: deskSearch + mobSearch,
    callClicks: calls,
    websiteClicks: websites,
    directionRequests: directions,
    postsLive,
    periodStart: startDate.toISOString(),
    periodEnd: endDate.toISOString(),
    searchKeywords: searchKeywords.length > 0 ? searchKeywords : null,
  };
}

export async function getGbpPostsLive(locationId: string, accessToken?: string): Promise<number> {
  const token = accessToken ?? await getAccessToken();
  const res = await fetch(
    `${GBP_MY_BUSINESS}/accounts/me/${locationId}/localPosts?pageSize=20`,
    { signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return 0;
  const data = await res.json() as { localPosts?: Array<{ state?: string }> };
  return (data.localPosts ?? []).filter((p) => p.state === 'LIVE').length;
}

export async function getGbpReviews(locationId: string, org?: string | null): Promise<GbpReview[]> {
  const accessToken = await getAccessToken(org);

  // locationId format: "locations/123..." — derive account path for v4 API
  const res = await fetch(
    `${GBP_MY_BUSINESS}/accounts/me/${locationId}/reviews?pageSize=10`,
    { signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!res.ok) return [];

  const data = await res.json() as {
    reviews?: Array<{
      reviewId: string;
      starRating: string;
      comment?: string;
      reviewer?: { displayName?: string };
      createTime: string;
      reviewReply?: { comment: string };
    }>;
  };

  return (data.reviews ?? []).map((r) => ({
    reviewId: r.reviewId,
    rating: r.starRating,
    comment: r.comment ?? null,
    reviewer: r.reviewer?.displayName ?? 'Anonymous',
    createTime: r.createTime,
    hasReply: !!r.reviewReply,
  }));
}


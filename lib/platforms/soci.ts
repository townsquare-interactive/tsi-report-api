// SOCI social media platform integration
// Auth: soci-key header
// Base URL: https://app.meetsoci.com/api
// TSI account ID: 3232
//
// Endpoints used:
//   GET /account/3232/get_projects                         — list/search all locations (GPID field per project)
//   GET /project/{id}/get                                  — location details
//   GET /project/{id}/remote_list                          — connected social network profiles; fb_pages[0].remote_network_id is the FB network ID
//   GET /promote/{project_id}/get                          — scheduled + recently sent posts
//   GET /project/{id}/get_page_metrics_summary             — reach, engaged, fans (2-week comparison)
//   GET /project/{id}/get_engagement_sentiment_summary     — positive/neutral/negative + avg_sentiment
//   GET /project/{id}/get_peak_time_summary                — hourly fan activity [hour, value]
//   GET /project/{id}/get_fan_engagement_demographics_summary — gender/age breakdown for fans + engaged
//   GET /reviews/{id}/get_dashboard_reviews_count_by_network  — review count by social/review network
//   GET /facebook/{network_id}/get_insights                — full FB page metrics (fans, impressions, engaged + prev/change deltas)
//   GET /facebook/{network_id}/top_posts                   — top posts by impressions
//
// GPID lookup: get_projects?search={gpid}, filter by GPID field (e.g. "TI CASAED001").
// FB network ID: remote_list → fb_pages[0].remote_network_id (SOCi internal ID, NOT the Facebook page ID)

import { getSociCredentials } from '../secrets';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface SociPost {
  id: number;
  network: string;        // facebook | instagram | gmb | twitter | linkedin
  message: string;
  scheduledTime: string;  // local timezone
  sent: string | null;    // populated when already sent
  approved: boolean;
}

export interface SociPageMetrics {
  // 2-week rolling window comparison
  reach28day: number;
  reachPrev28day: number;
  reachChange28day: number;
  reachChangePct28day: number;
  engagedUsers28day: number;
  engagedUsersPrev28day: number;
  pageLikes: number;
  pageLikesPrev: number;
  pageLikesChange: number;
}

export interface SociFbInsights {
  // Fans
  pageFansDay: number;
  pageFansWeek: number;
  pageFans28day: number;
  pageFansChange28day: number;
  pageFansChangePct28day: number;
  // Impressions
  pageImpressionsWeek: number;
  pageImpressions28day: number;
  pageImpressionsChangePct28day: number;
  // Engagement
  pageEngagedUsersWeek: number;
  pageEngagedUsers28day: number;
  pagePostEngagements28day: number;
  // Post impressions
  pagePostsImpressions28day: number;
  pagePostsImpressionsChangePct28day: number;
}

export interface SociTopPost {
  id: string;
  message: string;
  impressions: number;
  impressionsOrganic: number;
  impressionsViral: number;
  engagedUsers: number;
  postClicks: number;
  scheduledTime: string;
}

export interface SociSentiment {
  positive: number;
  neutral: number;
  negative: number;
  avgSentiment: number;
}

export interface SociPeakHour {
  hour: number;   // 0–23
  value: number;  // relative fan activity
}

export interface SociDemographics {
  women: { total: number; byAge: Record<string, number> };
  men:   { total: number; byAge: Record<string, number> };
}

export interface SociData {
  projectId: string;
  fbNetworkId: string | null;

  // Scheduling
  upcomingPostCount: number;
  recentlySentCount: number;
  scheduledNetworks: string[];
  upcomingPosts: SociPost[];

  // Engagement analytics (null if fetch failed)
  pageMetrics: SociPageMetrics | null;
  fbInsights: SociFbInsights | null;
  topPosts: SociTopPost[];
  sentiment: SociSentiment | null;
  peakHours: SociPeakHour[];
  demographics: SociDemographics | null;
  reviewCounts: Record<string, number>;

  periodStart: string;
  periodEnd: string;
}

// ─── Raw API types ─────────────────────────────────────────────────────────────

interface RawSociPost {
  id: number;
  network: string;
  message: string;
  schedule: string;
  sent: string;
  customer_approved: string | number;
  manager_approved: string | number;
  deleted: number;
}

interface RawTopPost {
  id: string;
  message: string;
  post_impressions: string;
  post_impressions_organic: string;
  post_impressions_viral: string;
  post_engaged_users: string;
  post_clicks: string;
  schedule: string;
  timestamp: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeNum(v: unknown): number {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

async function sociGet<T = unknown>(
  url: string,
  apiKey: string,
  params: Record<string, string> = {}
): Promise<T | null> {
  try {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const r = await fetch(u.toString(), {
      headers: { 'soci-key': apiKey, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    return r.json().catch(() => null) as Promise<T | null>;
  } catch {
    return null;
  }
}

// ─── GPID → project ID lookup ────────────────────────────────────────────────

async function findSociProjectId(
  gpid: string,
  businessName: string,
  apiKey: string,
  baseUrl: string,
  accountId: string
): Promise<string | null> {
  async function search(q: string): Promise<{ id: string; gpid: string }[]> {
    const data = await sociGet<unknown[]>(
      `${baseUrl}/account/${accountId}/get_projects`,
      apiKey,
      { search: q, page: '1', per_page: '50' }
    );
    if (!Array.isArray(data)) return [];
    return data.map((p) => {
      const proj = p as Record<string, unknown>;
      return {
        id: String(proj.id ?? ''),
        gpid: String(proj['GPID'] ?? '').trim(),
      };
    });
  }

  const byGpid = await search(gpid);
  const exactByGpid = byGpid.find(p => p.gpid === gpid);
  if (exactByGpid) return exactByGpid.id;

  const byName = await search(businessName);
  const exactByName = byName.find(p => p.gpid === gpid);
  if (exactByName) return exactByName.id;

  return null;
}

// ─── Fetch functions ──────────────────────────────────────────────────────────

async function fetchFbNetworkId(
  projectId: string,
  apiKey: string,
  baseUrl: string
): Promise<string | null> {
  const data = await sociGet<{ fb_pages?: Array<{ remote_network_id: string }> }>(
    `${baseUrl}/project/${projectId}/remote_list`,
    apiKey
  );
  return data?.fb_pages?.[0]?.remote_network_id ?? null;
}

async function fetchPosts(
  projectId: string,
  apiKey: string,
  baseUrl: string
): Promise<SociPost[]> {
  const data = await sociGet<unknown[]>(
    `${baseUrl}/promote/${projectId}/get`,
    apiKey,
    { limit: '50' }
  );
  if (!Array.isArray(data)) return [];
  return (data as RawSociPost[])
    .filter(p => !p.deleted)
    .map(p => ({
      id: p.id,
      network: p.network ?? 'unknown',
      message: (p.message ?? '').substring(0, 300),
      scheduledTime: p.schedule ?? '',
      sent: p.sent && p.sent !== '0000-00-00 00:00:00' ? p.sent : null,
      approved: Number(p.manager_approved) === 1,
    }));
}

async function fetchPageMetrics(
  projectId: string,
  apiKey: string,
  baseUrl: string
): Promise<SociPageMetrics | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = await sociGet<any>(`${baseUrl}/project/${projectId}/get_page_metrics_summary`, apiKey);
  if (!d) return null;
  return {
    reach28day: safeNum(d.reach_28day ?? d.reach),
    reachPrev28day: safeNum(d.reach_28day_prev ?? d.reach_prev),
    reachChange28day: safeNum(d.reach_28day_change ?? d.reach_change),
    reachChangePct28day: safeNum(d.reach_28day_perc ?? d.reach_perc),
    engagedUsers28day: safeNum(d.engaged_28day ?? d.engaged),
    engagedUsersPrev28day: safeNum(d.engaged_28day_prev ?? d.engaged_prev),
    pageLikes: safeNum(d.page_likes ?? d.likes),
    pageLikesPrev: safeNum(d.page_likes_prev ?? d.likes_prev),
    pageLikesChange: safeNum(d.page_likes_change ?? d.likes_change),
  };
}

async function fetchFbInsights(
  networkId: string,
  apiKey: string,
  baseUrl: string
): Promise<SociFbInsights | null> {
  const today = new Date().toISOString().split('T')[0];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = await sociGet<any>(
    `${baseUrl}/facebook/${networkId}/get_insights`,
    apiKey,
    { as_of_date: today }
  );
  if (!d) return null;
  return {
    pageFansDay: safeNum(d.page_fans_day),
    pageFansWeek: safeNum(d.page_fans_week),
    pageFans28day: safeNum(d.page_fans_days_28),
    pageFansChange28day: safeNum(d.page_fans_days_28_change),
    pageFansChangePct28day: safeNum(d.page_fans_days_28_perc),
    pageImpressionsWeek: safeNum(d.page_impressions_week),
    pageImpressions28day: safeNum(d.page_impressions_days_28),
    pageImpressionsChangePct28day: safeNum(d.page_impressions_days_28_perc),
    pageEngagedUsersWeek: safeNum(d.page_engaged_users_week),
    pageEngagedUsers28day: safeNum(d.page_engaged_users_days_28),
    pagePostEngagements28day: safeNum(d.page_post_engagements_days_28),
    pagePostsImpressions28day: safeNum(d.page_posts_impressions_days_28),
    pagePostsImpressionsChangePct28day: safeNum(d.page_posts_impressions_days_28_perc),
  };
}

async function fetchTopPosts(
  networkId: string,
  apiKey: string,
  baseUrl: string
): Promise<SociTopPost[]> {
  const today = new Date().toISOString().split('T')[0];
  const thirtyAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const data = await sociGet<unknown[]>(
    `${baseUrl}/facebook/${networkId}/top_posts`,
    apiKey,
    { since: thirtyAgo, until: today, limit: '5' }
  );
  if (!Array.isArray(data)) return [];
  return (data as RawTopPost[]).map(p => ({
    id: p.id,
    message: (p.message ?? '').substring(0, 200),
    impressions: safeNum(p.post_impressions),
    impressionsOrganic: safeNum(p.post_impressions_organic),
    impressionsViral: safeNum(p.post_impressions_viral),
    engagedUsers: safeNum(p.post_engaged_users),
    postClicks: safeNum(p.post_clicks),
    scheduledTime: p.schedule || p.timestamp || '',
  }));
}

async function fetchSentiment(
  projectId: string,
  apiKey: string,
  baseUrl: string
): Promise<SociSentiment | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = await sociGet<any>(
    `${baseUrl}/project/${projectId}/get_engagement_sentiment_summary`,
    apiKey
  );
  if (!d) return null;
  return {
    positive: safeNum(d.positive),
    neutral: safeNum(d.neutral),
    negative: safeNum(d.negative),
    avgSentiment: safeNum(d.avg_sentiment ?? d.average_sentiment),
  };
}

async function fetchPeakTimes(
  projectId: string,
  apiKey: string,
  baseUrl: string
): Promise<SociPeakHour[]> {
  const data = await sociGet<unknown[]>(
    `${baseUrl}/project/${projectId}/get_peak_time_summary`,
    apiKey
  );
  if (!Array.isArray(data)) return [];
  return data
    .map((entry: unknown) => {
      if (Array.isArray(entry) && entry.length >= 2) {
        return { hour: safeNum(entry[0]), value: safeNum(entry[1]) };
      }
      return null;
    })
    .filter((e): e is SociPeakHour => e !== null);
}

async function fetchDemographics(
  projectId: string,
  apiKey: string,
  baseUrl: string
): Promise<SociDemographics | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = await sociGet<any>(
    `${baseUrl}/project/${projectId}/get_fan_engagement_demographics_summary`,
    apiKey
  );
  if (!d?.data) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parseGroup = (g: Record<string, any>) => {
    const ages = ['13-17', '18-24', '25-34', '35-44', '45-54', '55-64', '65+'];
    const byAge: Record<string, number> = {};
    for (const age of ages) byAge[age] = safeNum(g?.fans?.[age]);
    return { total: safeNum(g?.fans?.total), byAge };
  };
  return {
    women: parseGroup(d.data.women),
    men: parseGroup(d.data.men),
  };
}

async function fetchReviewCounts(
  projectId: string,
  apiKey: string,
  baseUrl: string
): Promise<Record<string, number>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = await sociGet<any>(
    `${baseUrl}/reviews/${projectId}/get_dashboard_reviews_count_by_network`,
    apiKey,
    { scope: 'project', scope_id: projectId }
  );
  if (!d || typeof d !== 'object') return {};
  // Response shape: { facebook: 36, google: 12, ... } or nested
  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(d)) {
    if (typeof v === 'number') counts[k] = v;
    else if (typeof v === 'object' && v !== null && 'count' in v) {
      counts[k] = safeNum((v as { count: number }).count);
    }
  }
  return counts;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function getSociData(gpid: string, businessName: string): Promise<SociData | null> {
  try {
    const { apiKey, baseUrl, accountId } = await getSociCredentials();

    const projectId = await findSociProjectId(gpid, businessName, apiKey, baseUrl, accountId);
    if (!projectId) return null;

    const now = new Date();
    const periodStart = now.toISOString().split('T')[0];
    const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Phase 1: get FB network ID (needed for insights + top_posts)
    const fbNetworkId = await fetchFbNetworkId(projectId, apiKey, baseUrl);

    // Phase 2: fetch everything in parallel
    const [
      posts,
      pageMetrics,
      fbInsights,
      topPosts,
      sentiment,
      peakHours,
      demographics,
      reviewCounts,
    ] = await Promise.all([
      fetchPosts(projectId, apiKey, baseUrl),
      fetchPageMetrics(projectId, apiKey, baseUrl),
      fbNetworkId ? fetchFbInsights(fbNetworkId, apiKey, baseUrl) : Promise.resolve(null),
      fbNetworkId ? fetchTopPosts(fbNetworkId, apiKey, baseUrl) : Promise.resolve([]),
      fetchSentiment(projectId, apiKey, baseUrl),
      fetchPeakTimes(projectId, apiKey, baseUrl),
      fetchDemographics(projectId, apiKey, baseUrl),
      fetchReviewCounts(projectId, apiKey, baseUrl),
    ]);

    const upcoming = posts.filter(p => !p.sent && new Date(p.scheduledTime) > now);
    const recentlySent = posts.filter(p => p.sent !== null);
    const scheduledNetworks = [...new Set(posts.map(p => p.network))];

    return {
      projectId,
      fbNetworkId,
      upcomingPostCount: upcoming.length,
      recentlySentCount: recentlySent.length,
      scheduledNetworks,
      upcomingPosts: upcoming.slice(0, 10),
      pageMetrics,
      fbInsights,
      topPosts,
      sentiment,
      peakHours,
      demographics,
      reviewCounts,
      periodStart,
      periodEnd,
    };
  } catch {
    return null;
  }
}

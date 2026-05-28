// Duda platform fetcher
// Uses site_name directly (Duda internal identifier, e.g. "932be2da")
// Partner API does NOT support domain-based lookup — always use site_name
// Find site_name via Duda MCP get_site_details or admin dashboard URL /home/site/{site_name}

import type { DudaSiteStats, DudaPage } from '@/types/report';
import { getDudaCredentials } from '../secrets';

interface DudaSiteDetails {
  site_name: string;
  site_domain: string;
  last_published_date: string | null;
  publish_status: string;
}

interface DudaStats {
  VISITORS?: number;
  VISITS?: number;
  PAGE_VIEWS?: number;
}

interface DudaBlogPost {
  id?: string;
  title?: string;
  url?: string;
  publish_date?: string;
  status?: string;
}

interface DudaPage {
  uuid?: string;
  title?: string;
  path?: string;
  page_url?: string;
}

interface DudaActivity {
  activity?: string;
  source?: string;
  timestamp?: string;
  comment?: string;
}

export async function getDudaData(
  siteName: string,
  periodDays: number
): Promise<DudaSiteStats> {
  const { username, password, baseUrl } = await getDudaCredentials();

  const authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  const headers = { Authorization: authHeader, 'Content-Type': 'application/json' };

  const endDate = new Date();
  const startDate = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);
  const from = startDate.toISOString().split('T')[0];
  const to = endDate.toISOString().split('T')[0];

  // Fetch all data in parallel
  const opts = { signal: AbortSignal.timeout(10_000), headers };
  const [siteRes, statsRes, blogRes, pagesRes, activitiesRes] = await Promise.all([
    fetch(`${baseUrl}/api/sites/multiscreen/${encodeURIComponent(siteName)}`, opts),
    fetch(`${baseUrl}/api/analytics/site/${encodeURIComponent(siteName)}?from=${from}&to=${to}`, opts),
    fetch(`${baseUrl}/api/sites/multiscreen/blog/${encodeURIComponent(siteName)}/post`, opts),
    fetch(`${baseUrl}/api/sites/multiscreen/${encodeURIComponent(siteName)}/pages`, opts),
    fetch(`${baseUrl}/api/sites/multiscreen/${encodeURIComponent(siteName)}/activity?limit=50`, opts),
  ]);

  let site: DudaSiteDetails | null = null;
  if (siteRes.ok) {
    site = await siteRes.json() as DudaSiteDetails;
    if (site.publish_status !== 'PUBLISHED') {
      throw new Error(`Duda site ${siteName} is not published (status: ${site.publish_status}) — check Falcon websites mapping`);
    }
  }

  let stats: DudaStats = {};
  if (statsRes.ok) {
    try { stats = await statsRes.json() as DudaStats; } catch { stats = {}; }
  }

  let blogPosts: DudaBlogPost[] = [];
  if (blogRes.ok) {
    try {
      const blogData = await blogRes.json() as { results?: DudaBlogPost[] } | DudaBlogPost[];
      blogPosts = Array.isArray(blogData) ? blogData : (blogData.results ?? []);
    } catch { blogPosts = []; }
  }

  let pages: DudaPage[] = [];
  if (pagesRes.ok) {
    try {
      const pagesData = await pagesRes.json() as { results?: DudaPage[] } | DudaPage[];
      pages = Array.isArray(pagesData) ? pagesData : (pagesData.results ?? []);
    } catch { pages = []; }
  }

  let activities: DudaActivity[] = [];
  if (activitiesRes.ok) {
    try {
      const actData = await activitiesRes.json() as { results?: DudaActivity[] } | DudaActivity[];
      activities = Array.isArray(actData) ? actData : (actData.results ?? []);
    } catch { activities = []; }
  }

  // Site update events from Duda activity log
  const siteUpdates = activities
    .filter((a) => a.activity === 'publish_site' || a.activity === 'PUBLISH_SITE')
    .map((a) => ({
      date: a.timestamp?.split('T')[0] ?? '',
      label: 'Site update published',
      detail: a.comment ?? 'Content pushed live',
    }));

  // Published blog posts
  const publishedPosts = blogPosts
    .filter((p) => p.status === 'PUBLISHED' || !p.status)
    .map((p) => ({
      type: 'Blog' as const,
      title: p.title ?? '',
      url: p.url ?? '',
      display: p.url?.replace(/^https?:\/\/[^/]+/, '') ?? '',
      date: p.publish_date ? p.publish_date.split('T')[0] : 'Active',
    }));

  // Build page inventory with title and path for analyst classification
  // (service pages, geo pages, FAQ pages, blog posts — analyst classifies from these)
  const pageInventory: DudaPage[] = pages.map(p => ({
    title: p.title ?? '',
    path: p.path ?? p.page_url?.replace(/^https?:\/\/[^/]+/, '') ?? '',
  })).filter(p => p.title || p.path);

  return {
    siteAlias: site?.site_domain ?? siteName,
    lastPublished: site?.last_published_date ?? null,
    pageViews: stats.PAGE_VIEWS ?? 0,
    uniqueVisitors: stats.VISITORS ?? 0,
    visits: stats.VISITS ?? 0,
    periodStart: from,
    periodEnd: to,
    totalPages: pages.length,
    pages: pageInventory,
    publishedPosts,
    siteUpdates,
  };
}

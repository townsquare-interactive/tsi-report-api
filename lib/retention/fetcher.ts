// Agent 1: Data Fetcher
//
// No AI. Resolves GPID to all platform IDs and fans out to every platform
// in parallel. Returns the full raw data payload for the analyst to reason over.
//
// Uses 90-day window by default — longer window = more data = stronger retention case.

import type { FetchedData } from './types';
import type { ReportData } from '@/types/report';
import { resolveFromGpid } from '@/lib/resolve';
import { getClientById } from '@/lib/falcon';
import { getVcitaData } from '@/lib/platforms/vcita';
import { getDudaData } from '@/lib/platforms/duda';
import { getYextData } from '@/lib/platforms/yext';
import { getGbpInsights, getGbpReviews } from '@/lib/platforms/gbp';
import { getSociData } from '@/lib/platforms/soci';

// Simple retry wrapper — 1 retry with 1s delay for transient platform API failures.
// Keeps platform data fetch failures from being misread as "product not provisioned."
async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    console.warn(`[Fetcher] ${label} failed on first attempt, retrying in 1s...`);
    await new Promise(r => setTimeout(r, 1000));
    return fn();
  }
}

export async function fetchClientData(gpid: string, periodDays: number): Promise<FetchedData> {
  // Step 1: Resolve all platform IDs from GPID
  const resolved = await resolveFromGpid(gpid);
  const { clientId, vcitaId, dudaSiteName, gbpLocationId, businessName } = resolved;

  // Step 2: Falcon — full client metadata + activities
  const { client, activities } = await getClientById(clientId, periodDays);

  // Step 3: Determine service keys for conditional fetches
  const serviceKeys = (client.subscription?.serviceKeys ?? [])
    .flatMap((k: string) => k.split(''));

  const hasSocialKey = serviceKeys.includes('S');

  const errors: Record<string, string> = {};

  // Step 4: Fan out to all platforms in parallel
  const [gbpResult, gbpReviewsResult, dudaResult, yextResult, vcitaResult, sociResult] = await Promise.allSettled([
    gbpLocationId ? getGbpInsights(gbpLocationId, periodDays) : Promise.resolve(null),
    gbpLocationId ? getGbpReviews(gbpLocationId) : Promise.resolve([]),
    dudaSiteName ? withRetry(() => getDudaData(dudaSiteName, periodDays), 'Duda') : Promise.resolve(null),
    withRetry(() => getYextData(gpid, periodDays), 'Yext'),
    vcitaId ? withRetry(() => getVcitaData(vcitaId, periodDays), 'vcita') : Promise.resolve(null),
    hasSocialKey ? getSociData(gpid, businessName) : Promise.resolve(null),
  ]);

  function extract<T>(result: PromiseSettledResult<T>, platform: string): T | null {
    if (result.status === 'fulfilled') return result.value;
    errors[platform] = result.reason instanceof Error ? result.reason.message : String(result.reason);
    return null;
  }

  const report: ReportData = {
    meta: {
      clientId,
      generatedAt: new Date().toISOString(),
      periodDays,
    },
    client,
    gbp: extract(gbpResult, 'gbp'),
    gbpReviews: (gbpReviewsResult.status === 'fulfilled' ? gbpReviewsResult.value : []) ?? [],
    duda: extract(dudaResult, 'duda'),
    yext: extract(yextResult, 'yext'),
    vcita: extract(vcitaResult, 'vcita'),
    activities,
    soci: extract(sociResult, 'soci'),
    errors,
  };

  return report;
}

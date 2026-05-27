// TSI Report API — GET /api/report?gpid=TI+CASAED001&days=30
//
// Auth: x-api-key header — accepts TSI_API_KEY (admin) or TSI_API_KEY_MANNY (read-only)
//
// gpid: Client GPID e.g. "TI CASAED001" (required — URL encode the space as +)
// days: Reporting period in days, default 30 (max 365)
//
// All platform IDs are resolved dynamically from GPID — no other params needed.
// Resolution: Yext entity (name) → Falcon search + GBP location filter, Duda from static map.

import { NextRequest, NextResponse } from 'next/server';
import { verifyKey } from '@/lib/auth';
import type { ReportData } from '@/types/report';
import { resolveFromGpid } from '@/lib/resolve';
import { getClientById } from '@/lib/falcon';
import { getVcitaData } from '@/lib/platforms/vcita';
import { getDudaData } from '@/lib/platforms/duda';
import { getYextData } from '@/lib/platforms/yext';
import { getGbpInsights, getGbpReviews } from '@/lib/platforms/gbp';
import { getSociData } from '@/lib/platforms/soci';

export async function GET(request: NextRequest) {
  const authError = verifyKey(request);
  if (authError) return authError;

  const { searchParams } = request.nextUrl;
  const gpid = searchParams.get('gpid');
  const days = parseInt(searchParams.get('days') ?? '30', 10);

  if (!gpid) {
    return NextResponse.json(
      { error: 'gpid is required. Pass the client GPID e.g. ?gpid=TI+CASAED001' },
      { status: 400 }
    );
  }

  if (isNaN(days) || days < 1 || days > 365) {
    return NextResponse.json(
      { error: 'days must be a number between 1 and 365' },
      { status: 400 }
    );
  }

  // Step 1: Resolve all platform IDs from GPID
  let resolved;
  try {
    resolved = await resolveFromGpid(gpid);
  } catch (err) {
    return NextResponse.json(
      { error: `GPID resolution failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 404 }
    );
  }

  const { clientId, vcitaId, dudaSiteName, gbpLocationId, businessName } = resolved;

  // Step 2: Falcon — full client metadata + activities
  let client;
  let activities;
  try {
    ({ client, activities } = await getClientById(clientId, days));
  } catch (err) {
    return NextResponse.json(
      { error: `Falcon lookup failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 }
    );
  }

  const errors: Record<string, string> = {};

  // Step 3: Determine service keys for conditional fetches
  const serviceKeys = (client.subscription?.serviceKeys ?? [])
    .flatMap((k: string) => k.split(''));

  const hasSocialKey = serviceKeys.includes('S');

  // Step 4: Fan out to all platforms in parallel
  const [gbpResult, gbpReviewsResult, dudaResult, yextResult, vcitaResult, sociResult] = await Promise.allSettled([
    gbpLocationId ? getGbpInsights(gbpLocationId, days) : Promise.resolve(null),
    gbpLocationId ? getGbpReviews(gbpLocationId) : Promise.resolve([]),
    dudaSiteName ? getDudaData(dudaSiteName, days) : Promise.resolve(null),
    getYextData(gpid, days),
    vcitaId ? getVcitaData(vcitaId, days) : Promise.resolve(null),
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
      periodDays: days,
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

  return NextResponse.json(report, {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json',
    },
  });
}

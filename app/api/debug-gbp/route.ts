import { NextResponse } from 'next/server';
import { getGbpCredentials } from '@/lib/secrets';
import { verifyAdminKey } from '@/lib/auth';

const GBP_TSI_ACCOUNT = 'accounts/105329348540167006988';

export async function GET(req: Request) {
  try {
    verifyAdminKey(req);
  } catch {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const results: Record<string, unknown> = {};

  try {
    const creds = await getGbpCredentials();
    results.credentialsLoaded = true;
    results.clientIdPrefix = creds.clientId?.slice(0, 20);

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

    results.tokenHttpStatus = tokRes.status;

    if (!tokRes.ok) {
      const errText = await tokRes.text();
      results.tokenError = errText.slice(0, 500);
      results.tokenOk = false;
    } else {
      const { access_token } = await tokRes.json() as { access_token: string };
      results.tokenOk = true;
      results.tokenPrefix = access_token.slice(0, 20);

      // Test storeCode lookup for TI ROOFIN047
      const storeCode = 'TIROOFIN047-001';
      const filter = encodeURIComponent(`storeCode="${storeCode}"`);
      const scRes = await fetch(
        `https://mybusinessbusinessinformation.googleapis.com/v1/${GBP_TSI_ACCOUNT}/locations?readMask=name,title&filter=${filter}`,
        { headers: { Authorization: `Bearer ${access_token}` } }
      );
      results.storeCodeHttpStatus = scRes.status;

      if (!scRes.ok) {
        results.storeCodeError = (await scRes.text()).slice(0, 500);
      } else {
        const scData = await scRes.json() as { locations?: Array<{ name: string; title: string }> };
        results.storeCodeLocations = scData.locations ?? [];
        results.storeCodeFound = (scData.locations?.length ?? 0) > 0;
      }
    }
  } catch (e) {
    results.exception = String(e);
  }

  return NextResponse.json(results);
}

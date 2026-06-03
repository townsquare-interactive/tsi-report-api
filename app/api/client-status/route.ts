import { NextResponse } from 'next/server';
import { getFalconCredentials } from '@/lib/secrets';
import { verifyAdminKey } from '@/lib/auth';

// Lightweight endpoint: just Falcon status lookup for a GPID.
// No platform fetches. Returns in ~200ms. Used for bulk status enrichment.
export async function GET(req: Request) {
  try { verifyAdminKey(req); } catch { return NextResponse.json({ error: 'unauthorized' }, { status: 401 }); }

  const { searchParams } = new URL(req.url);
  const gpid = searchParams.get('gpid');
  if (!gpid) return NextResponse.json({ error: 'gpid required' }, { status: 400 });

  try {
    const { apiKey, endpoint, headerName } = await getFalconCredentials();
    const query = `query($gpid: String!) {
      clients(input: { filter: { externalServiceId: { gpId: $gpid } } }) {
        id name status tsiMarket
      }
    }`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [headerName]: apiKey },
      body: JSON.stringify({ query, variables: { gpid } }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return NextResponse.json({ gpid, status: null, error: `Falcon ${res.status}` });
    const json = await res.json() as { data?: { clients?: Array<{ id: string; name: string; status: string; tsiMarket: string }> } };
    const client = json.data?.clients?.[0];
    if (!client) return NextResponse.json({ gpid, status: null, name: null });
    return NextResponse.json({ gpid, status: client.status, name: client.name, market: client.tsiMarket, id: client.id });
  } catch (e) {
    return NextResponse.json({ gpid, status: null, error: String(e) });
  }
}

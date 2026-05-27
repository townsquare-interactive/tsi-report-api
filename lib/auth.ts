// API key authentication helpers
//
// Two tiers:
//   verifyKey()       — accepts TSI_API_KEY (admin) OR TSI_API_KEY_MANNY (read-only data access)
//                       Use on /api/report and /api/gap-audit
//   verifyAdminKey()  — accepts TSI_API_KEY only
//                       Use on /api/retention (writes to Freshdesk, posts notes, stores client data)
//
// To add more read-only keys in the future, extend the validKeys array in verifyKey().

import { NextRequest, NextResponse } from 'next/server';

export function verifyKey(request: NextRequest): NextResponse | null {
  const key = request.headers.get('x-api-key');
  const validKeys = [
    process.env.TSI_API_KEY,
    process.env.TSI_API_KEY_MANNY,
  ].filter(Boolean);

  if (!key || !validKeys.includes(key)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null; // authorized
}

export function verifyAdminKey(request: NextRequest): NextResponse | null {
  const key = request.headers.get('x-api-key');
  if (!key || key !== process.env.TSI_API_KEY) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null; // authorized
}

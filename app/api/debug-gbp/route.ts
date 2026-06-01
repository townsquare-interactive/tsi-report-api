// Debug route — disabled. Use Vercel dashboard logs to diagnose GBP issues.
// See docs/architecture.md → "GBP Known Issue" section.
import { NextResponse } from 'next/server';
export async function GET() {
  return NextResponse.json({ message: 'GBP debug disabled. Check Vercel logs for [GBP] prefix entries.' }, { status: 410 });
}

// Debug route — no longer active. DELETE this file.
import { NextResponse } from 'next/server';
export async function GET() {
  return NextResponse.json({ message: 'debug route disabled' }, { status: 410 });
}

import { NextResponse } from 'next/server';
import { getOpenAIAuthStatus } from '../../../services/openaiOAuth';

export const dynamic = 'force-dynamic';

export async function GET() {
  const status = await getOpenAIAuthStatus();
  return NextResponse.json(status);
}

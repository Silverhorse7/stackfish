import { NextResponse } from 'next/server';
import { clearOpenAIAuth } from '../../../services/openaiOAuth';

export async function POST() {
  await clearOpenAIAuth();
  return NextResponse.json({ success: true });
}

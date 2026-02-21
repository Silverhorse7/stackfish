import { NextResponse } from 'next/server';
import { startOpenAIAuthorize } from '../../../services/openaiOAuth';

export async function POST() {
  try {
    const authorization = await startOpenAIAuthorize();
    return NextResponse.json(authorization);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to start OpenAI authorization';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

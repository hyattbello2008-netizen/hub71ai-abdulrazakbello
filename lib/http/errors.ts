import 'server-only';
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 409 | 413 | 422 | 500 | 502 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new HttpError(500, 'SERVER_CONFIGURATION', 'Server configuration is incomplete.');
  return value;
}

export function webhookError(error: unknown, route = 'authenticated-mutation'): NextResponse {
  const requestId = randomUUID();
  const known = error instanceof HttpError;
  const status = known ? error.status : 500;
  const code = known ? error.code : 'INTERNAL_ERROR';
  // Never log a document, callback body, secret, SDK error or database error message.
  if (status >= 500) console.error(JSON.stringify({ route, requestId, status, code }));
  return NextResponse.json(
    { error: { code, message: known ? error.message : 'Unable to process callback.', request_id: requestId } },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}

import 'server-only';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { HttpError, requiredEnvironment } from '@/lib/http/errors';
import { forwardedEnvelopeSchema } from './schemas';

const MAX_BYTES = 128 * 1024;
const MAX_ORIGIN_BYTES = 64 * 1024;
const CLOCK_WINDOW_SECONDS = 300;
const keyringSchema = z.record(z.string().min(1).max(100), z.string()
  .refine(v => Buffer.byteLength(v, 'utf8') >= 32, 'Signing secrets must contain at least 32 bytes.'));

type OriginHeaders = { keyId: string | null; timestamp: string | null; signature: string | null };
export type VerifiedCallback = {
  payload: unknown;
  bodySha256: string;
  keyId: string;
  signedAtSeconds: number;
};

export function parseJson(bytes: Uint8Array): unknown {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch { throw new HttpError(400, 'INVALID_JSON', 'A valid UTF-8 JSON body is required.'); }
}

function readKeyring(name: string): Record<string, string> {
  try { return keyringSchema.parse(JSON.parse(requiredEnvironment(name)) as unknown); }
  catch { throw new HttpError(500, 'SERVER_CONFIGURATION', 'Webhook signing keys are not configured.'); }
}

function verifySignature(body: Uint8Array, headers: OriginHeaders, keyringName: string): { keyId: string; timestamp: number } {
  const keys = readKeyring(keyringName);
  const { keyId, timestamp, signature } = headers;
  if (!keyId || !timestamp || !signature || !/^[1-9][0-9]{9,11}$/.test(timestamp) || !/^sha256=[0-9a-f]{64}$/.test(signature)) {
    throw new HttpError(401, 'INVALID_SIGNATURE', 'A valid callback signature is required.');
  }
  const secret = Object.hasOwn(keys, keyId) ? keys[keyId] : undefined;
  const signedAt = Number(timestamp);
  if (!secret || !Number.isSafeInteger(signedAt) || Math.abs(Math.floor(Date.now() / 1000) - signedAt) > CLOCK_WINDOW_SECONDS) {
    throw new HttpError(401, 'INVALID_SIGNATURE', 'Callback signature is invalid or expired.');
  }
  // Domain separation is supplied by distinct provider keyrings. Timestamp and exact
  // payload bytes are authenticated together; never reserialize before verification.
  const expected = createHmac('sha256', secret).update(timestamp + '.', 'utf8').update(body).digest();
  const actual = Buffer.from(signature.slice(7), 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new HttpError(401, 'INVALID_SIGNATURE', 'Callback signature is invalid or expired.');
  }
  return { keyId, timestamp: signedAt };
}

async function readLimitedBody(request: Request): Promise<Uint8Array> {
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) {
    throw new HttpError(413, 'BODY_TOO_LARGE', 'Callback body exceeds the permitted size.');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'EMPTY_BODY', 'Callback body is required.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new HttpError(413, 'BODY_TOO_LARGE', 'Callback body exceeds the permitted size.');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'BODY_READ_FAILED', 'Callback body could not be read.');
  } finally { reader.releaseLock(); }
  if (size === 0) throw new HttpError(400, 'EMPTY_BODY', 'Callback body is required.');
  return Buffer.concat(chunks);
}

export async function verifyCallback(request: Request, originKeyringName: string): Promise<VerifiedCallback> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new HttpError(400, 'CONTENT_TYPE', 'Use application/json.');
  }
  const raw = await readLimitedBody(request);
  let originBody: Uint8Array = raw;
  let origin: OriginHeaders = {
    keyId: request.headers.get('x-falcon-key-id'),
    timestamp: request.headers.get('x-falcon-timestamp'),
    signature: request.headers.get('x-falcon-signature'),
  };
  // Make wraps the exact original bytes and origin headers; authenticate BOTH hops.
  if (request.headers.get('x-falcon-forwarder') === 'make') {
    if (process.env.MAKE_FORWARDING_ENABLED !== 'true') {
      throw new HttpError(401, 'FORWARDING_DISABLED', 'Forwarding is not enabled.');
    }
    verifySignature(raw, {
      keyId: request.headers.get('x-falcon-forwarder-key-id'),
      timestamp: request.headers.get('x-falcon-forwarder-timestamp'),
      signature: request.headers.get('x-falcon-forwarder-signature'),
    }, 'MAKE_FORWARDING_SIGNING_KEYS_JSON');
    const parsed = forwardedEnvelopeSchema.safeParse(parseJson(raw));
    if (!parsed.success) throw new HttpError(400, 'INVALID_ENVELOPE', 'Callback forwarding envelope is invalid.');
    const bytes = Buffer.from(parsed.data.body_base64, 'base64');
    if (bytes.length === 0 || bytes.length > MAX_ORIGIN_BYTES || bytes.toString('base64') !== parsed.data.body_base64) {
      throw new HttpError(400, 'INVALID_ENVELOPE', 'Forwarded body must use canonical base64.');
    }
    originBody = bytes;
    origin = { keyId: parsed.data.origin.key_id, timestamp: parsed.data.origin.timestamp, signature: parsed.data.origin.signature };
  } else if (request.headers.has('x-falcon-forwarder')) {
    throw new HttpError(401, 'UNKNOWN_FORWARDER', 'Unknown callback forwarding mechanism.');
  }
  if (originBody.byteLength > MAX_ORIGIN_BYTES) throw new HttpError(413, 'BODY_TOO_LARGE', 'Origin callback is too large.');
  const verified = verifySignature(originBody, origin, originKeyringName);
  return {
    payload: parseJson(originBody),
    bodySha256: createHash('sha256').update(originBody).digest('hex'),
    keyId: verified.keyId,
    signedAtSeconds: verified.timestamp,
  };
}

export function verifyOccurrence(occurredAt: string, signedAtSeconds: number): void {
  const seconds = Date.parse(occurredAt) / 1000;
  // An older event may be legitimately retried, but may never claim to occur after
  // the authenticated signing timestamp (allow a small source clock tolerance).
  if (!Number.isFinite(seconds) || seconds > signedAtSeconds + 30) {
    throw new HttpError(400, 'INVALID_EVENT_TIME', 'Event time is after its signature time.');
  }
}

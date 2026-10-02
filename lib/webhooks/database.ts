import 'server-only';
import { z } from 'zod';
import { HttpError } from '@/lib/http/errors';
import { getServiceRoleClient } from '@/lib/supabase/serviceRole';
import type { ApprovalCallback, PaymentCallback } from './schemas';
import type { VerifiedCallback } from './verify';

const paymentReceiptSchema = z.object({ operation_id: z.string().uuid(), body_sha256: z.string() });
const approvalReceiptSchema = z.object({ application_id: z.string().uuid(), body_sha256: z.string() });
const operationSchema = z.object({
  application_id: z.string().uuid(), kind: z.enum(['FUND', 'RELEASE', 'REFUND']),
  currency: z.string(), provider: z.string(), status: z.string(),
});
const uuidResult = z.string().uuid();
type DatabaseError = { code: string; message: string };

function databaseUnavailable(): never {
  throw new HttpError(500, 'DATABASE_ERROR', 'The callback could not be committed.');
}

function mapCommandError(error: DatabaseError): never {
  if (error.code === 'P0002' || error.code === '23503') {
    throw new HttpError(400, 'UNKNOWN_REFERENCE', 'Callback refers to an unknown application or operation.');
  }
  if (error.code === 'P0001') {
    if (error.message === 'Confirmation mismatch') {
      throw new HttpError(400, 'PAYMENT_MISMATCH', 'Payment confirmation does not match its requested operation.');
    }
    throw new HttpError(409, 'STATE_CONFLICT', 'The current application or payment state cannot accept this event.');
  }
  databaseUnavailable();
}

async function rejectPaymentReplay(payload: PaymentCallback, bodyHash: string): Promise<void> {
  const db = getServiceRoleClient();
  const receipt = await db.from('webhook_receipts').select('operation_id,body_sha256')
    .eq('provider', payload.provider).eq('event_id', payload.transaction_id).maybeSingle();
  if (receipt.error) databaseUnavailable();
  if (receipt.data) {
    const row = paymentReceiptSchema.safeParse(receipt.data);
    if (!row.success) databaseUnavailable();
    if (row.data.body_sha256 !== bodyHash || row.data.operation_id !== payload.operation_id) {
      throw new HttpError(409, 'EVENT_ID_REUSED', 'Transaction ID was already used for a different callback.');
    }
    throw new HttpError(409, 'DUPLICATE_EVENT', 'This payment transaction was already processed.');
  }
  const operation = await db.from('payment_operations').select('application_id,kind,currency,provider,status')
    .eq('id', payload.operation_id).maybeSingle();
  if (operation.error) databaseUnavailable();
  if (!operation.data) throw new HttpError(400, 'UNKNOWN_OPERATION', 'Requested payment operation does not exist.');
  const row = operationSchema.safeParse(operation.data);
  if (!row.success) databaseUnavailable();
  if (row.data.application_id !== payload.application_id || row.data.provider !== payload.provider ||
    row.data.kind !== payload.kind || row.data.currency !== payload.currency) {
    throw new HttpError(400, 'PAYMENT_MISMATCH', 'Callback does not match its requested payment operation.');
  }
  if (row.data.status !== 'REQUESTED') {
    throw new HttpError(409, 'OPERATION_ALREADY_CONFIRMED', 'Payment operation was already confirmed.');
  }
}

export async function commitPaymentCallback(payload: PaymentCallback, verified: VerifiedCallback): Promise<string> {
  // Fast-path duplicate lookup improves the response; it is NOT the concurrency lock.
  // The SQL command's unique constraints and application lock provide atomic authority.
  await rejectPaymentReplay(payload, verified.bodySha256);
  const result = await getServiceRoleClient().rpc('confirm_simulated_payment', {
    p_operation: payload.operation_id,
    p_event_id: payload.transaction_id,
    p_body_sha256: verified.bodySha256,
    p_key_id: verified.keyId,
    p_occurred_at: payload.occurred_at,
    p_kind: payload.kind,
    p_currency: payload.currency,
    p_amount_minor: payload.amount_minor,
  });
  if (result.error) {
    if (result.error.code === '23505') {
      // Resolve a competing committed event before classifying a uniqueness error.
      await rejectPaymentReplay(payload, verified.bodySha256);
      throw new HttpError(409, 'PAYMENT_CONFLICT', 'A conflicting payment record already exists.');
    }
    mapCommandError(result.error);
  }
  const parsed = uuidResult.safeParse(result.data);
  if (!parsed.success) databaseUnavailable();
  return parsed.data;
}

async function rejectApprovalReplay(payload: ApprovalCallback, bodyHash: string): Promise<void> {
  const db = getServiceRoleClient();
  const existingEvent = await db.from('government_approval_receipts').select('application_id,body_sha256')
    .eq('provider', payload.provider).eq('event_id', payload.transaction_id).maybeSingle();
  if (existingEvent.error) databaseUnavailable();
  if (existingEvent.data) {
    const row = approvalReceiptSchema.safeParse(existingEvent.data);
    if (!row.success) databaseUnavailable();
    if (row.data.application_id !== payload.application_id || row.data.body_sha256 !== bodyHash) {
      throw new HttpError(409, 'EVENT_ID_REUSED', 'Transaction ID was already used for a different approval callback.');
    }
    throw new HttpError(409, 'DUPLICATE_EVENT', 'This approval transaction was already processed.');
  }
  const existingCase = await db.from('government_approval_receipts').select('application_id,body_sha256')
    .eq('application_id', payload.application_id).maybeSingle();
  if (existingCase.error) databaseUnavailable();
  if (existingCase.data) throw new HttpError(409, 'APPLICATION_ALREADY_APPROVED', 'Application already has a simulated approval.');
}

export async function commitApprovalCallback(payload: ApprovalCallback, verified: VerifiedCallback): Promise<string> {
  await rejectApprovalReplay(payload, verified.bodySha256);
  const result = await getServiceRoleClient().rpc('confirm_simulated_government_approval', {
    p_application: payload.application_id,
    p_event_id: payload.transaction_id,
    p_body_sha256: verified.bodySha256,
    p_key_id: verified.keyId,
    p_occurred_at: payload.occurred_at,
  });
  if (result.error) {
    if (result.error.code === '23505') {
      await rejectApprovalReplay(payload, verified.bodySha256);
      throw new HttpError(409, 'APPROVAL_CONFLICT', 'A conflicting approval record already exists.');
    }
    mapCommandError(result.error);
  }
  const parsed = uuidResult.safeParse(result.data);
  if (!parsed.success) databaseUnavailable();
  return parsed.data;
}

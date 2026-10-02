import { NextResponse } from 'next/server';
import { HttpError, webhookError } from '@/lib/http/errors';
import { approvalCallbackSchema } from '@/lib/webhooks/schemas';
import { verifyCallback, verifyOccurrence } from '@/lib/webhooks/verify';
import { commitApprovalCallback } from '@/lib/webhooks/database';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const verified = await verifyCallback(request, 'APPROVAL_SIM_SIGNING_KEYS_JSON');
    const parsed = approvalCallbackSchema.safeParse(verified.payload);
    if (!parsed.success) throw new HttpError(400, 'INVALID_APPROVAL_EVENT', 'Approval callback does not match the required schema.');
    verifyOccurrence(parsed.data.occurred_at, verified.signedAtSeconds);
    // Receipt, approval state, audit and outbox are atomic; no journal/payout RPC here.
    const receiptId = await commitApprovalCallback(parsed.data, verified);
    return NextResponse.json({
      status: 'approval_recorded',
      environment: 'simulation',
      transaction_id: parsed.data.transaction_id,
      approval_receipt_id: receiptId,
      payout_executed: false,
    }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return webhookError(error, 'tamm-approval-sim'); }
}

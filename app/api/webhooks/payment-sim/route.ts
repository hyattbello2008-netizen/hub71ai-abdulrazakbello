import { NextResponse } from 'next/server';
import { HttpError, webhookError } from '@/lib/http/errors';
import { paymentCallbackSchema } from '@/lib/webhooks/schemas';
import { verifyCallback, verifyOccurrence } from '@/lib/webhooks/verify';
import { commitPaymentCallback } from '@/lib/webhooks/database';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const verified = await verifyCallback(request, 'PAYMENT_SIM_SIGNING_KEYS_JSON');
    const parsed = paymentCallbackSchema.safeParse(verified.payload);
    if (!parsed.success) throw new HttpError(400, 'INVALID_PAYMENT_EVENT', 'Payment callback does not match the required schema.');
    verifyOccurrence(parsed.data.occurred_at, verified.signedAtSeconds);
    const journalId = await commitPaymentCallback(parsed.data, verified);
    return NextResponse.json({
      status: 'confirmed',
      environment: 'simulation',
      funds_label: 'Simulated Escrow',
      transaction_id: parsed.data.transaction_id,
      journal_entry_id: journalId,
    }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return webhookError(error, 'payment-sim'); }
}

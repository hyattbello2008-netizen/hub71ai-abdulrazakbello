import 'server-only';
import { z } from 'zod';

export const minorUnitsSchema = z.string().regex(/^[1-9][0-9]{0,18}$/)
  .refine(value => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n,
    'Amount exceeds PostgreSQL bigint.');
const common = {
  transaction_id: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  application_id: z.string().uuid(),
  occurred_at: z.string().datetime({ offset: true }),
  environment: z.literal('simulation'),
};
export const paymentCallbackSchema = z.object({
  ...common,
  provider: z.literal('falcon_simulator'),
  event_type: z.literal('payment.confirmed'),
  operation_id: z.string().uuid(),
  kind: z.enum(['FUND', 'RELEASE', 'REFUND']),
  currency: z.enum(['AED', 'USD', 'EUR', 'GBP']),
  amount_minor: minorUnitsSchema,
}).strict();
export type PaymentCallback = z.infer<typeof paymentCallbackSchema>;

export const approvalCallbackSchema = z.object({
  ...common,
  provider: z.literal('doh_simulator'),
  event_type: z.literal('application.approval.confirmed'),
  approval_status: z.literal('APPROVED'),
}).strict();
export type ApprovalCallback = z.infer<typeof approvalCallbackSchema>;

export const forwardedEnvelopeSchema = z.object({
  body_base64: z.string().min(4).max(90_000),
  origin: z.object({
    key_id: z.string().min(1).max(100),
    timestamp: z.string().regex(/^[1-9][0-9]{9,11}$/),
    signature: z.string().regex(/^sha256=[0-9a-f]{64}$/),
  }).strict(),
}).strict();

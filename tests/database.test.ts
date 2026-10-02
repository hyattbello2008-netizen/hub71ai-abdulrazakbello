import { beforeEach, describe, expect, it, vi } from 'vitest';
import { commitPaymentCallback, commitApprovalCallback } from '@/lib/webhooks/database';
import type { PaymentCallback, ApprovalCallback } from '@/lib/webhooks/schemas';

const mocks=vi.hoisted(()=>({from:vi.fn(),rpc:vi.fn()}));
vi.mock('@/lib/supabase/serviceRole',()=>({getServiceRoleClient:()=>({from:mocks.from,rpc:mocks.rpc})}));
const app='11111111-1111-4111-8111-111111111111',op='22222222-2222-4222-8222-222222222222',id='33333333-3333-4333-8333-333333333333';
const verified={payload:null,bodySha256:'a'.repeat(64),keyId:'payment-v1',signedAtSeconds:Math.floor(Date.now()/1000)};
const payment:PaymentCallback={transaction_id:'event-1',application_id:app,operation_id:op,occurred_at:new Date().toISOString(),
  environment:'simulation',provider:'falcon_simulator',event_type:'payment.confirmed',kind:'FUND',currency:'AED',amount_minor:'5000000'};
const approval:ApprovalCallback={transaction_id:'approval-1',application_id:app,occurred_at:new Date().toISOString(),environment:'simulation',
  provider:'doh_simulator',event_type:'application.approval.confirmed',approval_status:'APPROVED'};
type Result={data:unknown;error:{code:string;message:string}|null};
function queueReads(...results:Result[]){
  const read=vi.fn();results.forEach(r=>read.mockResolvedValueOnce(r));
  mocks.from.mockImplementation(()=>{const query={select:()=>query,eq:()=>query,maybeSingle:read};return query;});
  return read;
}
const empty:Result={data:null,error:null};
const requested:Result={data:{application_id:app,provider:'falcon_simulator',kind:'FUND',currency:'AED',status:'REQUESTED'},error:null};
beforeEach(()=>{mocks.from.mockReset();mocks.rpc.mockReset().mockResolvedValue({data:id,error:null});});

describe('atomic payment command adapter',()=>{
  it('calls one RPC and never inserts journal rows from JavaScript',async()=>{
    queueReads(empty,requested);
    expect(await commitPaymentCallback(payment,verified)).toBe(id);
    expect(mocks.rpc).toHaveBeenCalledWith('confirm_simulated_payment',expect.objectContaining({p_amount_minor:'5000000',p_event_id:'event-1'}));
    expect(mocks.from.mock.calls.map(c=>c[0])).toEqual(['webhook_receipts','payment_operations']);
  });
  it('rejects an exact replay before the RPC',async()=>{
    queueReads({data:{operation_id:op,body_sha256:verified.bodySha256},error:null});
    await expect(commitPaymentCallback(payment,verified)).rejects.toMatchObject({status:409,code:'DUPLICATE_EVENT'});
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('rejects changed payload bytes using the same event ID',async()=>{
    queueReads({data:{operation_id:op,body_sha256:'b'.repeat(64)},error:null});
    await expect(commitPaymentCallback(payment,verified)).rejects.toMatchObject({status:409,code:'EVENT_ID_REUSED'});
  });
  it('does not accept an operation bound to another case',async()=>{
    queueReads(empty,{data:{...requested.data as object,application_id:id},error:null});
    await expect(commitPaymentCallback(payment,verified)).rejects.toMatchObject({status:400,code:'PAYMENT_MISMATCH'});
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('rejects unknown operation references',async()=>{
    queueReads(empty,empty);await expect(commitPaymentCallback(payment,verified)).rejects.toMatchObject({status:400});
  });
  it('classifies a unique-constraint race using the committed receipt',async()=>{
    queueReads(empty,requested,{data:{operation_id:op,body_sha256:verified.bodySha256},error:null});
    mocks.rpc.mockResolvedValue({data:null,error:{code:'23505',message:'unique conflict'}});
    await expect(commitPaymentCallback(payment,verified)).rejects.toMatchObject({status:409,code:'DUPLICATE_EVENT'});
  });
  it('maps the SQL amount mismatch to a 400 without leaking SQL',async()=>{
    queueReads(empty,requested);mocks.rpc.mockResolvedValue({data:null,error:{code:'P0001',message:'Confirmation mismatch'}});
    await expect(commitPaymentCallback(payment,verified)).rejects.toMatchObject({status:400,code:'PAYMENT_MISMATCH'});
  });
  it('maps read failures to a sanitized server error',async()=>{
    queueReads({data:null,error:{code:'08006',message:'private database host'}});
    await expect(commitPaymentCallback(payment,verified)).rejects.toMatchObject({status:500,code:'DATABASE_ERROR'});
  });
});
describe('approval command adapter',()=>{
  it('calls only the approval RPC',async()=>{
    queueReads(empty,empty);expect(await commitApprovalCallback(approval,verified)).toBe(id);
    expect(mocks.rpc).toHaveBeenCalledWith('confirm_simulated_government_approval',expect.objectContaining({p_application:app}));
    expect(mocks.rpc).toHaveBeenCalledOnce();
  });
  it('rejects a case already approved under a different event ID',async()=>{
    queueReads(empty,{data:{application_id:app,body_sha256:'b'.repeat(64)},error:null});
    await expect(commitApprovalCallback(approval,verified)).rejects.toMatchObject({status:409,code:'APPLICATION_ALREADY_APPROVED'});
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('rejects an event ID reused for another case',async()=>{
    queueReads({data:{application_id:id,body_sha256:verified.bodySha256},error:null});
    await expect(commitApprovalCallback(approval,verified)).rejects.toMatchObject({status:409,code:'EVENT_ID_REUSED'});
  });
  it('maps invalid database state to 409 without attempting a payout',async()=>{
    queueReads(empty,empty);mocks.rpc.mockResolvedValue({data:null,error:{code:'P0001',message:'requires routed case'}});
    await expect(commitApprovalCallback(approval,verified)).rejects.toMatchObject({status:409,code:'STATE_CONFLICT'});
  });
});

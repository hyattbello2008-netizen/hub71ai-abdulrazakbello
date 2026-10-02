import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '@/lib/http/errors';
import { POST as paymentPost } from '@/app/api/webhooks/payment-sim/route';
import { POST as approvalPost } from '@/app/api/webhooks/tamm-approval-sim/route';
import { commitPaymentCallback, commitApprovalCallback } from '@/lib/webhooks/database';

vi.mock('@/lib/webhooks/database', () => ({ commitPaymentCallback: vi.fn(), commitApprovalCallback: vi.fn() }));
const paymentSecret = 'p'.repeat(40), approvalSecret = 'a'.repeat(40), makeSecret = 'm'.repeat(40);
const applicationId='11111111-1111-4111-8111-111111111111', operationId='22222222-2222-4222-8222-222222222222';
const resultId='33333333-3333-4333-8333-333333333333';
const nowSeconds=()=>Math.floor(Date.now()/1000).toString();
const signature=(raw:string,secret:string,timestamp:string)=>'sha256='+createHmac('sha256',secret).update(timestamp+'.').update(raw).digest('hex');
function payload(){return {
  transaction_id:'payment-event-1',application_id:applicationId,operation_id:operationId,
  occurred_at:new Date().toISOString(),environment:'simulation',provider:'falcon_simulator',
  event_type:'payment.confirmed',kind:'FUND',currency:'AED',amount_minor:'5000000',
};}
function signedRequest(raw:string,secret=paymentSecret,keyId='payment-v1',timestamp=nowSeconds()){
  return new Request('http://localhost/api/webhooks/payment-sim',{method:'POST',body:raw,headers:{
    'content-type':'application/json','x-falcon-key-id':keyId,'x-falcon-timestamp':timestamp,
    'x-falcon-signature':signature(raw,secret,timestamp),
  }});
}
async function code(response:Response):Promise<string>{const body=await response.json() as {error:{code:string}};return body.error.code;}
beforeEach(()=>{
  vi.stubEnv('PAYMENT_SIM_SIGNING_KEYS_JSON',JSON.stringify({'payment-v1':paymentSecret}));
  vi.stubEnv('APPROVAL_SIM_SIGNING_KEYS_JSON',JSON.stringify({'approval-v1':approvalSecret}));
  vi.stubEnv('MAKE_FORWARDING_ENABLED','false');
  vi.stubEnv('MAKE_FORWARDING_SIGNING_KEYS_JSON',JSON.stringify({'make-v1':makeSecret}));
  vi.mocked(commitPaymentCallback).mockReset().mockResolvedValue(resultId);
  vi.mocked(commitApprovalCallback).mockReset().mockResolvedValue(resultId);
});

describe('payment callback authentication and validation',()=>{
  it('commits a signed funding callback and preserves money as a decimal string',async()=>{
    const response=await paymentPost(signedRequest(JSON.stringify(payload())));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({journal_entry_id:resultId,environment:'simulation',funds_label:'Simulated Escrow'});
    expect(commitPaymentCallback).toHaveBeenCalledWith(expect.objectContaining({amount_minor:'5000000'}),
      expect.objectContaining({keyId:'payment-v1',bodySha256:expect.stringMatching(/^[a-f0-9]{64}$/)}));
  });
  it('rejects unsigned callbacks before invoking the database',async()=>{
    const response=await paymentPost(new Request('http://localhost',{method:'POST',body:JSON.stringify(payload()),headers:{'content-type':'application/json'}}));
    expect(response.status).toBe(401);expect(commitPaymentCallback).not.toHaveBeenCalled();
  });
  it('rejects forged signatures',async()=>{
    const response=await paymentPost(signedRequest(JSON.stringify(payload()),'x'.repeat(40)));
    expect(response.status).toBe(401);expect(commitPaymentCallback).not.toHaveBeenCalled();
  });
  it.each([-301,301])('rejects signatures outside the clock window (%s seconds)',async offset=>{
    expect((await paymentPost(signedRequest(JSON.stringify(payload()),paymentSecret,'payment-v1',String(Number(nowSeconds())+offset)))).status).toBe(401);
  });
  it('rejects authenticated malformed JSON',async()=>{expect((await paymentPost(signedRequest('{bad-json'))).status).toBe(400);});
  it('rejects production environment labels',async()=>{
    expect((await paymentPost(signedRequest(JSON.stringify({...payload(),environment:'production'})))).status).toBe(400);
  });
  it.each(['xyz','0','-100','1.5','9223372036854775808',5000000])('rejects invalid minor-unit money %s',async amount=>{
    const response=await paymentPost(signedRequest(JSON.stringify({...payload(),amount_minor:amount})));
    expect(response.status).toBe(400);expect(commitPaymentCallback).not.toHaveBeenCalled();
  });
  it('accepts maximum bigint as a string without converting it to Number',async()=>{
    expect((await paymentPost(signedRequest(JSON.stringify({...payload(),amount_minor:'9223372036854775807'})))).status).toBe(200);
  });
  it('rejects claimed events in the future',async()=>{
    const response=await paymentPost(signedRequest(JSON.stringify({...payload(),occurred_at:new Date(Date.now()+60000).toISOString()})));
    expect(response.status).toBe(400);
  });
  it('returns 409 for an identified duplicate',async()=>{
    vi.mocked(commitPaymentCallback).mockRejectedValue(new HttpError(409,'DUPLICATE_EVENT','Already processed.'));
    const response=await paymentPost(signedRequest(JSON.stringify(payload())));
    expect(response.status).toBe(409);expect(await code(response)).toBe('DUPLICATE_EVENT');
  });
  it('rejects oversized bodies',async()=>{
    expect((await paymentPost(signedRequest(' '.repeat(129*1024)))).status).toBe(413);
  });
  it('does not expose internal errors in the response',async()=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});
    vi.mocked(commitPaymentCallback).mockRejectedValue(new Error('sensitive database details'));
    const response=await paymentPost(signedRequest(JSON.stringify(payload())));
    expect(response.status).toBe(500);expect(JSON.stringify(await response.json())).not.toContain('sensitive');
  });
});

describe('Make forwarding preserves origin authority',()=>{
  function envelopeRequest(originSignatureValid=true,forwardSignatureValid=true){
    const raw=JSON.stringify(payload()),timestamp=nowSeconds();
    const envelope=JSON.stringify({body_base64:Buffer.from(raw).toString('base64'),origin:{key_id:'payment-v1',timestamp,
      signature:signature(raw,originSignatureValid?paymentSecret:'x'.repeat(40),timestamp)}});
    return new Request('http://localhost',{method:'POST',body:envelope,headers:{
      'content-type':'application/json','x-falcon-forwarder':'make','x-falcon-forwarder-key-id':'make-v1',
      'x-falcon-forwarder-timestamp':timestamp,'x-falcon-forwarder-signature':signature(envelope,forwardSignatureValid?makeSecret:'x'.repeat(40),timestamp),
    }});
  }
  it('requires forwarding to be explicitly enabled',async()=>{expect((await paymentPost(envelopeRequest())).status).toBe(401);});
  it('verifies the forwarding and origin signatures',async()=>{
    vi.stubEnv('MAKE_FORWARDING_ENABLED','true');expect((await paymentPost(envelopeRequest())).status).toBe(200);
  });
  it.each([[false,true],[true,false]])('rejects either forged hop (%s,%s)',async(origin,forward)=>{
    vi.stubEnv('MAKE_FORWARDING_ENABLED','true');expect((await paymentPost(envelopeRequest(origin,forward))).status).toBe(401);
    expect(commitPaymentCallback).not.toHaveBeenCalled();
  });
});

describe('simulated government approval',()=>{
  const approvalPayload=()=>({transaction_id:'approval-1',application_id:applicationId,occurred_at:new Date().toISOString(),
    environment:'simulation',provider:'doh_simulator',event_type:'application.approval.confirmed',approval_status:'APPROVED'});
  it('records approval without invoking payment confirmation',async()=>{
    const response=await approvalPost(signedRequest(JSON.stringify(approvalPayload()),approvalSecret,'approval-v1'));
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({payout_executed:false,approval_receipt_id:resultId});
    expect(commitApprovalCallback).toHaveBeenCalledOnce();expect(commitPaymentCallback).not.toHaveBeenCalled();
  });
  it('does not accept payment-provider keys as approval authority',async()=>{
    expect((await approvalPost(signedRequest(JSON.stringify(approvalPayload())))).status).toBe(401);
  });
  it('rejects bare Boolean approvals',async()=>{
    expect((await approvalPost(signedRequest('{"approved":true}',approvalSecret,'approval-v1'))).status).toBe(400);
  });
});

import 'server-only';import {createHmac} from 'node:crypto';import {z} from 'zod';
import {getServiceRoleClient} from '@/lib/supabase/serviceRole';import {commandFailure} from '@/lib/http/mutations';import {HttpError,requiredEnvironment} from '@/lib/http/errors';
export async function simulateFunding(applicationId:string,actor:string){
  if(process.env.SIMULATION_ACTIONS_ENABLED!=='true')throw new HttpError(503,'SIMULATION_DISABLED','Operator funding simulation is not enabled.');
  const service=getServiceRoleClient();const prepared=await service.rpc('prepare_operator_simulated_funding',{p_application:applicationId,p_actor:actor});commandFailure(prepared.error);
  const op=prepared.data?.[0];if(!op)throw new HttpError(500,'DATABASE_ERROR','Funding operation could not be prepared.');
  if(op.status==='CONFIRMED')return {status:'CONFIRMED',already_confirmed:true};
  if(op.status!=='REQUESTED')throw new HttpError(409,'STATE_CONFLICT','Funding operation cannot be confirmed.');
  const keys=z.record(z.string(),z.string().min(32)).parse(JSON.parse(requiredEnvironment('PAYMENT_SIM_SIGNING_KEYS_JSON')) as unknown);
  const keyId=requiredEnvironment('PAYMENT_SIM_ACTIVE_KEY_ID');const secret=Object.hasOwn(keys,keyId)?keys[keyId]:undefined;
  if(!secret)throw new HttpError(500,'SERVER_CONFIGURATION','Simulator signing key is not configured.');
  const body=JSON.stringify({transaction_id:`operator-funding-${op.operation_id}`,application_id:op.application_id,occurred_at:new Date(op.occurred_at).toISOString(),environment:'simulation',provider:'falcon_simulator',event_type:'payment.confirmed',operation_id:op.operation_id,kind:'FUND',currency:op.currency,amount_minor:op.amount_minor});
  const timestamp=String(Math.floor(Date.now()/1000));const signature='sha256='+createHmac('sha256',secret).update(timestamp+'.'+body).digest('hex');
  let response:Response;
  try{response=await fetch(new URL('/api/webhooks/payment-sim',requiredEnvironment('SIMULATOR_CALLBACK_ORIGIN')),{method:'POST',headers:{'content-type':'application/json','x-falcon-key-id':keyId,'x-falcon-timestamp':timestamp,'x-falcon-signature':signature},body,cache:'no-store',redirect:'error',signal:AbortSignal.timeout(20000)});}
  catch{throw new HttpError(502,'SIMULATOR_UNAVAILABLE','Payment confirmation is unavailable. Retry this action safely.');}
  if(!response.ok&&response.status!==409)throw new HttpError(502,'SIMULATOR_REJECTED','The payment simulator did not confirm funding.');
  const confirmed=await service.from('payment_operations').select('status').eq('id',op.operation_id).single();commandFailure(confirmed.error);
  if(confirmed.data?.status!=='CONFIRMED')throw new HttpError(409,'CONFIRMATION_PENDING','Funding is still awaiting payment confirmation.');
  return {status:'CONFIRMED',already_confirmed:response.status===409};
}

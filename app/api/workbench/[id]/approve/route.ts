import {NextResponse} from 'next/server';import {z} from 'zod';import {requireOperator} from '@/lib/auth/server';import {mutationBody,commandFailure} from '@/lib/http/mutations';import {getServiceRoleClient} from '@/lib/supabase/serviceRole';import {webhookError,HttpError} from '@/lib/http/errors';
export const runtime='nodejs';
export async function POST(request:Request,{params}:{params:{id:string}}){try{
  const body=await mutationBody(request,z.object({reason:z.string().trim().min(10).max(2000)}).strict());
  if(!z.string().uuid().safeParse(params.id).success)throw new HttpError(400,'INVALID_ID','A valid application ID is required.');
  const {user}=await requireOperator(params.id,true);const result=await getServiceRoleClient().rpc('advance_pilot_application',{p_application:params.id,p_actor:user.id,p_reason:body.reason});commandFailure(result.error);
  return NextResponse.json({status:'ROUTED',destination:'doh_simulator'});
}catch(error){return webhookError(error);}}

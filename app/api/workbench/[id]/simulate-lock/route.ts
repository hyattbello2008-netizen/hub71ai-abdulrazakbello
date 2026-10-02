import {NextResponse} from 'next/server';import {z} from 'zod';import {requireOperator} from '@/lib/auth/server';import {mutationBody} from '@/lib/http/mutations';import {webhookError,HttpError} from '@/lib/http/errors';import {simulateFunding} from '@/lib/operator/simulate';
export const runtime='nodejs';
export async function POST(request:Request,{params}:{params:{id:string}}){try{
  await mutationBody(request,z.object({}).strict());if(!z.string().uuid().safeParse(params.id).success)throw new HttpError(400,'INVALID_ID','A valid application ID is required.');
  const {user}=await requireOperator(params.id,true);return NextResponse.json(await simulateFunding(params.id,user.id));
}catch(error){return webhookError(error);}}

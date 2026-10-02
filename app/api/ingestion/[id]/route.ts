import {NextResponse} from 'next/server';import {z} from 'zod';import {authenticatedContext} from '@/lib/auth/server';import {HttpError,webhookError} from '@/lib/http/errors';
export const dynamic='force-dynamic';
export async function GET(_request:Request,{params}:{params:{id:string}}){try{
  if(!z.string().uuid().safeParse(params.id).success)throw new HttpError(400,'INVALID_ID','A valid upload ID is required.');
  const {db,user}=await authenticatedContext();const result=await db.from('document_uploads').select('id,status,stage,error_code,application_id').eq('id',params.id).eq('applicant_id',user.id).maybeSingle();
  if(result.error)throw new HttpError(500,'DATABASE_ERROR','Progress is unavailable.');if(!result.data)throw new HttpError(403,'ACCESS_DENIED','Upload is not accessible.');
  return NextResponse.json(result.data,{headers:{'cache-control':'private, no-store'}});
}catch(error){return webhookError(error);}}

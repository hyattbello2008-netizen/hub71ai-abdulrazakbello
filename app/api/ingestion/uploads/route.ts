import {NextResponse} from 'next/server';import {z} from 'zod';
import {authenticatedContext} from '@/lib/auth/server';import {mutationBody,commandFailure} from '@/lib/http/mutations';
import {HttpError,webhookError} from '@/lib/http/errors';import {getServiceRoleClient} from '@/lib/supabase/serviceRole';
export const runtime='nodejs';
const schema=z.object({application_id:z.string().uuid(),document_type:z.enum(['passport','qualification','professional_registration','experience','other']),mime_type:z.enum(['application/pdf','text/plain']),size_bytes:z.number().int().min(1).max(5242880)}).strict();
export async function POST(request:Request){try{
  const body=await mutationBody(request,schema);const {db,user}=await authenticatedContext();
  const app=await db.from('applications').select('id').eq('id',body.application_id).eq('applicant_id',user.id).maybeSingle();
  if(app.error)throw new HttpError(500,'DATABASE_ERROR','Application could not be loaded.');if(!app.data)throw new HttpError(403,'ACCESS_DENIED','Application is not accessible.');
  const service=getServiceRoleClient();const result=await service.rpc('prepare_document_upload',{p_application:body.application_id,p_actor:user.id,p_type:body.document_type,p_mime:body.mime_type,p_bytes:body.size_bytes});
  commandFailure(result.error);if(!result.data)throw new HttpError(500,'DATABASE_ERROR','Upload could not be prepared.');
  const upload=await service.from('document_uploads').select('id,object_key').eq('id',result.data).single();commandFailure(upload.error);
  return NextResponse.json({upload_id:upload.data?.id,object_key:upload.data?.object_key,bucket:'healthcare-evidence'},{status:201});
}catch(error){return webhookError(error);}}

import {NextResponse} from 'next/server';
import {z} from 'zod';
import {authenticatedContext} from '@/lib/auth/server';
import {mutationBody,commandFailure} from '@/lib/http/mutations';
import {requiredEnvironment,webhookError,HttpError} from '@/lib/http/errors';
import {getServiceRoleClient} from '@/lib/supabase/serviceRole';
export const runtime='nodejs';
export async function POST(request:Request){try{
  await mutationBody(request,z.object({}).strict());const {user}=await authenticatedContext();
  const organization=requiredEnvironment('PILOT_ORGANIZATION_ID');
  if(!z.string().uuid().safeParse(organization).success)throw new HttpError(500,'SERVER_CONFIGURATION','Pilot organization is not configured.');
  const result=await getServiceRoleClient().rpc('start_pilot_application',{p_actor:user.id,p_organization:organization,p_display_name:typeof user.user_metadata.display_name==='string'?user.user_metadata.display_name:''});
  commandFailure(result.error);return NextResponse.json({application_id:result.data},{status:201,headers:{'cache-control':'private, no-store'}});
}catch(error){return webhookError(error);}}

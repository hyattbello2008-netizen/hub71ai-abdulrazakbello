import 'server-only';
import {redirect} from 'next/navigation';
import {createUserSupabase} from '@/lib/supabase/server';
import {HttpError} from '@/lib/http/errors';
import {hasOperatorAccess} from './access';
export async function authenticatedContext(){
  const db=createUserSupabase();
  const {data,error}=await db.auth.getUser();
  if(error||!data.user||data.user.is_anonymous)throw new HttpError(401,'AUTH_REQUIRED','Sign in to continue.');
  return {db,user:data.user};
}
export async function pageContext(){
  try{return await authenticatedContext();}
  catch(error){if(error instanceof HttpError&&error.status===401)redirect('/login');throw error;}
}
export async function requireOperator(applicationId?:string,approve=false){
  const context=await authenticatedContext();
  const memberships=await context.db.rpc('current_operator_memberships');
  if(memberships.error)throw new HttpError(503,'AUTHORIZATION_UNAVAILABLE','Unable to verify operator access.');
  let organization:string|undefined;
  if(applicationId){
    const application=await context.db.from('applications').select('id,organization_id').eq('id',applicationId).maybeSingle();
    if(application.error)throw new HttpError(500,'DATABASE_ERROR','Unable to read application.');
    if(!application.data)throw new HttpError(403,'CASE_ACCESS_DENIED','Application is unavailable to this operator.');
    organization=application.data.organization_id;
  }
  if(!hasOperatorAccess(memberships.data,organization,approve))throw new HttpError(403,'OPERATOR_REQUIRED','An authorized operator role is required.');
  return context;
}

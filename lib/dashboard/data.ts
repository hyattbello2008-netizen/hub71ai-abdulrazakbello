import 'server-only';import {pageContext} from '@/lib/auth/server';import {HttpError} from '@/lib/http/errors';
export async function applicantDashboard(){
  const {db,user}=await pageContext();
  const [profile,applications]=await Promise.all([
    db.from('applicant_profiles').select('display_name').eq('user_id',user.id).maybeSingle(),
    db.from('applications').select('id,protocol_id,status,currency,validated_completeness,review_reason_code,simulated_approval_status,created_at').eq('applicant_id',user.id).order('created_at',{ascending:false}).limit(1).maybeSingle(),
  ]);
  if(profile.error||applications.error)throw new HttpError(500,'DATABASE_ERROR','Dashboard data could not be loaded.');
  const application=applications.data;
  if(!application)return {name:profile.data?.display_name??'',application:null,balance:'0',tranches:[],documents:[]};
  const [balances,tranches,documents]=await Promise.all([
    db.rpc('account_balances_text',{p_application_id:application.id}),
    db.rpc('application_tranches_text',{p_application_id:application.id}),
    db.from('application_documents').select('id,document_type,scan_status,uploaded_at').eq('application_id',application.id).order('uploaded_at',{ascending:false}),
  ]);
  if(balances.error||tranches.error||documents.error)throw new HttpError(500,'DATABASE_ERROR','Application data could not be loaded.');
  return {name:profile.data?.display_name??'',application,balance:balances.data?.find(b=>b.code==='APPLICANT_ESCROW')?.balance_minor??'0',tranches:tranches.data??[],documents:documents.data??[]};
}

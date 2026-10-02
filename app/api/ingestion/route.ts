import {NextResponse} from 'next/server';import {z} from 'zod';
import {authenticatedContext} from '@/lib/auth/server';import {mutationBody,commandFailure} from '@/lib/http/mutations';
import {HttpError,webhookError,requiredEnvironment} from '@/lib/http/errors';import {getServiceRoleClient} from '@/lib/supabase/serviceRole';
import {extractB2GPayload} from '@/lib/ai/extractor';import {scanDocument,parseDocument,sha256} from '@/lib/ingestion/files';import {validateSourceEvidence,type SourcePage} from '@/lib/ingestion/evidence';
import {simulateGovernmentRouting} from '@/lib/ai/routing';
export const runtime='nodejs';export const maxDuration=180;
export async function POST(request:Request){
  let lease:string|undefined;let actor:string|undefined;let uploadId:string|undefined;
  try{
    const body=await mutationBody(request,z.object({upload_id:z.string().uuid()}).strict());const {db,user}=await authenticatedContext();actor=user.id;uploadId=body.upload_id;
    const upload=await db.from('document_uploads').select('id,application_id,object_key,mime_type,expected_bytes').eq('id',body.upload_id).eq('applicant_id',user.id).maybeSingle();
    if(upload.error)throw new HttpError(500,'DATABASE_ERROR','Upload could not be loaded.');if(!upload.data)throw new HttpError(403,'ACCESS_DENIED','Upload is not accessible.');
    const app=await db.from('applications').select('id,protocol_id').eq('id',upload.data.application_id).eq('applicant_id',user.id).single();commandFailure(app.error);
    if(!app.data)throw new HttpError(403,'ACCESS_DENIED','Application is not accessible.');
    const service=getServiceRoleClient();const claim=await service.rpc('claim_document_ingestion',{p_upload:body.upload_id,p_actor:user.id});commandFailure(claim.error);
    if(!claim.data)throw new HttpError(500,'DATABASE_ERROR','Ingestion could not start.');lease=claim.data;
    const downloaded=await service.storage.from('healthcare-evidence').download(upload.data.object_key);
    if(downloaded.error||!downloaded.data)throw new HttpError(400,'UPLOAD_MISSING','Upload the document before starting ingestion.');
    const bytes=new Uint8Array(await downloaded.data.arrayBuffer());
    if(bytes.length!==upload.data.expected_bytes)throw new HttpError(422,'FILE_SIZE_MISMATCH','Uploaded file does not match its upload authorization.');
    await scanDocument(bytes,upload.data.mime_type);
    const document=await service.rpc('register_scanned_document',{p_upload:body.upload_id,p_actor:user.id,p_lease:lease,p_sha256:sha256(bytes)});commandFailure(document.error);
    if(!document.data)throw new HttpError(500,'DATABASE_ERROR','Scanned document could not be registered.');
    const pages:SourcePage[]=await parseDocument(bytes,upload.data.mime_type,document.data);
    const documents=await db.from('application_documents').select('id,storage_key,sha256').eq('application_id',app.data.id).eq('scan_status','CLEAN');commandFailure(documents.error);
    if((documents.data?.length??0)>8)throw new HttpError(413,'TOO_MANY_DOCUMENTS','This pilot accepts up to eight parsed documents per application.');
    for(const prior of documents.data??[]){if(prior.id===document.data)continue;
      const file=await service.storage.from('healthcare-evidence').download(prior.storage_key);
      if(file.error||!file.data)throw new HttpError(500,'EVIDENCE_UNAVAILABLE','Previous evidence could not be loaded.');
      const oldBytes=new Uint8Array(await file.data.arrayBuffer());if(sha256(oldBytes)!==prior.sha256)throw new HttpError(422,'EVIDENCE_HASH_MISMATCH','Previous evidence failed its integrity check.');
      pages.push(...await parseDocument(oldBytes,prior.storage_key.endsWith('.pdf')?'application/pdf':'text/plain',prior.id));
    }
    const corpus=pages.map(p=>`[Document ${p.document_id}, page ${p.page_number}]\n${p.text}`).join('\n\n');
    if(Buffer.byteLength(corpus)>128*1024)throw new HttpError(413,'TEXT_TOO_LARGE','Combined evidence exceeds the pilot text limit.');
    const stage=async(p_stage:string)=>{const r=await service.rpc('set_ingestion_stage',{p_upload:body.upload_id,p_actor:user.id,p_lease:lease!,p_stage});commandFailure(r.error);};
    await stage('EXTRACTING');const extraction=await extractB2GPayload(corpus,app.data.protocol_id);await stage('VALIDATING');
    const validated=validateSourceEvidence(pages);
    const simulatedRouting=simulateGovernmentRouting(extraction);
    // Preserve the locked healthcare SQL gate. Universal destinations are previews,
    // stored in existing JSON evidence, not persisted government-routing transitions.
    const persistencePersona=extraction.persona_class==='healthcare_specialist'
      ?validated.persona:extraction.persona_class;
    // Model output can lower readiness, never supply proof or raise source coverage.
    const score=Math.floor(Math.min(validated.score,extraction.requires_human_review?98:extraction.evidence_completeness_index)*100)/100;
    const conflicts=validated.conflicts||persistencePersona!==validated.persona;
    const completion=await service.rpc('complete_document_ingestion',{p_upload:body.upload_id,p_actor:user.id,p_lease:lease,p_model:requiredEnvironment('OPENAI_EXTRACTION_MODEL'),
      p_data:{persona:persistencePersona,fields:validated.fields,missing_fields:validated.missing_fields,untrusted_extraction:extraction,simulated_routing:simulatedRouting},p_llm_score:extraction.evidence_completeness_index,p_validated_score:score,p_conflicts:conflicts,p_citations:validated.citations});commandFailure(completion.error);
    return NextResponse.json({application_id:app.data.id,status:score>98&&persistencePersona==='healthcare'&&!conflicts?'READY':'EXCEPTION',evidence_completeness_index:score,persona_class:extraction.persona_class,simulated_routing:simulatedRouting},{headers:{'cache-control':'private, no-store'}});
  }catch(error){
    if(lease&&actor&&uploadId){try{await getServiceRoleClient().rpc('fail_document_ingestion',{p_upload:uploadId,p_actor:actor,p_lease:lease,p_error_code:error instanceof HttpError?error.code:'INGESTION_FAILED'});}catch{/* Preserve original sanitized failure; expired leases cannot write. */}}
    return webhookError(error);
  }
}

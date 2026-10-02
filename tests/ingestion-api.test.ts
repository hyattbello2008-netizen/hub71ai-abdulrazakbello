import {beforeEach,afterEach,it,expect,vi} from 'vitest';import {POST} from '@/app/api/ingestion/route';import {HttpError} from '@/lib/http/errors';
const mocks=vi.hoisted(()=>({auth:vi.fn(),rpc:vi.fn(),from:vi.fn(),download:vi.fn(),scan:vi.fn(),extract:vi.fn()}));
vi.mock('@/lib/auth/server',()=>({authenticatedContext:mocks.auth}));vi.mock('@/lib/supabase/serviceRole',()=>({getServiceRoleClient:()=>({rpc:mocks.rpc,storage:{from:()=>({download:mocks.download})}})}));
vi.mock('@/lib/ai/extractor',()=>({extractB2GPayload:mocks.extract}));vi.mock('@/lib/ingestion/files',async importOriginal=>({...await importOriginal<typeof import('@/lib/ingestion/files')>(),scanDocument:mocks.scan}));
const upload='11111111-1111-4111-8111-111111111111';const app='22222222-2222-4222-8222-222222222222';const document='33333333-3333-4333-8333-333333333333';const protocol='44444444-4444-4444-8444-444444444444';
const text='Full Name: Example Applicant\nPassport Number: TEST123\nQualification: BSc Nursing\nIssuing Authority: Example University\nRegistration Number: RN123\nExperience Dates: 2020-2025\nProfession: Nurse';
function request(body:object={upload_id:upload}){return new Request('https://falcon.test/api/ingestion',{method:'POST',headers:{origin:'https://falcon.test','content-type':'application/json'},body:JSON.stringify(body)});}
beforeEach(()=>{
  vi.stubEnv('APP_ORIGIN','https://falcon.test');vi.stubEnv('OPENAI_EXTRACTION_MODEL','test-model');
  mocks.from.mockReset().mockImplementation((table:string)=>{const result=table==='document_uploads'?{id:upload,application_id:app,object_key:app+'/'+upload+'.txt',mime_type:'text/plain',expected_bytes:Buffer.byteLength(text)}:table==='applications'?{id:app,protocol_id:protocol}:[];
    const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:result,error:null}),single:async()=>({data:result,error:null}),then:(resolve:(value:object)=>unknown)=>Promise.resolve({data:result,error:null}).then(resolve)};return q;});
  mocks.auth.mockReset().mockResolvedValue({user:{id:'authenticated-applicant'},db:{from:mocks.from}});
  mocks.rpc.mockReset().mockImplementation(async(name:string)=>({data:name==='claim_document_ingestion'?'lease-token':name==='register_scanned_document'?document:name==='complete_document_ingestion'?'extraction-run':null,error:null}));
  mocks.download.mockReset().mockResolvedValue({data:new Blob([text]),error:null});mocks.scan.mockReset().mockResolvedValue(undefined);
  mocks.extract.mockReset().mockResolvedValue({protocol_id:protocol,persona_class:'healthcare_specialist',evidence_completeness_index:100,missing_fields:[],requires_human_review:false,score_authority:'untrusted_llm'});
});afterEach(()=>vi.unstubAllEnvs());
it('reads private stored bytes and atomically commits source citations, never client text',async()=>{
  const response=await POST(request());expect(response.status).toBe(200);expect(await response.json()).toMatchObject({status:'READY',evidence_completeness_index:100});
  expect(mocks.download).toHaveBeenCalledWith(app+'/'+upload+'.txt');expect(mocks.scan).toHaveBeenCalledOnce();expect(mocks.extract).toHaveBeenCalledWith(expect.stringContaining('Full Name: Example Applicant'),protocol);
  expect(mocks.rpc).toHaveBeenCalledWith('complete_document_ingestion',expect.objectContaining({p_actor:'authenticated-applicant',p_validated_score:100,p_citations:expect.arrayContaining([expect.objectContaining({document_id:document,page_number:1,source_excerpt:'Full Name: Example Applicant'})])}));
});
it('rejects browser text and scores before any privileged call',async()=>{expect((await POST(request({upload_id:upload,documentText:'fake',score:100}))).status).toBe(400);expect(mocks.rpc).not.toHaveBeenCalled();});
it('caps readiness when the AI requests review',async()=>{mocks.extract.mockResolvedValue({protocol_id:protocol,persona_class:'healthcare_specialist',evidence_completeness_index:100,missing_fields:['passport_name'],requires_human_review:true,score_authority:'untrusted_llm'});expect(await (await POST(request())).json()).toMatchObject({status:'EXCEPTION',evidence_completeness_index:98});});
it.each([['venture_builder','hub71_simulator'],['educator','adek_simulator']])('previews %s routing without bypassing the locked persisted pilot',async(persona,target)=>{
  mocks.extract.mockResolvedValue({protocol_id:protocol,persona_class:persona,evidence_completeness_index:100,missing_fields:[],requires_human_review:false,score_authority:'untrusted_llm'});
  const response=await POST(request());expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({status:'EXCEPTION',persona_class:persona,simulated_routing:{mode:'simulation',target}});
  expect(mocks.rpc.mock.calls.some(call=>['route_pilot_application','confirm_simulated_payment'].includes(String(call[0])))).toBe(false);
  expect(mocks.rpc).toHaveBeenCalledWith('complete_document_ingestion',expect.objectContaining({p_data:expect.objectContaining({persona,simulated_routing:expect.objectContaining({target})})}));
});
it('persists scanner failure for the exception queue without invoking AI',async()=>{mocks.scan.mockRejectedValue(new HttpError(422,'DOCUMENT_REJECTED','Document rejected.'));expect((await POST(request())).status).toBe(422);expect(mocks.extract).not.toHaveBeenCalled();expect(mocks.rpc).toHaveBeenCalledWith('fail_document_ingestion',expect.objectContaining({p_error_code:'DOCUMENT_REJECTED'}));});
it('rejects duplicate claims without redownloading documents',async()=>{mocks.rpc.mockResolvedValue({data:null,error:{code:'23505'}});expect((await POST(request())).status).toBe(409);expect(mocks.download).not.toHaveBeenCalled();});

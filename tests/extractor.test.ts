import { beforeEach, describe, expect, it, vi } from 'vitest';
import { evidenceResponseFormat, evaluateEvidence, extractB2GPayload } from '@/lib/ai/extractor';

const mocks=vi.hoisted(()=>({create:vi.fn()}));
vi.mock('openai',()=>({default:class {chat={completions:{create:mocks.create}};}}));
const id='11111111-1111-4111-8111-111111111111';
const evidence=(score=99)=>({protocol_id:id,persona_class:'healthcare_specialist',evidence_completeness_index:score,missing_fields:[]});
beforeEach(()=>{mocks.create.mockReset();vi.stubEnv('OPENAI_EXTRACTION_ENABLED','true');vi.stubEnv('OPENAI_API_KEY','synthetic-test-key');vi.stubEnv('OPENAI_EXTRACTION_MODEL','test-model');});
describe('strict extraction boundary',()=>{
  it.each([0,97.99,98])('requires review at %s',score=>{expect(evaluateEvidence(evidence(score),id).requires_human_review).toBe(true);});
  it('allows a complete healthcare 99 to proceed to validation, without claiming trusted authority',()=>{
    expect(evaluateEvidence(evidence(),id)).toMatchObject({requires_human_review:false,score_authority:'untrusted_llm'});
  });
  it('requires review when fields are missing despite a claimed 100',()=>{
    expect(evaluateEvidence({...evidence(100),missing_fields:['passport_name']},id).requires_human_review).toBe(true);
  });
  it('requires review for an unknown persona',()=>{
    expect(evaluateEvidence({...evidence(),persona_class:'unknown'},id).requires_human_review).toBe(true);
  });
  it.each(['venture_builder','healthcare_specialist','educator','corporate_talent'])('permits complete %s evidence to reach the preview switch',persona=>{
    expect(evaluateEvidence({...evidence(),persona_class:persona},id).requires_human_review).toBe(false);
  });
  it('rejects healthcare-only missing fields on a founder checklist',()=>{
    expect(()=>evaluateEvidence({...evidence(),persona_class:'venture_builder',missing_fields:['professional_registration_number']},id)).toThrow();
  });
  it('keeps an incomplete teaching certificate in review',()=>{
    expect(evaluateEvidence({...evidence(),persona_class:'educator',missing_fields:['teaching_experience_dates']},id).requires_human_review).toBe(true);
  });
  it.each([101,-1,NaN,Infinity])('rejects invalid scores %s',score=>{expect(()=>evaluateEvidence(evidence(score),id)).toThrow();});
  it('rejects invented backend identifiers',()=>{expect(()=>evaluateEvidence({...evidence(),protocol_id:'22222222-2222-4222-8222-222222222222'},id)).toThrow();});
  it('rejects unexpected schema fields',()=>{expect(()=>evaluateEvidence({...evidence(),routing_target_url:'http://example.invalid'},id)).toThrow();});
  it('pins the protocol ID in the exact four-field strict response schema',()=>{
    const format=evidenceResponseFormat(id);
    expect(format).toMatchObject({type:'json_schema',json_schema:{strict:true,schema:{additionalProperties:false}}});
    expect(format.json_schema.schema.required).toHaveLength(4);
    expect(format.json_schema.schema.properties.protocol_id.enum).toEqual([id]);
  });
  it('uses the requested response_format and validates the returned result',async()=>{
    mocks.create.mockResolvedValue({choices:[{finish_reason:'stop',message:{content:JSON.stringify(evidence()),refusal:null}}]});
    const result=await extractB2GPayload('Synthetic healthcare evidence text.',id);
    expect(result.protocol_id).toBe(id);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({store:false,response_format:expect.objectContaining({type:'json_schema'})}));
  });
  it('generates the single-argument ID in the backend, then pins it for the model',async()=>{
    mocks.create.mockImplementation(async(request:{response_format:ReturnType<typeof evidenceResponseFormat>})=>{
      const generated=request.response_format.json_schema.schema.properties.protocol_id.enum[0];
      return {choices:[{finish_reason:'stop',message:{content:JSON.stringify({...evidence(),protocol_id:generated})}}]};
    });
    const result=await extractB2GPayload('Synthetic evidence text.');
    expect(result.protocol_id).toMatch(/^[0-9a-f-]{36}$/);expect(result.protocol_id).not.toBe(id);
  });
  it.each(['length','content_filter'])('rejects incomplete output (%s)',async finish=>{
    mocks.create.mockResolvedValue({choices:[{finish_reason:finish,message:{content:JSON.stringify(evidence())}}]});
    await expect(extractB2GPayload('Synthetic text',id)).rejects.toMatchObject({status:502,code:'EXTRACTION_INCOMPLETE'});
  });
  it('handles model refusal',async()=>{
    mocks.create.mockResolvedValue({choices:[{finish_reason:'stop',message:{content:null,refusal:'refused'}}]});
    await expect(extractB2GPayload('Synthetic text',id)).rejects.toMatchObject({status:502});
  });
  it('handles provider failure without returning provider messages',async()=>{
    mocks.create.mockRejectedValue(new Error('sensitive provider detail'));
    await expect(extractB2GPayload('Synthetic text',id)).rejects.toMatchObject({code:'EXTRACTION_PROVIDER_ERROR'});
  });
  it('does not call OpenAI when extraction is disabled',async()=>{
    vi.stubEnv('OPENAI_EXTRACTION_ENABLED','false');await expect(extractB2GPayload('Synthetic text',id)).rejects.toMatchObject({status:503});
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('rejects empty text before provider access',async()=>{
    await expect(extractB2GPayload('  ',id)).rejects.toMatchObject({status:400});expect(mocks.create).not.toHaveBeenCalled();
  });
});

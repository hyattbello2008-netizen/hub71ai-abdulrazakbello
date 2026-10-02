import {describe,it,expect} from 'vitest';
import {simulateGovernmentRouting} from '@/lib/ai/routing';
import {evaluateEvidence,evidenceResponseFormat,PERSONA_CLASSES} from '@/lib/ai/extractor';
const id='11111111-1111-4111-8111-111111111111';
const payload=(persona_class:string,score=99)=>evaluateEvidence({protocol_id:id,persona_class,evidence_completeness_index:score,missing_fields:[]},id);
describe('universal routing preview',()=>{
  it.each([['venture_builder','hub71_simulator'],['healthcare_specialist','doh_simulator'],['educator','adek_simulator']])('maps %s to %s', (persona,target)=>{
    expect(simulateGovernmentRouting(payload(persona))).toMatchObject({mode:'simulation',authority:'extraction_preview_only',status:'SIMULATED_ROUTING',target});
  });
  it.each([0,97.99,98])('requires strictly more than 98, score %s',score=>{
    expect(simulateGovernmentRouting(payload('venture_builder',score))).toMatchObject({status:'HUMAN_REVIEW',target:null});
  });
  it('does not invent a destination for corporate talent',()=>{
    expect(simulateGovernmentRouting(payload('corporate_talent'))).toMatchObject({status:'UNASSIGNED',target:null});
  });
  it('does not route unknown evidence',()=>{
    expect(simulateGovernmentRouting(payload('unknown'))).toMatchObject({status:'HUMAN_REVIEW',target:null});
  });
  it('will not route a claimed 100 with missing founder evidence',()=>{
    const extraction=evaluateEvidence({protocol_id:id,persona_class:'venture_builder',evidence_completeness_index:100,missing_fields:['traction_summary']},id);
    expect(simulateGovernmentRouting(extraction).target).toBeNull();
  });
  it('pins the same persona enum in strict JSON and runtime validation',()=>{
    expect(evidenceResponseFormat(id).json_schema.schema.properties.persona_class.enum).toEqual([...PERSONA_CLASSES]);
    expect(()=>payload('healthcare')).toThrow();
  });
});

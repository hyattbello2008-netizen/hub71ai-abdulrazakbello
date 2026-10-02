'use client';
import {useState} from 'react';
import type {ExtractionResult} from '@/lib/ai/extractor';
import {simulateGovernmentRouting} from '@/lib/ai/routing';
const examples=[
  {persona:'venture_builder',label:'Venture Builder',document:'Founder pitch deck'},
  {persona:'healthcare_specialist',label:'Healthcare Specialist',document:'Professional registration'},
  {persona:'educator',label:'Educator',document:'Teaching certificate'},
  {persona:'corporate_talent',label:'Corporate Talent',document:'Employment evidence'},
] as const;
export default function RoutingPreview(){
  const [index,setIndex]=useState(0);const [score,setScore]=useState(99);const sample=examples[index]??examples[0];
  const evidence:ExtractionResult={protocol_id:'11111111-1111-4111-8111-111111111111',persona_class:sample.persona,evidence_completeness_index:score,missing_fields:[],requires_human_review:score<=98,score_authority:'untrusted_llm'};
  const route=simulateGovernmentRouting(evidence);
  return <section className="panel" aria-labelledby="routing-demo-title"><span className="eyebrow">Universal routing demonstration</span><h2 id="routing-demo-title">Different evidence. A relevant pathway.</h2><p>Choose a sample persona to explore the simulated routing rules. This demonstration uses sample extraction values.</p><div className="actions" role="group" aria-label="Sample personas">{examples.map((item,i)=><button type="button" key={item.persona} className={index===i?'':'secondary'} aria-pressed={index===i} onClick={()=>setIndex(i)}>{item.label}</button>)}</div><label>Sample evidence completeness: {score}%<input type="range" min="0" max="100" step="1" value={score} onChange={event=>setScore(Number(event.target.value))}/></label><div aria-live="polite"><p>{sample.document} · <code>{sample.persona}</code></p><strong style={{fontSize:'1.25rem'}}>{route.label}</strong><p>{route.status==='SIMULATED_ROUTING'?'Routing preview only. No government request or financial movement.':route.status==='UNASSIGNED'?'A corporate destination has not been assigned.':'Evidence must exceed 98% and have no missing fields.'}</p></div><p className="muted">Universal classification is demonstrated here. The existing persisted pilot workflow remains healthcare-only.</p></section>;
}

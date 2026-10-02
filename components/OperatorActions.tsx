'use client';import {useState} from 'react';import {useRouter} from 'next/navigation';
export default function OperatorActions({id,status,canApprove,simulationEnabled}:{id:string;status:string;canApprove:boolean;simulationEnabled:boolean}){
  const [reason,setReason]=useState('');const [busy,setBusy]=useState(false);const [message,setMessage]=useState('');const [error,setError]=useState('');const router=useRouter();
  async function act(action:string){setBusy(true);setMessage('');setError('');try{
    const response=await fetch(`/api/workbench/${id}/${action}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(action==='approve'?{reason}: {})});
    const data=await response.json() as {error?:{message?:string}};if(!response.ok)throw new Error(data.error?.message??'The action could not be completed.');
    setMessage(action==='approve'?'Case advanced to the DOH simulator.':'Simulated funding confirmed and journal posted.');router.refresh();
  }catch(e){setError(e instanceof Error?e.message:'The action could not be completed.');}finally{setBusy(false);}}
  return <section className="panel"><h2>Operator actions</h2><p>Overrides require a recorded justification. Financial changes wait for signed simulator confirmation.</p><label>Review justification<textarea value={reason} onChange={e=>setReason(e.target.value)} maxLength={2000} disabled={!canApprove||busy}/></label>
    <div className="actions"><button onClick={()=>void act('approve')} disabled={busy||!canApprove||reason.trim().length<10||!['EXCEPTION','UNDER_REVIEW','READY'].includes(status)}>Approve exception & advance</button>
    <button className="secondary" onClick={()=>void act('simulate-lock')} disabled={busy||!canApprove||!simulationEnabled||!['READY','ROUTED'].includes(status)}>Trigger Simulated Lock</button></div>
    {!canApprove&&<p className="muted">Your reviewer role permits inspection. An approver or administrator must perform these actions.</p>}
    {!simulationEnabled&&<p className="muted">Funding simulation awaits server configuration.</p>}
    <p role="status">{message}</p>{error&&<p className="error" role="alert">{error}</p>}</section>;
}

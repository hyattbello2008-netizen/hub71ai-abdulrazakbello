'use client';
import {useRef,useState} from 'react';import {useRouter} from 'next/navigation';import {createBrowserSupabase} from '@/lib/supabase/browser';
type Result={application_id?:string;upload_id?:string;object_key?:string;bucket?:string;status?:string;stage?:string;simulated_routing?:{label:string};error?:{message?:string}};
async function post(path:string,body:object):Promise<Result>{const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const data=await r.json() as Result;if(!r.ok)throw new Error(data.error?.message??'The action could not be completed.');return data;}
const stageLabels:Record<string,string>={UPLOADING:'Uploading securely...',SCANNING:'Scanning document...',EXTRACTING:'Identifying persona and extracting evidence...',VALIDATING:'Checking evidence and simulated pathway...',COMPLETE:'Evidence stored.',FAILED:'Ingestion needs attention.'};
export default function UploadCredentials({applicationId,editable=true}:{applicationId?:string;editable?:boolean}){
  const [file,setFile]=useState<File|null>(null);const [type,setType]=useState('other');const [busy,setBusy]=useState(false);const [message,setMessage]=useState('');const [error,setError]=useState('');const router=useRouter();const input=useRef<HTMLInputElement>(null);
  async function submit(){if(!file||busy)return;setBusy(true);setError('');let timer:ReturnType<typeof setInterval>|undefined;
    try{
      const mime=file.name.toLowerCase().endsWith('.pdf')?'application/pdf':file.name.toLowerCase().endsWith('.txt')?'text/plain':'';
      if(!mime||!file.size||file.size>5242880)throw new Error('Choose a PDF or UTF-8 .txt file, up to 5 MB.');
      setMessage('Preparing private upload...');const id=applicationId??(await post('/api/applications',{})).application_id;if(!id)throw new Error('Application could not be created.');
      const upload=await post('/api/ingestion/uploads',{application_id:id,document_type:type,mime_type:mime,size_bytes:file.size});
      if(!upload.upload_id||!upload.object_key||!upload.bucket)throw new Error('Upload authorization is incomplete.');
      setMessage(stageLabels.UPLOADING!);const result=await createBrowserSupabase().storage.from(upload.bucket).upload(upload.object_key,file,{contentType:mime,upsert:false});if(result.error)throw new Error('Private upload failed. Please try again.');
      setMessage(stageLabels.SCANNING!);let polling=false;
      timer=setInterval(()=>{if(polling)return;polling=true;void fetch(`/api/ingestion/${upload.upload_id}`,{cache:'no-store'}).then(async r=>{if(!r.ok)return;const progress=await r.json() as Result;if(progress.stage)setMessage(stageLabels[progress.stage]??'Processing evidence...');}).catch(()=>{}).finally(()=>{polling=false;});},1200);
      const done=await post('/api/ingestion',{upload_id:upload.upload_id});const review=done.status==='READY'?'Evidence complete. Your case is ready for operator review.':'Evidence stored. An operator will review your case.';setMessage(review+(done.simulated_routing?` Routing preview: ${done.simulated_routing.label}.`:''));setFile(null);if(input.current)input.current.value='';router.refresh();
    }catch(e){setError(e instanceof Error?e.message:'Upload could not be completed.');router.refresh();}
    finally{if(timer)clearInterval(timer);setBusy(false);}
  }
  return <section className="panel" id="upload"><span className="eyebrow">01 / Evidence ingestion</span><h2>Upload Credentials</h2><p>Private storage · security scan · source citations</p>
    <p className="muted">Upload a readable pitch deck, clinical credential, teaching certificate or corporate employment document as a PDF or UTF-8 text. The extractor identifies the relevant persona and previews its simulated destination. The locked database workflow retains the healthcare pilot rules; other pathways remain in review.</p>
    <p className="muted">Healthcare source validation uses labeled fields: Full Name, Passport Number, Qualification, Issuing Authority, Registration Number, Experience Dates, and Profession.</p>
    <label>Document type<select disabled={busy||!editable} value={type} onChange={e=>setType(e.target.value)}><option value="other">Combined credentials</option><option value="passport">Passport</option><option value="qualification">Qualification</option><option value="professional_registration">Professional registration</option><option value="experience">Experience</option></select></label>
    <label className="dropzone">Choose a credential document<input ref={input} type="file" accept=".pdf,.txt" disabled={busy||!editable} onChange={e=>setFile(e.target.files?.[0]??null)}/></label>
    <button disabled={!file||busy||!editable} onClick={()=>void submit()}>{busy?'Processing...':'Upload & ingest'}</button>
    {!editable&&<p>Your application is locked for review. Ask an operator to request new documents.</p>}
    <p role="status" aria-live="polite">{message}</p>{error&&<p className="error" role="alert">{error}</p>}
  </section>;
}

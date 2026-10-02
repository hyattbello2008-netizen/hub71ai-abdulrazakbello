'use client';import {useState,type FormEvent} from 'react';import {useRouter,useSearchParams} from 'next/navigation';import Link from 'next/link';import {createBrowserSupabase} from '@/lib/supabase/browser';import {safeNext} from '@/lib/auth/redirect';
export default function AuthForm({signup=false}:{signup?:boolean}){
  const router=useRouter();const params=useSearchParams();const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [message,setMessage]=useState('');
  async function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();setBusy(true);setError('');setMessage('');const form=new FormData(event.currentTarget);
    try{const auth=createBrowserSupabase().auth;const email=String(form.get('email'));const password=String(form.get('password'));
      const result=signup?await auth.signUp({email,password,options:{data:{display_name:String(form.get('name')??'').slice(0,120)},emailRedirectTo:window.location.origin+'/auth/callback'}}):await auth.signInWithPassword({email,password});
      if(result.error)throw new Error(signup?'Account could not be created. Check the details and try again.':'Sign-in failed. Check your email and password.');
      if(signup&&!result.data.session){setMessage('Check your email to confirm your account.');return;}
      router.replace(safeNext(params.get('next')));router.refresh();
    }catch(e){setError(e instanceof Error?e.message:'Authentication is unavailable.');}finally{setBusy(false);}}
  return <form className="panel auth" onSubmit={e=>void submit(e)}><span className="eyebrow">Falcon / secure access</span><h1>{signup?'Create your account':'Sign in'}</h1><p>Universal pathways demonstration · Simulated Escrow</p>
    {signup&&<label>Display name<input name="name" autoComplete="name" maxLength={120} required/></label>}
    <label>Email<input name="email" type="email" autoComplete="email" required/></label><label>Password<input name="password" type="password" minLength={signup?12:1} autoComplete={signup?'new-password':'current-password'} required/></label>
    <button disabled={busy}>{busy?'Connecting...':signup?'Create account':'Sign in'}</button><p role="status">{message}</p>{error&&<p className="error" role="alert">{error}</p>}
    <Link href={signup?'/login':'/signup'}>{signup?'Already registered? Sign in':'Create an applicant account'}</Link><p className="muted">Operator permissions are provisioned by your institution.</p></form>;
}

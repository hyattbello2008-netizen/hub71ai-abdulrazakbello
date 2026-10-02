import {createServerClient} from '@supabase/ssr';
import {NextResponse,type NextRequest} from 'next/server';
import {publicSupabaseConfig} from '@/lib/supabase/publicConfig';
import type {Database} from '@/lib/supabase/database.types';
import {protectedPath,hasOperatorAccess} from '@/lib/auth/access';

export async function middleware(request:NextRequest){
  const protection=protectedPath(request.nextUrl.pathname);
  if(!protection)return NextResponse.next();
  let response=NextResponse.next({request});
  function carryCookies(target:NextResponse){
    response.cookies.getAll().forEach(cookie=>target.cookies.set(cookie));
    target.headers.set('Cache-Control','private, no-store');
    return target;
  }
  try {
    const {url,key}=publicSupabaseConfig();
    const db=createServerClient<Database>(url,key,{cookies:{
      getAll:()=>request.cookies.getAll(),
      setAll:entries=>{
        entries.forEach(({name,value})=>request.cookies.set(name,value));
        const previous=response;
        response=NextResponse.next({request});
        previous.cookies.getAll().forEach(cookie=>response.cookies.set(cookie));
        entries.forEach(({name,value,options})=>response.cookies.set(name,value,options));
      },
    }});
    // getUser verifies with Auth; getSession or decoded cookie metadata is not authority.
    const {data,error}=await db.auth.getUser();
    if(error||!data.user||data.user.is_anonymous){
      if(request.nextUrl.pathname.startsWith('/api/'))return carryCookies(NextResponse.json({error:{code:'AUTH_REQUIRED',message:'Sign in to continue.'}},{status:401}));
      const target=new URL('/login',request.url);target.searchParams.set('next',request.nextUrl.pathname);
      return carryCookies(NextResponse.redirect(target));
    }
    if(protection==='operator'){
      const memberships=await db.rpc('current_operator_memberships');
      if(memberships.error)return carryCookies(NextResponse.json({error:{code:'AUTHORIZATION_UNAVAILABLE',message:'Unable to verify operator access.'}},{status:503}));
      if(!hasOperatorAccess(memberships.data)){
        if(request.nextUrl.pathname.startsWith('/api/'))return carryCookies(NextResponse.json({error:{code:'OPERATOR_REQUIRED',message:'Operator access is required.'}},{status:403}));
        return carryCookies(NextResponse.redirect(new URL('/dashboard?access=denied',request.url)));
      }
    }
    response.headers.set('Cache-Control','private, no-store');
    return response;
  }catch{return carryCookies(NextResponse.json({error:{code:'AUTH_UNAVAILABLE',message:'Authentication is not configured or is unavailable.'}},{status:503}));}
}
export const config={matcher:['/dashboard/:path*','/workbench/:path*','/api/applications/:path*','/api/ingestion/:path*','/api/workbench/:path*']};

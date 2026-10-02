import 'server-only';
import {createServerClient} from '@supabase/ssr';
import {cookies} from 'next/headers';
import {publicSupabaseConfig} from './publicConfig';
import type {Database} from './database.types';
export function createUserSupabase(){
  const cookieStore=cookies();
  const {url,key}=publicSupabaseConfig();
  return createServerClient<Database>(url,key,{
    cookies:{
      getAll:()=>cookieStore.getAll(),
      setAll:entries=>{
        try {entries.forEach(({name,value,options})=>cookieStore.set(name,value,options));}
        catch { /* RSCs cannot set cookies; middleware forwards refreshed cookies. */ }
      },
    },
  });
}

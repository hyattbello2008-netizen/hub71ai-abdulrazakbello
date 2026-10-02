'use client';
import {createBrowserClient} from '@supabase/ssr';
import type {Database} from './database.types';
import {publicSupabaseConfig} from './publicConfig';
export function createBrowserSupabase(){
  const {url,key}=publicSupabaseConfig();
  return createBrowserClient<Database>(url,key);
}

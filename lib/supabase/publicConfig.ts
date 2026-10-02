// Browser/middleware-safe: ONLY publishable/anonymous credentials are referenced.
export function publicSupabaseConfig():{url:string;key:string} {
  const url=process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if(!url||!key)throw new Error('Public Supabase configuration is missing.');
  return {url,key};
}

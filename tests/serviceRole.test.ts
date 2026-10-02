import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({create:vi.fn()}));
vi.mock('@supabase/supabase-js',()=>({createClient:mocks.create}));
beforeEach(()=>{vi.resetModules();mocks.create.mockReset().mockReturnValue({serverOnly:true});});
describe('service-role client',()=>{
  it('uses only the service key and disables all session behaviour',async()=>{
    vi.stubEnv('SUPABASE_URL','http://kong:8000');vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','synthetic-service-key');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY','wrong-public-key');
    const {getServiceRoleClient}=await import('@/lib/supabase/serviceRole');
    getServiceRoleClient();getServiceRoleClient();
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.create).toHaveBeenCalledWith('http://kong:8000','synthetic-service-key',expect.objectContaining({
      auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
    }));
  });
  it('does not silently fall back to an anonymous credential',async()=>{
    vi.stubEnv('SUPABASE_URL','http://kong:8000');vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','');
    const {getServiceRoleClient}=await import('@/lib/supabase/serviceRole');
    expect(getServiceRoleClient).toThrow();expect(mocks.create).not.toHaveBeenCalled();
  });
  it('rejects non-HTTP endpoint configuration',async()=>{
    vi.stubEnv('SUPABASE_URL','file:///credentials');vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','synthetic-service-key');
    const {getServiceRoleClient}=await import('@/lib/supabase/serviceRole');
    expect(getServiceRoleClient).toThrow();expect(mocks.create).not.toHaveBeenCalled();
  });
});

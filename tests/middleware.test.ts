import {beforeEach,describe,it,expect,vi} from 'vitest';import {NextRequest} from 'next/server';import {middleware} from '../middleware';
const mocks=vi.hoisted(()=>({getUser:vi.fn(),rpc:vi.fn(),refresh:false}));
vi.mock('@/lib/supabase/publicConfig',()=>({publicSupabaseConfig:()=>({url:'https://db.test',key:'public-anon'})}));
vi.mock('@supabase/ssr',()=>({createServerClient:(_url:unknown,_key:unknown,options:{cookies:{setAll:(entries:{name:string;value:string;options:{httpOnly:boolean}}[])=>void}})=>{
  if(mocks.refresh)options.cookies.setAll([{name:'refresh-test',value:'new-cookie',options:{httpOnly:true}}]);
  return {auth:{getUser:mocks.getUser},rpc:mocks.rpc};
}}));
beforeEach(()=>{mocks.refresh=false;mocks.getUser.mockReset().mockResolvedValue({data:{user:{id:'trusted-user',is_anonymous:false}},error:null});mocks.rpc.mockReset().mockResolvedValue({data:[],error:null});});
describe('SSR middleware',()=>{
  it('leaves the homepage open without auth calls',async()=>{const result=await middleware(new NextRequest('https://falcon.test/'));expect(result.status).toBe(200);expect(mocks.getUser).not.toHaveBeenCalled();});
  it('redirects logged-out applicants and preserves refreshed cookies',async()=>{mocks.refresh=true;mocks.getUser.mockResolvedValue({data:{user:null},error:null});const response=await middleware(new NextRequest('https://falcon.test/dashboard'));expect(response.status).toBe(307);expect(response.headers.get('location')).toBe('https://falcon.test/login?next=%2Fdashboard');expect(response.cookies.get('refresh-test')?.value).toBe('new-cookie');expect(response.headers.get('cache-control')).toContain('no-store');});
  it('returns 401 JSON for unauthenticated applicant APIs',async()=>{mocks.getUser.mockResolvedValue({data:{user:null},error:null});expect((await middleware(new NextRequest('https://falcon.test/api/ingestion'))).status).toBe(401);});
  it('never treats an authenticated applicant as an operator',async()=>{const result=await middleware(new NextRequest('https://falcon.test/api/workbench/123/approve'));expect(result.status).toBe(403);expect(mocks.rpc).toHaveBeenCalledWith('current_operator_memberships');});
  it('allows a database-authorized reviewer to inspect the workbench',async()=>{mocks.rpc.mockResolvedValue({data:[{organization_id:'org',role:'reviewer'}],error:null});expect((await middleware(new NextRequest('https://falcon.test/workbench'))).status).toBe(200);});
  it('fails closed on authorization database failure',async()=>{mocks.rpc.mockResolvedValue({data:null,error:{code:'offline'}});expect((await middleware(new NextRequest('https://falcon.test/workbench'))).status).toBe(503);});
});

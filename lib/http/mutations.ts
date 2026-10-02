import 'server-only';
import {z} from 'zod';
import {HttpError,requiredEnvironment} from './errors';
export function requireSameOrigin(request:Request):void{
  let expected:string;
  try{expected=new URL(requiredEnvironment('APP_ORIGIN')).origin;}
  catch{throw new HttpError(500,'SERVER_CONFIGURATION','Application origin is not configured.');}
  if(request.headers.get('origin')!==expected)throw new HttpError(403,'ORIGIN_DENIED','Use this application to submit the request.');
}
export async function mutationBody<T>(request:Request,schema:z.ZodType<T>):Promise<T>{
  requireSameOrigin(request);
  if(request.headers.get('content-type')?.split(';')[0]?.trim()!=='application/json')throw new HttpError(400,'INVALID_BODY','Use application/json.');
  const reader=request.body?.getReader();if(!reader)throw new HttpError(400,'INVALID_BODY','Request body required.');
  const chunks:Uint8Array[]=[];let count=0;
  try{for(;;){const part=await reader.read();if(part.done)break;count+=part.value.length;
    if(count>16384){await reader.cancel();throw new HttpError(413,'BODY_TOO_LARGE','Request is too large.');}chunks.push(part.value);}}
  finally{reader.releaseLock();}
  let value:unknown;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;}
  catch{throw new HttpError(400,'INVALID_BODY','Valid JSON required.');}
  const parsed=schema.safeParse(value);if(!parsed.success)throw new HttpError(400,'INVALID_BODY','Request does not match the required schema.');
  return parsed.data;
}
export function commandFailure(error:{code:string}|null):void{
  if(!error)return;
  if(error.code==='42501')throw new HttpError(403,'ACCESS_DENIED','The action is not authorized.');
  if(error.code==='P0002'||error.code==='23503')throw new HttpError(400,'UNKNOWN_REFERENCE','The requested record does not exist.');
  if(error.code==='23505'||error.code==='P0001')throw new HttpError(409,'STATE_CONFLICT','The current state cannot accept this action.');
  throw new HttpError(500,'DATABASE_ERROR','The action could not be committed.');
}

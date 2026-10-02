import 'server-only';
import {createHash} from 'node:crypto';
import {HttpError,requiredEnvironment} from '@/lib/http/errors';
import type {SourcePage} from './evidence';
export const sha256=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
export async function scanDocument(bytes:Uint8Array,mime:string):Promise<void>{
  if(!process.env.DOCUMENT_SCAN_URL||!process.env.DOCUMENT_SCAN_TOKEN)throw new HttpError(503,'SCANNER_DISABLED','Document scanning is not configured.');
  try{
    const response=await fetch(requiredEnvironment('DOCUMENT_SCAN_URL'),{method:'POST',headers:{authorization:`Bearer ${requiredEnvironment('DOCUMENT_SCAN_TOKEN')}`,'content-type':mime},body:Buffer.from(bytes),signal:AbortSignal.timeout(30000),cache:'no-store',redirect:'error'});
    if(!response.ok)throw new Error('scanner');
    const result:unknown=await response.json();
    if(!result||typeof result!=='object'||!('status' in result)||!('sha256' in result)||result.sha256!==sha256(bytes))throw new Error('hash');
    if(result.status!=='clean')throw new HttpError(422,'DOCUMENT_REJECTED','This document did not pass the security scan.');
  }catch(error){if(error instanceof HttpError)throw error;throw new HttpError(503,'SCANNER_UNAVAILABLE','Document scanning is temporarily unavailable.');}
}
export async function parseDocument(bytes:Uint8Array,mime:string,documentId:string):Promise<SourcePage[]>{
  try{
    let pages:SourcePage[];
    if(mime==='text/plain'){
      const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
      pages=text.split('\f').map((text,index)=>({document_id:documentId,page_number:index+1,text}));
    }else{
      if(Buffer.from(bytes.subarray(0,5)).toString()!=='%PDF-')throw new Error('pdf');
      const {PDFParse}=await import('pdf-parse');const parser=new PDFParse({data:bytes});
      try{const result=await parser.getText();pages=result.pages.map(p=>({document_id:documentId,page_number:p.num,text:p.text}));}
      finally{await parser.destroy();}
    }
    if(pages.length>100||Buffer.byteLength(pages.map(p=>p.text).join('\n'))>128*1024)throw new HttpError(413,'TEXT_TOO_LARGE','Use a shorter document within the pilot text limit.');
    if(!pages.some(p=>p.text.trim()))throw new HttpError(422,'OCR_REQUIRED','Upload a text-readable PDF or UTF-8 text document.');
    return pages;
  }catch(error){if(error instanceof HttpError)throw error;throw new HttpError(422,'UNREADABLE_DOCUMENT','The file could not be read. Use a text-readable PDF or UTF-8 text.');}
}

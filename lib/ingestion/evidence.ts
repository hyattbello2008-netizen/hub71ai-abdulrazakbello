export type SourcePage={document_id:string;page_number:number;text:string};
const labels={passport_name:'Full Name',passport_number:'Passport Number',qualification_name:'Qualification',issuing_authority:'Issuing Authority',professional_registration_number:'Registration Number',experience_dates:'Experience Dates',profession:'Profession'} as const;
export function validateSourceEvidence(pages:SourcePage[]){
  const fields:Record<string,string>={};const citations:{document_id:string;field_path:string;page_number:number;source_excerpt:string}[]=[];
  let conflicts=false;
  for(const [field,label] of Object.entries(labels)){
    const matches: {value:string;page:SourcePage;line:string}[]=[];
    for(const page of pages)for(const line of page.text.split(/\r?\n/)){
      const match=line.match(new RegExp('^\\s*'+label+':\\s*(.{1,300})\\s*$','i'));
      if(match?.[1]?.trim())matches.push({value:match[1].trim(),page,line});
    }
    if(new Set(matches.map(m=>m.value.toLowerCase())).size>1){conflicts=true;continue;}
    const first=matches[0];if(first){fields[field]=first.value;citations.push({document_id:first.page.document_id,field_path:field,page_number:first.page.page_number,source_excerpt:first.line});}
  }
  const persona=/^(registered )?(nurse|doctor|physician|pharmacist|dentist|midwife|physiotherapist)(\b|$)/i.test(fields.profession??'')?'healthcare':'unknown';
  if(!citations.length){const page=pages.find(p=>p.text.trim());if(page)citations.push({document_id:page.document_id,field_path:'document.content',page_number:page.page_number,source_excerpt:page.text.trim().slice(0,500)});}
  return {fields,citations,conflicts,persona,score:Math.round(Object.keys(fields).length/7*10000)/100,
    missing_fields:Object.keys(labels).filter(key=>!fields[key])};
}

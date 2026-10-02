// Safe in the Next.js 14 middleware runtime; no Node crypto or service key imports.
export type OperatorMembership={organization_id:string;role:string};
export function hasOperatorAccess(rows:OperatorMembership[]|null,organization?:string,approve=false):boolean {
  return !!rows?.some(row=>(!organization||row.organization_id===organization)&&
    (approve?['approver','administrator'].includes(row.role):['reviewer','approver','administrator'].includes(row.role)));
}
export function protectedPath(path:string):'applicant'|'operator'|null {
  if(path==='/workbench'||path.startsWith('/workbench/')||path==='/api/workbench'||path.startsWith('/api/workbench/'))return 'operator';
  if(path==='/dashboard'||path.startsWith('/dashboard/')||path==='/api/applications'||path.startsWith('/api/applications/')||
    path==='/api/ingestion'||path.startsWith('/api/ingestion/'))return 'applicant';
  return null;
}

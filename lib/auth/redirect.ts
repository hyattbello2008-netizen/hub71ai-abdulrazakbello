export function safeNext(value:string|null):string{
  if(value&&/^\/(dashboard|workbench)(\/[^?#\\]*)?$/.test(value))return value;
  return '/dashboard';
}

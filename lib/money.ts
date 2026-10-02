export function money(minor:string,currency='AED'){
  const value=BigInt(minor);const absolute=value<0n?-value:value;
  return `${currency} ${value<0n?'-':''}${new Intl.NumberFormat('en-AE').format(absolute/100n)}.${String(absolute%100n).padStart(2,'0')}`;
}

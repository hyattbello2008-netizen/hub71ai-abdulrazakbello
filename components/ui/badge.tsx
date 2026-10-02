import type {HTMLAttributes} from 'react';import {cn} from './utils';
export function Badge({className,...props}:HTMLAttributes<HTMLSpanElement>){return <span className={cn('inline-flex items-center gap-2 rounded border border-gold/25 bg-gold/5 px-2.5 py-1 text-xs font-medium text-gold',className)} {...props}/>;}

import * as React from 'react';import {cn} from './utils';
export const Card=React.forwardRef<HTMLDivElement,React.HTMLAttributes<HTMLDivElement>>(({className,...props},ref)=><div ref={ref} className={cn('min-w-0 rounded-lg border border-border bg-card text-card-foreground shadow-sm',className)} {...props}/>);Card.displayName='Card';
export function CardHeader({className,...props}:React.HTMLAttributes<HTMLDivElement>){return <div className={cn('flex flex-col gap-2 p-6',className)} {...props}/>;}
export function CardTitle({className,...props}:React.HTMLAttributes<HTMLHeadingElement>){return <h2 className={cn('text-lg font-semibold tracking-tight',className)} {...props}/>;}
export function CardDescription({className,...props}:React.HTMLAttributes<HTMLParagraphElement>){return <p className={cn('text-sm text-muted-foreground',className)} {...props}/>;}
export function CardContent({className,...props}:React.HTMLAttributes<HTMLDivElement>){return <div className={cn('p-6 pt-0',className)} {...props}/>;}


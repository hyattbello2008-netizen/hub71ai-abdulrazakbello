import {Suspense} from 'react';import AuthForm from '@/components/AuthForm';
export default function Signup(){return <Suspense fallback={<p>Loading registration...</p>}><AuthForm signup/></Suspense>;}

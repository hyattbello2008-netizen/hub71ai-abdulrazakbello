import {Suspense} from 'react';import AuthForm from '@/components/AuthForm';
export default function Login(){return <Suspense fallback={<p>Loading sign-in...</p>}><AuthForm/></Suspense>;}

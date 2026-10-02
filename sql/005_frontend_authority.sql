-- Additive Phase 3 migration, after 001 and 003. Run as trusted migration owner.
-- Supabase auth and storage schemas must already be provisioned by the Docker stack.
begin;
create table public.applicant_profiles (
  user_id uuid primary key references auth.users(id),
  display_name text not null default '' check (length(display_name) <= 120),
  created_at timestamptz not null default now()
);
insert into public.applicant_profiles(user_id) select id from auth.users;
alter table public.applicant_profiles enable row level security;
revoke all on public.applicant_profiles from public,anon,authenticated,service_role;
grant select on public.applicant_profiles to authenticated,service_role;
create policy own_profile on public.applicant_profiles for select to authenticated using (user_id=auth.uid());
create function private.bootstrap_applicant_profile() returns trigger
language plpgsql security definer set search_path='' as $$
begin insert into public.applicant_profiles(user_id) values(new.id); return new; end;
$$;
revoke all on function private.bootstrap_applicant_profile() from public,anon,authenticated,service_role;
create trigger falcon_profile_after_signup after insert on auth.users
for each row execute function private.bootstrap_applicant_profile();

-- Caller-bound lookup: no supplied actor ID, no grants to change memberships.
create function public.current_operator_memberships()
returns table(organization_id uuid,role text)
language sql stable security definer set search_path='' as $$
  select m.organization_id,m.role from public.organization_memberships m
  where m.user_id=auth.uid() and m.active;
$$;
revoke all on function public.current_operator_memberships() from public,anon,authenticated,service_role;
grant execute on function public.current_operator_memberships() to authenticated;

-- Database sums are exposed as text to avoid bigint/NUMERIC JSON rounding in JS.
create function public.account_balances_text(p_application_id uuid)
returns table(account_id uuid,code text,currency text,normal_side text,balance_minor text)
language sql stable security invoker set search_path='' as $$
  select b.account_id,b.code,b.currency,b.normal_side,b.balance_minor::text
  from public.account_balances(p_application_id) b;
$$;
revoke all on function public.account_balances_text(uuid) from public,anon,authenticated,service_role;
grant execute on function public.account_balances_text(uuid) to authenticated,service_role;
create function public.application_tranches_text(p_application_id uuid)
returns table(id uuid,milestone_code text,currency text,amount_minor text,status text)
language sql stable security invoker set search_path='' as $$
  select t.id,t.milestone_code,t.currency,t.amount_minor::text,t.status
  from public.application_tranches t where t.application_id=p_application_id order by t.created_at,t.id;
$$;
create function public.application_audit_text(p_application_id uuid)
returns table(id text,event_type text,actor_kind text,created_at timestamptz)
language sql stable security invoker set search_path='' as $$
  select a.id::text,a.event_type,a.actor_kind,a.created_at from public.audit_events a
  where a.application_id=p_application_id order by a.id desc limit 50;
$$;
revoke all on function public.application_tranches_text(uuid),public.application_audit_text(uuid) from public,anon,authenticated,service_role;
grant execute on function public.application_tranches_text(uuid),public.application_audit_text(uuid) to authenticated,service_role;

create table public.document_uploads (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications(id),
  applicant_id uuid not null references auth.users(id),
  object_key text not null unique,
  document_type text not null check(document_type in ('passport','qualification','professional_registration','experience','other')),
  mime_type text not null check(mime_type in ('application/pdf','text/plain')),
  expected_bytes integer not null check(expected_bytes between 1 and 5242880),
  status text not null default 'CREATED' check(status in ('CREATED','PROCESSING','DONE','FAILED')),
  stage text not null default 'UPLOADING' check(stage in ('UPLOADING','SCANNING','EXTRACTING','VALIDATING','COMPLETE','FAILED')),
  lease_token uuid,
  leased_until timestamptz,
  document_id uuid references public.application_documents(id),
  extraction_run_id uuid references public.extraction_runs(id),
  error_code text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default(now()+interval '30 minutes'),
  check((lease_token is null)=(leased_until is null)),
  check((status='PROCESSING')=(lease_token is not null))
);
create index uploads_applicant_idx on public.document_uploads(applicant_id,created_at);
create unique index one_ingestion_per_case on public.document_uploads(application_id) where status='PROCESSING';
alter table public.document_uploads enable row level security;
revoke all on public.document_uploads from public,anon,authenticated,service_role;
grant select on public.document_uploads to service_role;
grant select(id,application_id,applicant_id,object_key,document_type,mime_type,expected_bytes,status,stage,
  document_id,extraction_run_id,error_code,created_at,expires_at) on public.document_uploads to authenticated;
create policy scoped_upload_read on public.document_uploads for select to authenticated
using(private.can_read_application(application_id));

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('healthcare-evidence','healthcare-evidence',false,5242880,array['application/pdf','text/plain'])
on conflict(id) do update set public=false,file_size_limit=5242880,allowed_mime_types=array['application/pdf','text/plain'];
create function private.can_upload_evidence(p_key text) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.document_uploads u join public.applications a on a.id=u.application_id
    where u.object_key=p_key and u.applicant_id=auth.uid() and a.applicant_id=auth.uid()
      and u.status='CREATED' and u.expires_at>now() and a.status in ('DRAFT','UNDER_REVIEW','EXCEPTION'));
$$;
create function private.can_read_evidence(p_key text) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.document_uploads u where u.object_key=p_key
    and private.can_read_application(u.application_id));
$$;
revoke all on function private.can_upload_evidence(text),private.can_read_evidence(text) from public,anon,authenticated,service_role;
grant execute on function private.can_upload_evidence(text),private.can_read_evidence(text) to authenticated;
create policy falcon_evidence_insert on storage.objects for insert to authenticated
with check(bucket_id='healthcare-evidence' and private.can_upload_evidence(name));
create policy falcon_evidence_select on storage.objects for select to authenticated
using(bucket_id='healthcare-evidence' and private.can_read_evidence(name));
-- No UPDATE/DELETE policy: clients cannot overwrite evidence or remove a queued object.
-- Review any existing broad storage policies: PostgreSQL permissive policies combine with OR.

create function public.start_pilot_application(p_actor uuid,p_organization uuid,p_display_name text)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
  perform 1 from auth.users where id=p_actor for update;
  if not found then raise exception 'Unknown applicant'; end if;
  select id into v_id from public.applications where applicant_id=p_actor order by created_at,id limit 1;
  if found then return v_id; end if;
  update public.applicant_profiles set display_name=left(coalesce(p_display_name,''),120) where user_id=p_actor;
  v_id:=public.create_pilot_application(p_actor,p_organization,'AED');
  -- A fixed DEMO plan, never a bank instruction; balances remain zero until confirmation.
  perform public.add_pilot_tranche(v_id,'credential_review','simulated-credential-provider',750000);
  perform public.add_pilot_tranche(v_id,'relocation_complete','simulated-relocation-provider',4250000);
  return v_id;
end;
$$;
create function public.prepare_document_upload(p_application uuid,p_actor uuid,p_type text,p_mime text,p_bytes integer)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_app public.applications%rowtype; v_id uuid:=gen_random_uuid(); v_key text;
begin
  select * into strict v_app from public.applications where id=p_application for update;
  if v_app.applicant_id<>p_actor then raise exception 'Applicant not authorized' using errcode='42501'; end if;
  if v_app.status not in ('DRAFT','UNDER_REVIEW','EXCEPTION') then raise exception 'Case cannot accept new evidence'; end if;
  if (select count(*) from public.document_uploads where application_id=p_application and created_at>now()-interval '1 hour')>=12 then
    raise exception 'Upload limit reached';
  end if;
  v_key:=p_application::text||'/'||v_id::text||case when p_mime='application/pdf' then '.pdf' else '.txt' end;
  insert into public.document_uploads(id,application_id,applicant_id,object_key,document_type,mime_type,expected_bytes)
    values(v_id,p_application,p_actor,v_key,p_type,p_mime,p_bytes);
  insert into public.audit_events(application_id,actor_kind,event_type,entity_id)
    values(p_application,'backend','document.upload_authorized',v_id);
  return v_id;
end;
$$;
create function public.claim_document_ingestion(p_upload uuid,p_actor uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_app_id uuid; v_app public.applications%rowtype; v_upload public.document_uploads%rowtype; v_token uuid:=gen_random_uuid();
begin
  select application_id into strict v_app_id from public.document_uploads where id=p_upload;
  select * into strict v_app from public.applications where id=v_app_id for update;
  select * into strict v_upload from public.document_uploads where id=p_upload for update;
  if v_app.applicant_id<>p_actor or v_upload.applicant_id<>p_actor then raise exception 'Applicant not authorized' using errcode='42501'; end if;
  if v_upload.status='DONE' then raise exception 'Upload already ingested' using errcode='23505'; end if;
  if v_upload.expires_at<=now() or v_app.status not in ('DRAFT','UNDER_REVIEW','EXCEPTION') then raise exception 'Upload expired or case frozen'; end if;
  if exists(select 1 from public.document_uploads where application_id=v_app_id and status='PROCESSING' and leased_until>now()) then
    raise exception 'Ingestion already in progress';
  end if;
  update public.document_uploads set status='FAILED',stage='FAILED',error_code='LEASE_EXPIRED',lease_token=null,leased_until=null
    where application_id=v_app_id and status='PROCESSING' and leased_until<=now();
  update public.document_uploads set status='PROCESSING',stage='SCANNING',error_code=null,
    lease_token=v_token,leased_until=now()+interval '5 minutes' where id=p_upload;
  return v_token;
end;
$$;
create function private.require_ingestion_lease(p_upload uuid,p_actor uuid,p_lease uuid)
returns public.document_uploads language plpgsql set search_path='' as $$
declare v_upload public.document_uploads%rowtype; v_app uuid;
begin
  select application_id into strict v_app from public.document_uploads where id=p_upload;
  perform 1 from public.applications where id=v_app for update;
  select * into strict v_upload from public.document_uploads where id=p_upload for update;
  if v_upload.applicant_id<>p_actor then raise exception 'Applicant not authorized' using errcode='42501'; end if;
  if v_upload.status<>'PROCESSING' or v_upload.lease_token is distinct from p_lease or v_upload.leased_until<=now() then
    raise exception 'Stale ingestion lease';
  end if;
  return v_upload;
end;
$$;
create function public.set_ingestion_stage(p_upload uuid,p_actor uuid,p_lease uuid,p_stage text)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform private.require_ingestion_lease(p_upload,p_actor,p_lease);
  if p_stage not in ('SCANNING','EXTRACTING','VALIDATING') then raise exception 'Invalid ingestion stage'; end if;
  update public.document_uploads set stage=p_stage where id=p_upload;
end;
$$;
create function public.register_scanned_document(p_upload uuid,p_actor uuid,p_lease uuid,p_sha256 text)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_upload public.document_uploads%rowtype; v_id uuid;
begin
  v_upload:=private.require_ingestion_lease(p_upload,p_actor,p_lease);
  if v_upload.document_id is not null then return v_upload.document_id; end if;
  v_id:=public.add_pilot_document(v_upload.application_id,v_upload.document_type,v_upload.object_key,p_sha256);
  -- Only the trusted backend calls this AFTER the configured scanner confirms hash/clean.
  perform public.record_document_scan(v_id,true);
  update public.document_uploads set document_id=v_id where id=p_upload;
  return v_id;
end;
$$;
create function public.complete_document_ingestion(p_upload uuid,p_actor uuid,p_lease uuid,p_model text,
  p_data jsonb,p_llm_score numeric,p_validated_score numeric,p_conflicts boolean,p_citations jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_upload public.document_uploads%rowtype; v_run uuid;
begin
  v_upload:=private.require_ingestion_lease(p_upload,p_actor,p_lease);
  if v_upload.document_id is null then raise exception 'No scanned document'; end if;
  v_run:=public.record_pilot_extraction(v_upload.application_id,v_upload.id,p_model,'healthcare-labels-v1',
    p_data,p_llm_score,p_validated_score,p_conflicts,'source-coverage-v1',p_citations);
  update public.document_uploads set status='DONE',stage='COMPLETE',lease_token=null,leased_until=null,
    extraction_run_id=v_run where id=p_upload;
  return v_run;
end;
$$;
create function public.fail_document_ingestion(p_upload uuid,p_actor uuid,p_lease uuid,p_error_code text)
returns void language plpgsql security definer set search_path='' as $$
declare v_upload public.document_uploads%rowtype; v_status text;
begin
  v_upload:=private.require_ingestion_lease(p_upload,p_actor,p_lease);
  update public.document_uploads set status='FAILED',stage='FAILED',error_code=left(p_error_code,100),
    lease_token=null,leased_until=null where id=p_upload;
  select status into v_status from public.applications where id=v_upload.application_id;
  if v_status in ('DRAFT','EXCEPTION') then
    update public.applications set status='UNDER_REVIEW' where id=v_upload.application_id;
    v_status:='UNDER_REVIEW';
  end if;
  if v_status='UNDER_REVIEW' then
    update public.applications set status='EXCEPTION',review_reason_code=left(p_error_code,100) where id=v_upload.application_id;
  end if;
  insert into public.audit_events(application_id,actor_kind,event_type,entity_id,metadata)
    values(v_upload.application_id,'backend','document.ingestion_failed',p_upload,jsonb_build_object('error_code',left(p_error_code,100)));
end;
$$;
create function public.advance_pilot_application(p_application uuid,p_actor uuid,p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare v_status text;
begin
  select status into strict v_status from public.applications where id=p_application for update;
  perform private.require_operator(p_application,p_actor,true);
  if p_reason is null or length(p_reason) not between 10 and 2000 then raise exception 'Review justification required'; end if;
  if v_status in ('EXCEPTION','UNDER_REVIEW') then
    perform public.review_pilot_application(p_application,p_actor,'OVERRIDE_READY',p_reason);
  elsif v_status<>'READY' then raise exception 'Case cannot be advanced'; end if;
  perform public.route_pilot_application(p_application);
  insert into public.audit_events(application_id,actor_user_id,actor_kind,event_type,entity_id,metadata)
    values(p_application,p_actor,'operator','application.operator_advanced',p_application,jsonb_build_object('reason',p_reason));
end;
$$;
create function public.prepare_operator_simulated_funding(p_application uuid,p_actor uuid)
returns table(operation_id uuid,application_id uuid,currency text,amount_minor text,status text,occurred_at timestamptz)
language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
  perform 1 from public.applications where id=p_application for update;
  perform private.require_operator(p_application,p_actor,true);
  select o.id into v_id from public.payment_operations o where o.application_id=p_application and o.kind='FUND';
  if not found then v_id:=public.request_simulated_funding(p_application); end if;
  return query select o.id,o.application_id,o.currency,o.amount_minor::text,o.status,o.created_at
    from public.payment_operations o where o.id=v_id;
end;
$$;

do $$ declare v_fn record; begin
  for v_fn in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('start_pilot_application','prepare_document_upload','claim_document_ingestion',
      'set_ingestion_stage','register_scanned_document','complete_document_ingestion','fail_document_ingestion',
      'advance_pilot_application','prepare_operator_simulated_funding') loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',v_fn.signature);
    execute format('grant execute on function %s to service_role',v_fn.signature);
  end loop;
end $$;
revoke all on function private.require_ingestion_lease(uuid,uuid,uuid) from public,anon,authenticated,service_role;
commit;

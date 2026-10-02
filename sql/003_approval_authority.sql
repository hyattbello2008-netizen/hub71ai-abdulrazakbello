-- Additive Phase 2 extension. 001_foundation.sql remains unchanged.
-- Apply after the Phase 1 migration as its trusted migration owner.
-- Only doh_simulator callbacks are accepted. No payout is executed by this command.
begin;
alter table public.applications add column simulated_approval_status text not null default 'PENDING'
  check (simulated_approval_status in ('PENDING', 'APPROVED'));

create table public.government_approval_receipts (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null unique references public.applications(id),
  provider text not null default 'doh_simulator' check (provider = 'doh_simulator'),
  event_id text not null check (length(event_id) between 1 and 200),
  body_sha256 text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
  signature_key_id text not null check (length(signature_key_id) between 1 and 100),
  provider_occurred_at timestamptz not null,
  accepted_at timestamptz not null default now(),
  unique (provider, event_id)
);
alter table public.government_approval_receipts enable row level security;
revoke all on table public.government_approval_receipts from public, anon, authenticated, service_role;
grant select on table public.government_approval_receipts to service_role, authenticated;
create policy scoped_approval_read on public.government_approval_receipts
  for select to authenticated using (private.can_read_application(application_id));
create trigger immutable_rows before update or delete on public.government_approval_receipts
  for each row execute function private.reject_mutation();
create trigger immutable_truncate before truncate on public.government_approval_receipts
  for each statement execute function private.reject_mutation();

create function public.confirm_simulated_government_approval(
  p_application uuid, p_event_id text, p_body_sha256 text,
  p_key_id text, p_occurred_at timestamptz
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_app public.applications%rowtype; v_receipt uuid;
begin
  select * into strict v_app from public.applications where id = p_application for update;
  if v_app.simulated_approval_status = 'APPROVED' then
    raise exception 'Application already approved' using errcode = '23505';
  end if;
  if v_app.status <> 'ROUTED' or v_app.destination_code <> 'doh_simulator' then
    raise exception 'Simulated approval requires a routed healthcare case';
  end if;
  insert into public.government_approval_receipts(application_id,event_id,body_sha256,signature_key_id,provider_occurred_at)
    values (p_application,p_event_id,p_body_sha256,p_key_id,p_occurred_at) returning id into v_receipt;
  update public.applications set simulated_approval_status = 'APPROVED' where id = p_application;
  insert into public.audit_events(application_id,actor_kind,event_type,entity_id,metadata)
    values (p_application,'simulated_provider','application.simulated_approval_confirmed',v_receipt,
      jsonb_build_object('provider','doh_simulator','receipt_id',v_receipt));
  return v_receipt;
end;
$$;
revoke all on function public.confirm_simulated_government_approval(uuid,text,text,text,timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.confirm_simulated_government_approval(uuid,text,text,text,timestamptz) to service_role;

-- Preserve the Phase 1 tranche RPC, adding a DB-level precondition on RELEASE requests.
-- Government approval alone still cannot create postings or settle money.
create function private.require_simulated_approval_for_release() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.kind = 'RELEASE' and not exists (
    select 1 from public.applications a join public.government_approval_receipts r on r.application_id = a.id
    where a.id = new.application_id and a.simulated_approval_status = 'APPROVED'
  ) then raise exception 'Release request requires confirmed simulated government approval'; end if;
  return new;
end;
$$;
revoke all on function private.require_simulated_approval_for_release() from public, anon, authenticated, service_role;
create trigger simulated_approval_before_release before insert on public.payment_operations
  for each row execute function private.require_simulated_approval_for_release();
comment on table public.government_approval_receipts is
  'Immutable, signature-verified doh_simulator receipts; not evidence of live government approval.';
commit;

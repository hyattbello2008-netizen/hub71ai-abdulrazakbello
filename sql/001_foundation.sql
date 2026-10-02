-- Falcon Protocol: healthcare -> simulated DOH pathway, SIMULATED ESCROW ONLY.
-- Fresh Supabase self-hosted PostgreSQL 15+ database, run as migration owner.
-- One-shot migration. Keep public exposed for RPCs; NEVER expose private.
-- Currency amounts are minor units (AED fils). No custody, FX or yield integration.
begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated, service_role;

create table public.currencies (
  code text primary key check (code ~ '^[A-Z]{3}$'),
  minor_unit_exponent smallint not null check (minor_unit_exponent between 0 and 4)
);
insert into public.currencies values ('AED', 2), ('USD', 2), ('EUR', 2), ('GBP', 2);

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 200),
  created_at timestamptz not null default now()
);
create table public.organization_memberships (
  organization_id uuid not null references public.organizations(id),
  user_id uuid not null references auth.users(id),
  role text not null check (role in ('reviewer', 'approver', 'administrator')),
  active boolean not null default true,
  primary key (organization_id, user_id)
);
create index memberships_user_idx on public.organization_memberships(user_id);

create table public.applications (
  id uuid primary key default gen_random_uuid(), -- backend/database generated
  protocol_id uuid not null unique default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  applicant_id uuid not null references auth.users(id),
  persona text not null default 'healthcare' check (persona = 'healthcare'),
  pathway text not null default 'healthcare_doh_pilot' check (pathway = 'healthcare_doh_pilot'),
  environment text not null default 'simulation' check (environment = 'simulation'),
  funds_label text not null default 'Simulated Escrow' check (funds_label = 'Simulated Escrow'),
  currency text not null default 'AED' references public.currencies(code),
  status text not null default 'DRAFT'
    check (status in ('DRAFT', 'UNDER_REVIEW', 'EXCEPTION', 'READY', 'ROUTED', 'REJECTED', 'COMPLETED')),
  validated_completeness numeric(5,2) check (validated_completeness between 0 and 100),
  extracted_persona text,
  has_conflicts boolean not null default false,
  rules_version text,
  destination_code text check (destination_code is null or destination_code = 'doh_simulator'),
  review_reason_code text,
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, currency),
  check (status <> 'ROUTED' or destination_code = 'doh_simulator')
);
create index applications_applicant_idx on public.applications(applicant_id);
create index applications_queue_idx on public.applications(organization_id, status, created_at);

create table public.application_documents (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications(id),
  document_type text not null check (document_type in
    ('passport', 'qualification', 'professional_registration', 'experience', 'other')),
  storage_bucket text not null default 'healthcare-evidence' check (storage_bucket = 'healthcare-evidence'),
  storage_key text not null unique, -- private object path, never a public URL
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  scan_status text not null default 'QUARANTINED'
    check (scan_status in ('QUARANTINED', 'CLEAN', 'REJECTED')),
  uploaded_at timestamptz not null default now(),
  unique (id, application_id)
);
create index documents_application_idx on public.application_documents(application_id);

-- Immutable extraction history: LLM score is an untrusted claim, not authority.
create table public.extraction_runs (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications(id),
  extraction_request_id uuid not null unique,
  model_version text not null,
  schema_version text not null,
  extracted_data jsonb not null check (jsonb_typeof(extracted_data) = 'object'
    and extracted_data ? 'persona' and jsonb_typeof(extracted_data->'persona') = 'string'),
  llm_completeness numeric(5,2) check (llm_completeness between 0 and 100),
  validated_completeness numeric(5,2) not null check (validated_completeness between 0 and 100),
  has_conflicts boolean not null,
  rules_version text not null,
  created_at timestamptz not null default now(),
  unique (id, application_id)
);
create index extraction_application_idx on public.extraction_runs(application_id, created_at);
create table public.evidence_citations (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications(id),
  extraction_run_id uuid not null,
  document_id uuid not null,
  field_path text not null,
  page_number integer not null check (page_number > 0),
  source_excerpt text not null,
  foreign key (extraction_run_id, application_id) references public.extraction_runs(id, application_id),
  foreign key (document_id, application_id) references public.application_documents(id, application_id)
);
create index citations_application_idx on public.evidence_citations(application_id);

create table public.application_reviews (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications(id),
  actor_user_id uuid not null references auth.users(id),
  action text not null check (action in ('REQUEST_DOCUMENTS', 'OVERRIDE_READY', 'REJECT')),
  reason text not null check (length(reason) between 10 and 2000),
  created_at timestamptz not null default now()
);
create index reviews_application_idx on public.application_reviews(application_id);

create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null,
  currency text not null,
  code text not null check (code in ('SIMULATED_CUSTODY', 'APPLICANT_ESCROW')),
  account_type text not null check (account_type in ('asset', 'liability')),
  normal_side text not null check (normal_side in ('debit', 'credit')),
  environment text not null default 'simulation' check (environment = 'simulation'),
  created_at timestamptz not null default now(),
  foreign key (application_id, currency) references public.applications(id, currency),
  unique (application_id, code),
  unique (id, application_id, currency),
  check ((code = 'SIMULATED_CUSTODY' and account_type = 'asset' and normal_side = 'debit')
      or (code = 'APPLICANT_ESCROW' and account_type = 'liability' and normal_side = 'credit'))
);

create table public.application_tranches (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null,
  currency text not null,
  milestone_code text not null check (length(milestone_code) between 1 and 100),
  beneficiary_reference text not null, -- internal simulated beneficiary ID, no bank details
  amount_minor bigint not null check (amount_minor > 0),
  status text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'RELEASED', 'REFUNDED')),
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  approval_reason text,
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  foreign key (application_id, currency) references public.applications(id, currency),
  unique (application_id, milestone_code),
  unique (id, application_id, currency),
  check (status not in ('APPROVED', 'RELEASED') or (approved_by is not null and approved_at is not null))
);

create table public.payment_operations (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null,
  tranche_id uuid,
  currency text not null,
  kind text not null check (kind in ('FUND', 'RELEASE', 'REFUND')),
  amount_minor bigint not null check (amount_minor > 0),
  status text not null default 'REQUESTED' check (status in ('REQUESTED', 'CONFIRMED')),
  idempotency_key uuid not null unique default gen_random_uuid(),
  provider text not null default 'falcon_simulator' check (provider = 'falcon_simulator'),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  foreign key (application_id, currency) references public.applications(id, currency),
  foreign key (tranche_id, application_id, currency) references public.application_tranches(id, application_id, currency),
  unique (id, application_id, currency),
  check ((kind = 'FUND' and tranche_id is null) or (kind in ('RELEASE', 'REFUND') and tranche_id is not null)),
  check ((status = 'CONFIRMED') = (confirmed_at is not null))
);
create unique index one_funding_operation on public.payment_operations(application_id) where kind = 'FUND';
-- A tranche cannot have both an outstanding release and refund.
create unique index one_terminal_operation on public.payment_operations(tranche_id) where tranche_id is not null;

-- Only successful, signature-verified confirmations accepted by the backend reach this table.
-- Failed processing rolls the receipt back; an identical retry can then succeed.
create table public.webhook_receipts (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider = 'falcon_simulator'),
  event_id text not null check (length(event_id) between 1 and 200),
  operation_id uuid not null unique references public.payment_operations(id),
  body_sha256 text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
  signature_key_id text not null,
  provider_occurred_at timestamptz not null,
  accepted_at timestamptz not null default now(),
  unique (provider, event_id)
);

create table public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null,
  currency text not null,
  payment_operation_id uuid not null unique,
  receipt_id uuid not null unique references public.webhook_receipts(id),
  kind text not null check (kind in ('FUND', 'RELEASE', 'REFUND')),
  environment text not null default 'simulation' check (environment = 'simulation'),
  description text not null,
  created_at timestamptz not null default now(),
  created_transaction bigint not null default txid_current(),
  foreign key (application_id, currency) references public.applications(id, currency),
  foreign key (payment_operation_id, application_id, currency) references public.payment_operations(id, application_id, currency),
  unique (id, application_id, currency)
);
create index journal_application_idx on public.journal_entries(application_id, created_at);
create table public.postings (
  id bigint generated always as identity primary key,
  journal_entry_id uuid not null,
  application_id uuid not null,
  account_id uuid not null,
  currency text not null,
  side text not null check (side in ('debit', 'credit')),
  amount_minor bigint not null check (amount_minor > 0),
  created_at timestamptz not null default now(),
  foreign key (journal_entry_id, application_id, currency) references public.journal_entries(id, application_id, currency),
  foreign key (account_id, application_id, currency) references public.accounts(id, application_id, currency),
  unique (journal_entry_id, account_id)
);
create index postings_account_idx on public.postings(account_id);
create index postings_application_idx on public.postings(application_id);

create table public.audit_events (
  id bigint generated always as identity primary key,
  application_id uuid not null references public.applications(id),
  actor_user_id uuid references auth.users(id),
  actor_kind text not null check (actor_kind in ('backend', 'operator', 'simulated_provider')),
  event_type text not null,
  entity_id uuid,
  metadata jsonb not null default '{}' check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);
create index audit_application_idx on public.audit_events(application_id, id);

-- Immutable dispatch intent; metadata contains IDs/statuses, not document contents.
create table public.outbox_events (
  id uuid primary key default gen_random_uuid(),
  audit_event_id bigint not null unique references public.audit_events(id),
  application_id uuid not null references public.applications(id),
  topic text not null,
  created_at timestamptz not null default now()
);
-- Mutable delivery bookkeeping is deliberately separate from audit history.
create table public.outbox_delivery (
  outbox_event_id uuid primary key references public.outbox_events(id),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  lease_token uuid,
  leased_until timestamptz,
  delivered_at timestamptz,
  last_error_code text,
  check ((lease_token is null) = (leased_until is null))
);
create index outbox_pending_idx on public.outbox_delivery(available_at) where delivered_at is null;

-- Private, fixed search_path functions; no role is authorized by client-editable metadata.
create function private.can_read_application(p_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.applications a where a.id = p_id and
    (a.applicant_id = auth.uid() or exists (
      select 1 from public.organization_memberships m
      where m.organization_id = a.organization_id and m.user_id = auth.uid() and m.active
    ))
  );
$$;
create function private.is_operator(p_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.applications a
    join public.organization_memberships m on m.organization_id = a.organization_id
    where a.id = p_id and m.user_id = auth.uid() and m.active);
$$;
create function private.require_operator(p_application uuid, p_actor uuid, p_approve boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.applications a
    join public.organization_memberships m on m.organization_id = a.organization_id
    where a.id = p_application and m.user_id = p_actor and m.active
      and (not p_approve or m.role in ('approver', 'administrator'))) then
    raise exception 'Operator not authorized' using errcode = '42501';
  end if;
end;
$$;

create function private.reject_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '% is append-only: % prohibited', tg_table_name, tg_op using errcode = '42501';
end;
$$;

create function private.guard_posting_insert() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.journal_entries j
    where j.id = new.journal_entry_id and j.created_transaction = txid_current()) then
    raise exception 'Cannot append postings to a journal from another transaction';
  end if;
  return new;
end;
$$;
create trigger posting_same_transaction before insert on public.postings
for each row execute function private.guard_posting_insert();

create function private.assert_balanced_journal() returns trigger
language plpgsql set search_path = '' as $$
declare v_id uuid; v_count bigint; v_total numeric; v_debits numeric;
begin
  if tg_table_name = 'journal_entries' then v_id := new.id;
  else v_id := new.journal_entry_id; end if;
  select count(*), coalesce(sum(case when side = 'debit' then amount_minor::numeric
    else -amount_minor::numeric end), 0),
    coalesce(sum(amount_minor::numeric) filter (where side = 'debit'), 0)
    into v_count, v_total, v_debits
    from public.postings where journal_entry_id = v_id;
  if v_count < 2 or v_total <> 0 then
    raise exception 'Journal % must have at least two balanced postings', v_id;
  end if;
  if not exists (select 1 from public.journal_entries j
    join public.payment_operations o on o.id = j.payment_operation_id
    join public.webhook_receipts r on r.id = j.receipt_id
    where j.id = v_id and o.status = 'CONFIRMED' and o.kind = j.kind
      and r.operation_id = o.id and v_debits = o.amount_minor) then
    raise exception 'Journal does not match a confirmed payment and receipt';
  end if;
  return null;
end;
$$;
-- Both triggers matter: even an empty journal must fail at COMMIT.
create constraint trigger journal_balanced after insert on public.journal_entries
deferrable initially deferred for each row execute function private.assert_balanced_journal();
create constraint trigger postings_balanced after insert on public.postings
deferrable initially deferred for each row execute function private.assert_balanced_journal();

create function private.enqueue_audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  insert into public.outbox_events(audit_event_id, application_id, topic)
    values (new.id, new.application_id, new.event_type) returning id into v_id;
  insert into public.outbox_delivery(outbox_event_id) values (v_id);
  return null;
end;
$$;
create trigger audit_outbox after insert on public.audit_events
for each row execute function private.enqueue_audit();

create function private.guard_application() returns trigger
language plpgsql set search_path = '' as $$
begin
  if row(new.id, new.protocol_id, new.organization_id, new.applicant_id, new.currency,
      new.persona, new.pathway, new.environment, new.funds_label, new.created_at)
    is distinct from row(old.id, old.protocol_id, old.organization_id, old.applicant_id, old.currency,
      old.persona, old.pathway, old.environment, old.funds_label, old.created_at) then
    raise exception 'Application ownership and pilot identity are immutable';
  end if;
  if new.status <> old.status and not (
    (old.status = 'DRAFT' and new.status = 'UNDER_REVIEW') or
    (old.status = 'UNDER_REVIEW' and new.status in ('READY', 'EXCEPTION', 'REJECTED')) or
    (old.status = 'EXCEPTION' and new.status in ('UNDER_REVIEW', 'READY', 'REJECTED')) or
    (old.status = 'READY' and new.status in ('ROUTED', 'UNDER_REVIEW', 'REJECTED')) or
    (old.status = 'ROUTED' and new.status in ('COMPLETED', 'REJECTED'))
  ) then raise exception 'Illegal application transition: % -> %', old.status, new.status; end if;
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end;
$$;
create trigger application_transition before update on public.applications
for each row execute function private.guard_application();

-- Aggregate under caller permissions and RLS, not a privileged/materialized view.
-- Returns NUMERIC because sums of BIGINT may exceed BIGINT. Send as strings to JS.
create function public.account_balances(p_application_id uuid)
returns table(account_id uuid, code text, currency text, normal_side text,
  debit_minor numeric, credit_minor numeric, balance_minor numeric)
language sql stable security invoker set search_path = '' as $$
  select a.id, a.code, a.currency, a.normal_side,
    coalesce(sum(p.amount_minor::numeric) filter (where p.side = 'debit'), 0),
    coalesce(sum(p.amount_minor::numeric) filter (where p.side = 'credit'), 0),
    coalesce(sum(case when p.side = a.normal_side then p.amount_minor::numeric
      else -p.amount_minor::numeric end), 0)
  from public.accounts a left join public.postings p on p.account_id = a.id
  where a.application_id = p_application_id group by a.id;
$$;

-- Service-only commands. Next.js authenticates callers and derives identity itself.
create function public.create_pilot_application(p_applicant uuid, p_organization uuid, p_currency text default 'AED')
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  insert into public.applications(applicant_id, organization_id, currency)
    values (p_applicant, p_organization, p_currency) returning id into v_id;
  insert into public.accounts(application_id, currency, code, account_type, normal_side)
    values (v_id, p_currency, 'SIMULATED_CUSTODY', 'asset', 'debit'),
           (v_id, p_currency, 'APPLICANT_ESCROW', 'liability', 'credit');
  insert into public.audit_events(application_id, actor_kind, event_type, entity_id)
    values (v_id, 'backend', 'application.created', v_id);
  return v_id;
end;
$$;

create function public.add_pilot_document(p_application uuid, p_type text, p_key text, p_sha256 text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_status text;
begin
  select status into v_status from public.applications where id = p_application for update;
  if not found or v_status not in ('DRAFT', 'UNDER_REVIEW', 'EXCEPTION') then
    raise exception 'Application cannot accept documents';
  end if;
  if p_key not like p_application::text || '/%' then
    raise exception 'Storage key must be scoped to application UUID';
  end if;
  insert into public.application_documents(application_id, document_type, storage_key, sha256)
    values (p_application, p_type, p_key, p_sha256) returning id into v_id;
  insert into public.audit_events(application_id, actor_kind, event_type, entity_id)
    values (p_application, 'backend', 'document.quarantined', v_id);
  return v_id;
end;
$$;
create function public.record_document_scan(p_document uuid, p_clean boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_app uuid;
begin
  if p_clean is null then raise exception 'Scan outcome required'; end if;
  update public.application_documents set scan_status = case when p_clean then 'CLEAN' else 'REJECTED' end
    where id = p_document and scan_status = 'QUARANTINED' returning application_id into v_app;
  if not found then raise exception 'Document not quarantined'; end if;
  insert into public.audit_events(application_id, actor_kind, event_type, entity_id, metadata)
    values (v_app, 'backend', 'document.scanned', p_document, jsonb_build_object('clean', p_clean));
end;
$$;

create function public.record_pilot_extraction(
  p_application uuid, p_request_id uuid, p_model text, p_schema text, p_data jsonb,
  p_llm_score numeric, p_validated_score numeric, p_conflicts boolean, p_rules text, p_citations jsonb
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_app public.applications%rowtype; v_run uuid; v_c jsonb; v_document uuid;
begin
  select * into strict v_app from public.applications where id = p_application for update;
  if v_app.status not in ('DRAFT', 'UNDER_REVIEW', 'EXCEPTION') then raise exception 'Case not accepting extraction'; end if;
  if p_validated_score is null or p_conflicts is null or p_citations is null
    or jsonb_typeof(p_citations) <> 'array' then raise exception 'Validated results and citations required'; end if;
  if round(p_validated_score, 2) <> p_validated_score then
    raise exception 'Validated completeness must have at most two decimal places';
  end if;
  if jsonb_array_length(p_citations) = 0 then raise exception 'Evidence citations required'; end if;
  if v_app.status <> 'UNDER_REVIEW' then
    update public.applications set status = 'UNDER_REVIEW' where id = p_application;
  end if;
  insert into public.extraction_runs(application_id, extraction_request_id, model_version, schema_version,
    extracted_data, llm_completeness, validated_completeness, has_conflicts, rules_version)
    values (p_application, p_request_id, p_model, p_schema, p_data, p_llm_score, p_validated_score, p_conflicts, p_rules)
    returning id into v_run;
  for v_c in select value from jsonb_array_elements(p_citations) loop
    v_document := (v_c->>'document_id')::uuid;
    if not exists (select 1 from public.application_documents where id = v_document
      and application_id = p_application and scan_status = 'CLEAN') then
      raise exception 'Citation must reference a clean document in this case';
    end if;
    insert into public.evidence_citations(application_id, extraction_run_id, document_id, field_path, page_number, source_excerpt)
      values (p_application, v_run, v_document, v_c->>'field_path', (v_c->>'page_number')::integer, v_c->>'source_excerpt');
  end loop;
  update public.applications set validated_completeness = p_validated_score, has_conflicts = p_conflicts,
    extracted_persona = p_data->>'persona',
    rules_version = p_rules, destination_code = null,
    status = case when p_validated_score > 98 and not p_conflicts and p_data->>'persona' = 'healthcare'
      then 'READY' else 'EXCEPTION' end,
    review_reason_code = case when p_data->>'persona' <> 'healthcare' then 'PERSONA_MISMATCH'
      when p_conflicts then 'CONFLICTING_EVIDENCE'
      when p_validated_score <= 98 then 'INCOMPLETE_EVIDENCE' else null end
    where id = p_application;
  insert into public.audit_events(application_id, actor_kind, event_type, entity_id, metadata)
    values (p_application, 'backend', 'extraction.validated', v_run,
      jsonb_build_object('validated_completeness', p_validated_score, 'has_conflicts', p_conflicts, 'rules_version', p_rules));
  return v_run;
end;
$$;

create function public.review_pilot_application(p_application uuid, p_actor uuid, p_action text, p_reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_status text;
begin
  select status into strict v_status from public.applications where id = p_application for update;
  perform private.require_operator(p_application, p_actor, p_action in ('OVERRIDE_READY', 'REJECT'));
  if v_status not in ('EXCEPTION', 'UNDER_REVIEW', 'READY', 'ROUTED') then raise exception 'Case cannot be reviewed'; end if;
  if p_action = 'REQUEST_DOCUMENTS' and v_status = 'ROUTED' then raise exception 'Cannot reopen routed case'; end if;
  if p_action = 'OVERRIDE_READY' and v_status not in ('EXCEPTION', 'UNDER_REVIEW') then raise exception 'No exception to override'; end if;
  insert into public.application_reviews(application_id, actor_user_id, action, reason)
    values (p_application, p_actor, p_action, p_reason) returning id into v_id;
  update public.applications set status = case p_action when 'REQUEST_DOCUMENTS' then 'UNDER_REVIEW'
    when 'OVERRIDE_READY' then 'READY' when 'REJECT' then 'REJECTED' end,
    destination_code = null, review_reason_code = p_action where id = p_application;
  insert into public.audit_events(application_id, actor_user_id, actor_kind, event_type, entity_id, metadata)
    values (p_application, p_actor, 'operator', 'application.reviewed', v_id, jsonb_build_object('action', p_action));
  return v_id;
end;
$$;
create function public.route_pilot_application(p_application uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_app public.applications%rowtype;
begin
  select * into strict v_app from public.applications where id = p_application for update;
  if v_app.status <> 'READY' then raise exception 'Case not ready'; end if;
  if not (coalesce(v_app.validated_completeness > 98 and not v_app.has_conflicts
      and v_app.extracted_persona = 'healthcare', false)
      or v_app.review_reason_code = 'OVERRIDE_READY') then raise exception 'Routing gate not satisfied'; end if;
  update public.applications set status = 'ROUTED', destination_code = 'doh_simulator' where id = p_application;
  insert into public.audit_events(application_id, actor_kind, event_type, entity_id, metadata)
    values (p_application, 'backend', 'application.routed', p_application, jsonb_build_object('destination', 'doh_simulator'));
end;
$$;

-- Tranches are frozen once funding is requested, making the funded total predictable.
create function public.add_pilot_tranche(p_application uuid, p_milestone text, p_beneficiary text, p_amount_minor bigint)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_app public.applications%rowtype;
begin
  select * into strict v_app from public.applications where id = p_application for update;
  if v_app.status in ('REJECTED', 'COMPLETED') or exists
    (select 1 from public.payment_operations where application_id = p_application) then
    raise exception 'Tranche plan frozen';
  end if;
  insert into public.application_tranches(application_id, currency, milestone_code, beneficiary_reference, amount_minor)
    values (p_application, v_app.currency, p_milestone, p_beneficiary, p_amount_minor) returning id into v_id;
  insert into public.audit_events(application_id, actor_kind, event_type, entity_id)
    values (p_application, 'backend', 'tranche.created', v_id);
  return v_id;
end;
$$;
create function public.request_simulated_funding(p_application uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_app public.applications%rowtype; v_total numeric;
begin
  select * into strict v_app from public.applications where id = p_application for update;
  if v_app.status in ('REJECTED', 'COMPLETED') then raise exception 'Case cannot be funded'; end if;
  select sum(amount_minor::numeric) into v_total from public.application_tranches where application_id = p_application;
  if v_total is null or v_total <= 0 or v_total > 9223372036854775807 then raise exception 'Invalid tranche total'; end if;
  insert into public.payment_operations(application_id, currency, kind, amount_minor)
    values (p_application, v_app.currency, 'FUND', v_total::bigint) returning id into v_id;
  insert into public.audit_events(application_id, actor_kind, event_type, entity_id)
    values (p_application, 'backend', 'payment.requested', v_id);
  return v_id;
end;
$$;

create function public.request_simulated_tranche_payment(p_tranche uuid, p_actor uuid, p_kind text, p_reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_app public.applications%rowtype; v_tranche public.application_tranches%rowtype; v_app_id uuid; v_id uuid;
begin
  select application_id into strict v_app_id from public.application_tranches where id = p_tranche;
  select * into strict v_app from public.applications where id = v_app_id for update;
  select * into strict v_tranche from public.application_tranches where id = p_tranche for update;
  perform private.require_operator(v_app_id, p_actor, true);
  if p_kind is null or p_kind not in ('RELEASE', 'REFUND') then raise exception 'Invalid operation kind'; end if;
  if p_reason is null or length(p_reason) not between 10 and 2000 then raise exception 'Meaningful reason required'; end if;
  if v_tranche.status <> 'PENDING' then raise exception 'Tranche not pending'; end if;
  if not exists (select 1 from public.payment_operations where application_id = v_app_id and kind = 'FUND' and status = 'CONFIRMED') then
    raise exception 'Funding not confirmed';
  end if;
  if p_kind = 'RELEASE' and v_app.status <> 'ROUTED' then raise exception 'Release requires routed case'; end if;
  if p_kind = 'REFUND' and v_app.status <> 'REJECTED' then raise exception 'Refund requires rejected case'; end if;
  if p_kind = 'RELEASE' then
    update public.application_tranches set status = 'APPROVED', approved_by = p_actor, approved_at = now(),
      approval_reason = p_reason, version = version + 1 where id = p_tranche;
  end if;
  insert into public.payment_operations(application_id, tranche_id, currency, kind, amount_minor)
    values (v_app_id, p_tranche, v_app.currency, p_kind, v_tranche.amount_minor) returning id into v_id;
  insert into public.audit_events(application_id, actor_user_id, actor_kind, event_type, entity_id, metadata)
    values (v_app_id, p_actor, 'operator', 'payment.requested', v_id,
      jsonb_build_object('kind', p_kind, 'tranche_id', p_tranche, 'reason', p_reason));
  return v_id;
end;
$$;

-- ONE RPC = ONE PostgreSQL transaction. Call only AFTER raw-body signature verification.
-- Payload amounts/currency/kind must match the operation; never trust callback amounts.
create function public.confirm_simulated_payment(
  p_operation uuid, p_event_id text, p_body_sha256 text, p_key_id text,
  p_occurred_at timestamptz, p_kind text, p_currency text, p_amount_minor bigint
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_operation public.payment_operations%rowtype; v_app public.applications%rowtype;
  v_app_id uuid; v_receipt uuid; v_journal uuid; v_asset uuid; v_liability uuid; v_balance numeric;
begin
  select application_id into strict v_app_id from public.payment_operations where id = p_operation;
  -- Every financial command serializes on the same application row, before other locks.
  select * into strict v_app from public.applications where id = v_app_id for update;
  select * into strict v_operation from public.payment_operations where id = p_operation for update;
  if v_operation.status <> 'REQUESTED' then raise exception 'Operation already confirmed' using errcode = '23505'; end if;
  if row(p_kind, p_currency, p_amount_minor) is distinct from
    row(v_operation.kind, v_operation.currency, v_operation.amount_minor) then raise exception 'Confirmation mismatch'; end if;
  insert into public.webhook_receipts(provider, event_id, operation_id, body_sha256, signature_key_id, provider_occurred_at)
    values ('falcon_simulator', p_event_id, p_operation, p_body_sha256, p_key_id, p_occurred_at) returning id into v_receipt;
  select id into strict v_asset from public.accounts where application_id = v_app_id and code = 'SIMULATED_CUSTODY';
  select id into strict v_liability from public.accounts where application_id = v_app_id and code = 'APPLICANT_ESCROW';
  if v_operation.kind <> 'FUND' then
    select coalesce(sum(case when side = 'credit' then amount_minor::numeric else -amount_minor::numeric end), 0)
      into v_balance from public.postings where account_id = v_liability;
    if v_balance < v_operation.amount_minor then raise exception 'Insufficient simulated escrow'; end if;
    if v_operation.kind = 'RELEASE' and not exists (select 1 from public.application_tranches
      where id = v_operation.tranche_id and status = 'APPROVED') then raise exception 'Tranche not approved'; end if;
    if v_operation.kind = 'REFUND' and v_app.status <> 'REJECTED' then raise exception 'Case not rejected'; end if;
  end if;
  -- A previously authorized release remains valid if rejection arrives later: the
  -- outstanding operation owns this tranche; only untouched tranches are refunded.
  update public.payment_operations set status = 'CONFIRMED', confirmed_at = now() where id = p_operation;
  insert into public.journal_entries(application_id, currency, payment_operation_id, receipt_id, kind, description)
    values (v_app_id, v_operation.currency, p_operation, v_receipt, v_operation.kind,
      'Simulated Escrow: ' || v_operation.kind) returning id into v_journal;
  insert into public.postings(journal_entry_id, application_id, account_id, currency, side, amount_minor)
    values (v_journal, v_app_id, v_asset, v_operation.currency,
      case when v_operation.kind = 'FUND' then 'debit' else 'credit' end, v_operation.amount_minor),
      (v_journal, v_app_id, v_liability, v_operation.currency,
      case when v_operation.kind = 'FUND' then 'credit' else 'debit' end, v_operation.amount_minor);
  if v_operation.tranche_id is not null then
    update public.application_tranches set status = case when v_operation.kind = 'RELEASE' then 'RELEASED' else 'REFUNDED' end,
      version = version + 1 where id = v_operation.tranche_id;
  end if;
  if v_app.status = 'ROUTED' and not exists (select 1 from public.application_tranches
    where application_id = v_app_id and status <> 'RELEASED') then
    update public.applications set status = 'COMPLETED' where id = v_app_id;
  end if;
  insert into public.audit_events(application_id, actor_kind, event_type, entity_id, metadata)
    values (v_app_id, 'simulated_provider', 'payment.confirmed', v_journal,
      jsonb_build_object('operation_id', p_operation, 'kind', v_operation.kind, 'amount_minor', v_operation.amount_minor::text, 'currency', v_operation.currency));
  return v_journal;
end;
$$;

-- Durable worker leases. External delivery is at-least-once; receivers deduplicate by outbox ID.
create function public.claim_outbox(p_limit integer default 20)
returns table(event_id uuid, audit_event_id bigint, application_id uuid, topic text, lease_token uuid)
language plpgsql security definer set search_path = '' as $$
begin
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'Limit must be 1..100'; end if;
  return query with pending as (
    select d.outbox_event_id from public.outbox_delivery d
    where d.delivered_at is null and d.available_at <= now()
      and (d.leased_until is null or d.leased_until <= now())
    order by d.available_at, d.outbox_event_id for update skip locked limit p_limit
  ), claimed as (
    update public.outbox_delivery d set attempts = d.attempts + 1,
      lease_token = gen_random_uuid(), leased_until = now() + interval '60 seconds'
    from pending where d.outbox_event_id = pending.outbox_event_id returning d.outbox_event_id, d.lease_token
  ) select o.id, o.audit_event_id, o.application_id, o.topic, c.lease_token
    from claimed c join public.outbox_events o on o.id = c.outbox_event_id;
end;
$$;
create function public.finish_outbox(p_event uuid, p_lease uuid, p_success boolean, p_error_code text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_success is null then raise exception 'Delivery outcome required'; end if;
  update public.outbox_delivery set delivered_at = case when p_success then now() else null end,
    available_at = case when p_success then available_at else now() + interval '60 seconds' end,
    last_error_code = case when p_success then null else left(p_error_code, 100) end,
    lease_token = null, leased_until = null
    where outbox_event_id = p_event and lease_token = p_lease and leased_until > now() and delivered_at is null;
  if not found then raise exception 'Stale or invalid delivery lease'; end if;
end;
$$;

-- Lock down ALL pilot tables, including INSERT/TRUNCATE for the service role.
-- Only approved SECURITY DEFINER commands mutate them. BYPASSRLS does not bypass grants/triggers.
do $$
declare v_table text;
begin
  foreach v_table in array array['currencies', 'organizations', 'organization_memberships', 'applications',
    'application_documents', 'extraction_runs', 'evidence_citations', 'application_reviews', 'accounts',
    'application_tranches', 'payment_operations', 'webhook_receipts', 'journal_entries', 'postings',
    'audit_events', 'outbox_events', 'outbox_delivery'] loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', v_table);
    execute format('grant select on table public.%I to service_role', v_table);
  end loop;
  foreach v_table in array array['accounts', 'journal_entries', 'postings', 'audit_events', 'outbox_events',
    'webhook_receipts', 'extraction_runs', 'evidence_citations', 'application_reviews'] loop
    execute format('create trigger immutable_rows before update or delete on public.%I for each row execute function private.reject_mutation()', v_table);
    execute format('create trigger immutable_truncate before truncate on public.%I for each statement execute function private.reject_mutation()', v_table);
  end loop;
end;
$$;
revoke all on sequence public.postings_id_seq, public.audit_events_id_seq from public, anon, authenticated, service_role;

grant select on public.currencies, public.applications, public.application_documents, public.extraction_runs,
  public.evidence_citations, public.application_tranches, public.accounts, public.journal_entries, public.postings,
  public.application_reviews, public.audit_events to authenticated;
create policy currency_read on public.currencies for select to authenticated using (true);
create policy application_read on public.applications for select to authenticated using (private.can_read_application(id));
do $$
declare v_table text;
begin
  foreach v_table in array array['application_documents', 'extraction_runs', 'evidence_citations',
    'application_tranches', 'accounts', 'journal_entries', 'postings'] loop
    execute format('create policy case_read on public.%I for select to authenticated using (private.can_read_application(application_id))', v_table);
  end loop;
  foreach v_table in array array['application_reviews', 'audit_events'] loop
    execute format('create policy staff_read on public.%I for select to authenticated using (private.is_operator(application_id))', v_table);
  end loop;
end;
$$;

-- Revoke PostgreSQL's default PUBLIC EXECUTE on each newly-created function.
do $$
declare v_fn record;
begin
  for v_fn in select p.oid::regprocedure as signature from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'private') or (n.nspname = 'public' and p.proname in
      ('account_balances', 'create_pilot_application', 'add_pilot_document', 'record_document_scan',
       'record_pilot_extraction', 'review_pilot_application', 'route_pilot_application', 'add_pilot_tranche',
       'request_simulated_funding', 'request_simulated_tranche_payment', 'confirm_simulated_payment',
       'claim_outbox', 'finish_outbox')) loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_fn.signature);
    if v_fn.signature::text not like 'private.%' then
      execute format('grant execute on function %s to service_role', v_fn.signature);
    end if;
  end loop;
end;
$$;
grant usage on schema private to authenticated;
grant execute on function private.can_read_application(uuid), private.is_operator(uuid) to authenticated;
grant execute on function public.account_balances(uuid) to authenticated;

comment on table public.journal_entries is 'SIMULATED ESCROW ONLY. Append-only journals; no live funds or yield.';
comment on table public.postings is 'Positive integer minor units. Each journal balances within one case and currency.';
comment on table public.audit_events is 'Append-only application audit history. Database administrators remain trusted.';
comment on table public.outbox_events is 'Immutable dispatch intent, atomically created with audit event.';
comment on table public.outbox_delivery is 'Mutable worker lease/retry status; never a source of audit truth.';
commit;

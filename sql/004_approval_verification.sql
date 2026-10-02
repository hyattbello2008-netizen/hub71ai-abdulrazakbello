-- Disposable Supabase DB only, after Phase 1 and 003_approval_authority.sql.
begin;
create temporary table fixture(key text primary key,value uuid);
grant select,insert on fixture to service_role;
grant select on fixture to authenticated;
create function pg_temp.assert_true(p_ok boolean,p_label text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'ASSERTION FAILED: %',p_label; end if; end $$;
create function pg_temp.expect_error(p_sql text,p_state text) returns void language plpgsql as $$
declare failed boolean := false; code text;
begin
  begin execute p_sql;
  exception when others then
    get stacked diagnostics code = returned_sqlstate;
    if code <> p_state then raise exception 'Expected %, got %: %',p_state,code,sqlerrm; end if;
    failed := true;
  end;
  if not failed then raise exception 'Expected error: %',p_sql; end if;
end $$;

insert into auth.users(id,email) values
  ('11111111-1111-1111-1111-111111111111','phase2-applicant@example.invalid'),
  ('22222222-2222-2222-2222-222222222222','phase2-other@example.invalid'),
  ('33333333-3333-3333-3333-333333333333','phase2-approver@example.invalid');
insert into public.organizations(id,name) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Phase2 Institution');
insert into public.organization_memberships(organization_id,user_id,role)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','33333333-3333-3333-3333-333333333333','approver');
set local role service_role;
insert into fixture values ('app',public.create_pilot_application(
  '11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'));
insert into fixture select 'tranche',public.add_pilot_tranche(value,'pilot_complete','sim-vendor',10000) from fixture where key='app';
insert into fixture select 'fund',public.request_simulated_funding(value) from fixture where key='app';
select public.confirm_simulated_payment(value,'fund-phase2',repeat('a',64),'payment-key',now(),'FUND','AED',10000)
  from fixture where key='fund';
select pg_temp.expect_error(format('select public.confirm_simulated_government_approval(%L,''early'',%L,''approval-key'',now())',
  (select value from fixture where key='app'),repeat('b',64)),'P0001');
insert into fixture select 'doc',public.add_pilot_document(value,'qualification',value::text||'/qualification.pdf',repeat('c',64))
  from fixture where key='app';
select public.record_document_scan(value,true) from fixture where key='doc';
select public.record_pilot_extraction((select value from fixture where key='app'),gen_random_uuid(),
  'test','schema-v1','{"persona":"healthcare"}',99,99,false,'rules-v1',
  jsonb_build_array(jsonb_build_object('document_id',(select value from fixture where key='doc'),
    'field_path','qualification','page_number',1,'source_excerpt','Synthetic source')));
select public.route_pilot_application(value) from fixture where key='app';
select pg_temp.expect_error(format('select public.request_simulated_tranche_payment(%L,%L,''RELEASE'',''Reviewed milestone evidence'')',
  (select value from fixture where key='tranche'),'33333333-3333-3333-3333-333333333333'),'P0001');
select pg_temp.assert_true((select status='PENDING' from public.application_tranches
  where id=(select value from fixture where key='tranche')),'Failed release request rolls back tranche approval');
insert into fixture select 'receipt',public.confirm_simulated_government_approval(value,'approve-phase2',repeat('b',64),'approval-key',now())
  from fixture where key='app';
select pg_temp.assert_true((select simulated_approval_status='APPROVED' and status='ROUTED' from public.applications
  where id=(select value from fixture where key='app')),'Separate approval state recorded');
select pg_temp.assert_true((select count(*)=1 from public.journal_entries),'Approval does not post a payment');
select pg_temp.assert_true((select count(*)=2 from public.postings),'Approval does not add postings');
select pg_temp.assert_true((select balance_minor=10000 from public.account_balances(
  (select value from fixture where key='app')) where code='APPLICANT_ESCROW'),'Approval does not move balance');
select pg_temp.assert_true((select count(*)=1 from public.audit_events where event_type='application.simulated_approval_confirmed'),'Approval audited once');
select pg_temp.assert_true((select count(*)=1 from public.outbox_events where topic='application.simulated_approval_confirmed'),'Approval outbox atomic');
select pg_temp.expect_error(format('select public.confirm_simulated_government_approval(%L,''approve-phase2'',%L,''approval-key'',now())',
  (select value from fixture where key='app'),repeat('b',64)),'23505');
select pg_temp.expect_error(format('select public.confirm_simulated_government_approval(%L,''new-id-same-case'',%L,''approval-key'',now())',
  (select value from fixture where key='app'),repeat('d',64)),'23505');
insert into fixture select 'release',public.request_simulated_tranche_payment(value,
  '33333333-3333-3333-3333-333333333333','RELEASE','Confirmed milestone evidence') from fixture where key='tranche';
select pg_temp.assert_true((select count(*)=1 from public.journal_entries),'Release request still does not settle');
select public.confirm_simulated_payment(value,'release-phase2',repeat('e',64),'payment-key',now(),'RELEASE','AED',10000)
  from fixture where key='release';
set constraints all immediate;
select pg_temp.assert_true((select status='COMPLETED' from public.applications
  where id=(select value from fixture where key='app')),'Independent provider confirmation completes journey');
select pg_temp.expect_error('delete from public.government_approval_receipts','42501');
set local role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',true);
select pg_temp.assert_true((select count(*)=1 from public.government_approval_receipts),'Applicant reads own approval');
select pg_temp.expect_error(format('select public.confirm_simulated_government_approval(%L,''forged'',%L,''key'',now())',
  (select value from fixture where key='app'),repeat('f',64)),'42501');
select set_config('request.jwt.claim.sub','22222222-2222-2222-2222-222222222222',true);
select pg_temp.assert_true((select count(*)=0 from public.government_approval_receipts),'Other applicant cannot read receipt');
reset role;
select pg_temp.expect_error('update public.government_approval_receipts set event_id=''edited''','42501');
select pg_temp.expect_error('truncate public.government_approval_receipts','42501');
select 'PASS: Phase 2 approval SQL assertions' as verification_result;
rollback;

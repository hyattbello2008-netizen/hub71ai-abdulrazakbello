-- Run after 001_foundation.sql as the same migration owner in a DISPOSABLE database.
-- All fixtures roll back. Assertions raise exceptions on failure.
begin;
create temporary table fixture(key text primary key, value uuid);
grant select on fixture to anon, authenticated, service_role;
grant insert on fixture to service_role;
create function pg_temp.assert_true(p_ok boolean, p_message text) returns void
language plpgsql as $$ begin
  if p_ok is distinct from true then raise exception 'ASSERTION FAILED: %', p_message; end if;
end $$;
create function pg_temp.expect_error(p_sql text, p_state text) returns void
language plpgsql as $$
declare v_failed boolean := false; v_state text;
begin
  begin execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> p_state then raise exception 'Expected SQLSTATE %, got %: %', p_state, v_state, sqlerrm; end if;
    v_failed := true;
  end;
  if not v_failed then raise exception 'Expected statement to fail: %', p_sql; end if;
end $$;

insert into auth.users(id, email) values
  ('11111111-1111-1111-1111-111111111111', 'falcon-applicant-a@example.invalid'),
  ('22222222-2222-2222-2222-222222222222', 'falcon-applicant-b@example.invalid'),
  ('33333333-3333-3333-3333-333333333333', 'falcon-approver@example.invalid'),
  ('44444444-4444-4444-4444-444444444444', 'falcon-reviewer@example.invalid');
insert into public.organizations(id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Pilot Institution A'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Pilot Institution B');
insert into public.organization_memberships(organization_id, user_id, role) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333', 'approver'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '44444444-4444-4444-4444-444444444444', 'reviewer');

set local role service_role;
insert into fixture values ('app_a', public.create_pilot_application(
  '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'));
insert into fixture values ('app_b', public.create_pilot_application(
  '22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'));
insert into fixture select 'tranche_a', public.add_pilot_tranche(value, 'credential_review', 'simulated-provider', 750000)
  from fixture where key = 'app_a';
insert into fixture select 'tranche_b', public.add_pilot_tranche(value, 'relocation_complete', 'simulated-vendor', 4250000)
  from fixture where key = 'app_a';
insert into fixture select 'fund_a', public.request_simulated_funding(value) from fixture where key = 'app_a';
-- Funding REQUEST does not create a balance.
select pg_temp.assert_true((select balance_minor = 0 from public.account_balances(
  (select value from fixture where key = 'app_a')) where code = 'APPLICANT_ESCROW'), 'Unconfirmed funds must not enter ledger');
select pg_temp.expect_error(format('select public.add_pilot_tranche(%L, ''late'', ''vendor'', 1)',
  (select value from fixture where key = 'app_a')), 'P0001');
select pg_temp.expect_error(format('select public.confirm_simulated_payment(%L, ''fund-a'', %L, ''key-v1'', now(), ''FUND'', ''AED'', 1)',
  (select value from fixture where key = 'fund_a'), repeat('a',64)), 'P0001');
select pg_temp.assert_true((select count(*) = 0 from public.webhook_receipts), 'Bad confirmation must roll back receipt');
insert into fixture select 'journal_fund', public.confirm_simulated_payment(value, 'fund-a', repeat('a',64), 'key-v1', now(), 'FUND', 'AED', 5000000)
  from fixture where key = 'fund_a';
set constraints all immediate;
set constraints all deferred;
select pg_temp.assert_true((select balance_minor = 5000000 from public.account_balances(
  (select value from fixture where key = 'app_a')) where code = 'APPLICANT_ESCROW'), 'Confirmed funding balance');
select pg_temp.expect_error(format('select public.confirm_simulated_payment(%L, ''fund-a-replay'', %L, ''key-v1'', now(), ''FUND'', ''AED'', 5000000)',
  (select value from fixture where key = 'fund_a'), repeat('a',64)), '23505');

-- Clean cited evidence; score of exactly 98 is NOT above the threshold.
insert into fixture select 'document_a', public.add_pilot_document(value, 'passport', value::text || '/passport.pdf', repeat('b',64))
  from fixture where key = 'app_a';
select public.record_document_scan(value, true) from fixture where key = 'document_a';
select public.record_pilot_extraction((select value from fixture where key='app_a'), gen_random_uuid(),
  'test-extractor', 'healthcare-v1', '{"persona":"healthcare"}', 100, 98, false, 'readiness-v1',
  jsonb_build_array(jsonb_build_object('document_id', (select value from fixture where key='document_a'),
    'field_path', 'identity.name', 'page_number', 1, 'source_excerpt', 'Synthetic Applicant')));
select pg_temp.assert_true((select status = 'EXCEPTION' from public.applications
  where id = (select value from fixture where key='app_a')), 'LLM 100 must not override validated 98');
select pg_temp.expect_error(format('select public.route_pilot_application(%L)',
  (select value from fixture where key='app_a')), 'P0001');
select public.record_pilot_extraction((select value from fixture where key='app_a'), gen_random_uuid(),
  'test-extractor', 'healthcare-v1', '{"persona":"healthcare"}', 100, 99, true, 'readiness-v1',
  jsonb_build_array(jsonb_build_object('document_id', (select value from fixture where key='document_a'),
    'field_path', 'identity.name', 'page_number', 1, 'source_excerpt', 'Synthetic Applicant')));
select pg_temp.assert_true((select status = 'EXCEPTION' from public.applications
  where id = (select value from fixture where key='app_a')), 'Conflicting 99 must enter exception queue');
select public.record_pilot_extraction((select value from fixture where key='app_a'), gen_random_uuid(),
  'test-extractor', 'healthcare-v1', '{"persona":"engineer"}', 100, 99, false, 'readiness-v1',
  jsonb_build_array(jsonb_build_object('document_id', (select value from fixture where key='document_a'),
    'field_path', 'identity.name', 'page_number', 1, 'source_excerpt', 'Synthetic Applicant')));
select pg_temp.assert_true((select status = 'EXCEPTION' and review_reason_code = 'PERSONA_MISMATCH'
  from public.applications where id = (select value from fixture where key='app_a')),
  'Non-healthcare persona cannot auto-route despite 99 score');
select pg_temp.expect_error(format('select public.review_pilot_application(%L, %L, ''OVERRIDE_READY'', ''Reviewed all evidence'')',
  (select value from fixture where key='app_a'), '44444444-4444-4444-4444-444444444444'), '42501');
select public.review_pilot_application(value, '33333333-3333-3333-3333-333333333333', 'OVERRIDE_READY', 'Reviewed all cited evidence')
  from fixture where key='app_a';
select public.route_pilot_application(value) from fixture where key='app_a';
insert into fixture select 'release_a', public.request_simulated_tranche_payment(value,
  '33333333-3333-3333-3333-333333333333', 'RELEASE', 'Milestone evidence reviewed') from fixture where key='tranche_a';
select pg_temp.assert_true((select status = 'APPROVED' from public.application_tranches
  where id = (select value from fixture where key='tranche_a')), 'Approval is not payment confirmation');
select pg_temp.assert_true((select balance_minor = 5000000 from public.account_balances(
  (select value from fixture where key = 'app_a')) where code = 'APPLICANT_ESCROW'), 'Release request does not change balance');
select public.confirm_simulated_payment(value, 'release-a', repeat('c',64), 'key-v1', now(), 'RELEASE', 'AED', 750000)
  from fixture where key='release_a';
select public.review_pilot_application(value, '33333333-3333-3333-3333-333333333333', 'REJECT', 'Remaining application rejected')
  from fixture where key='app_a';
insert into fixture select 'refund_b', public.request_simulated_tranche_payment(value,
  '33333333-3333-3333-3333-333333333333', 'REFUND', 'Refund remaining funded tranche') from fixture where key='tranche_b';
select pg_temp.expect_error(format('select public.request_simulated_tranche_payment(%L, %L, ''REFUND'', ''Cannot refund released tranche'')',
  (select value from fixture where key='tranche_a'), '33333333-3333-3333-3333-333333333333'), 'P0001');
select pg_temp.expect_error(format('select public.confirm_simulated_payment(%L, ''fund-a'', %L, ''key-v1'', now(), ''REFUND'', ''AED'', 4250000)',
  (select value from fixture where key='refund_b'), repeat('d',64)), '23505');
select public.confirm_simulated_payment(value, 'refund-b', repeat('d',64), 'key-v1', now(), 'REFUND', 'AED', 4250000)
  from fixture where key='refund_b';
set constraints all immediate;
set constraints all deferred;
select pg_temp.assert_true((select bool_and(balance_minor = 0) from public.account_balances(
  (select value from fixture where key='app_a'))), 'Release + refund exhaust both accounts');
select pg_temp.assert_true((select count(*) = 3 from public.journal_entries), 'Only three confirmed journals');
select pg_temp.assert_true((select count(*) = 6 from public.postings), 'Exactly two postings per operation');
select pg_temp.assert_true((select count(*) from public.audit_events) = (select count(*) from public.outbox_events), 'Every audit event has outbox intent');
select pg_temp.expect_error('update public.postings set amount_minor = 1', '42501');
select pg_temp.expect_error('delete from public.journal_entries', '42501');
select pg_temp.expect_error('truncate public.audit_events cascade', '42501');

-- Owner-only adversarial integrity checks, independent of service grants.
reset role;
grant insert on fixture to service_role;
select pg_temp.expect_error('update public.postings set amount_minor = 1', '42501');
select pg_temp.expect_error('delete from public.audit_events', '42501');
select pg_temp.expect_error('truncate public.journal_entries cascade', '42501');
insert into fixture select 'receipt_empty', id from public.webhook_receipts where event_id='fund-a';
-- Reuse receipt intentionally: uniqueness must reject duplicate provenance.
select pg_temp.expect_error(format('insert into public.journal_entries(application_id,currency,payment_operation_id,receipt_id,kind,description)
  values (%L,''AED'',%L,%L,''FUND'',''Duplicate'')',
  (select value from fixture where key='app_a'), (select value from fixture where key='fund_a'),
  (select value from fixture where key='receipt_empty')), '23505');

-- Isolated unused operation for empty/unbalanced/cross-case tests.
insert into fixture select 'tranche_other', public.add_pilot_tranche(value, 'other', 'vendor', 100) from fixture where key='app_b';
insert into fixture select 'fund_other', public.request_simulated_funding(value) from fixture where key='app_b';
insert into public.webhook_receipts(provider,event_id,operation_id,body_sha256,signature_key_id,provider_occurred_at)
  select 'falcon_simulator','test-integrity',value,repeat('e',64),'test-key',now() from fixture where key='fund_other';
insert into fixture select 'receipt_other',id from public.webhook_receipts where event_id='test-integrity';
select pg_temp.expect_error(format('insert into public.journal_entries(application_id,currency,payment_operation_id,receipt_id,kind,description)
  values (%L,''AED'',%L,%L,''FUND'',''Empty''); set constraints all immediate',
  (select value from fixture where key='app_b'), (select value from fixture where key='fund_other'),
  (select value from fixture where key='receipt_other')), 'P0001');
insert into fixture select 'integrity_journal', gen_random_uuid();
select pg_temp.expect_error(format('insert into public.journal_entries(id,application_id,currency,payment_operation_id,receipt_id,kind,description)
  values (%L,%L,''AED'',%L,%L,''FUND'',''Unbalanced'');
  insert into public.postings(journal_entry_id,application_id,account_id,currency,side,amount_minor)
  select %L,%L,id,''AED'',''debit'',100 from public.accounts where application_id=%L and code=''SIMULATED_CUSTODY'';
  insert into public.postings(journal_entry_id,application_id,account_id,currency,side,amount_minor)
  select %L,%L,id,''AED'',''credit'',99 from public.accounts where application_id=%L and code=''APPLICANT_ESCROW'';
  set constraints all immediate',
  (select value from fixture where key='integrity_journal'), (select value from fixture where key='app_b'),
  (select value from fixture where key='fund_other'), (select value from fixture where key='receipt_other'),
  (select value from fixture where key='integrity_journal'), (select value from fixture where key='app_b'),
  (select value from fixture where key='app_b'),
  (select value from fixture where key='integrity_journal'), (select value from fixture where key='app_b'),
  (select value from fixture where key='app_b')), 'P0001');
select pg_temp.expect_error(format('insert into public.postings(journal_entry_id,application_id,account_id,currency,side,amount_minor)
  select %L,%L,id,''AED'',''debit'',1 from public.accounts where application_id=%L and code=''SIMULATED_CUSTODY''',
  (select value from fixture where key='journal_fund'), (select value from fixture where key='app_a'),
  (select value from fixture where key='app_b')), '23503');

-- Normal deterministic readiness path, independent of the manual override path.
set local role service_role;
insert into fixture select 'document_b', public.add_pilot_document(value, 'qualification', value::text || '/qualification.pdf', repeat('9',64))
  from fixture where key='app_b';
select public.record_document_scan(value, true) from fixture where key='document_b';
select public.record_pilot_extraction((select value from fixture where key='app_b'), gen_random_uuid(),
  'test-extractor', 'healthcare-v1', '{"persona":"healthcare"}', 100, 99, false, 'readiness-v1',
  jsonb_build_array(jsonb_build_object('document_id', (select value from fixture where key='document_b'),
    'field_path', 'qualification.title', 'page_number', 1, 'source_excerpt', 'Synthetic Qualification')));
select pg_temp.assert_true((select status = 'READY' from public.applications
  where id = (select value from fixture where key='app_b')), 'Validated healthcare 99 is ready');
select public.route_pilot_application(value) from fixture where key='app_b';
select pg_temp.assert_true((select status = 'ROUTED' and destination_code = 'doh_simulator'
  from public.applications where id = (select value from fixture where key='app_b')), 'Deterministic simulator route');
reset role;

-- Applicant isolation and mutation denial.
set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
select pg_temp.assert_true((select count(*) = 1 from public.applications), 'Applicant sees own case only');
select pg_temp.assert_true((select count(*) = 0 from public.accounts where application_id =
  (select value from fixture where key='app_b')), 'Applicant cannot read other ledger');
select pg_temp.assert_true((select count(*) = 0 from public.audit_events), 'Applicant cannot see internal audit');
select pg_temp.assert_true((select count(*) = 0 from public.account_balances(
  (select value from fixture where key='app_b'))), 'Balance function preserves RLS');
select pg_temp.expect_error('update public.applications set status=''READY''', '42501');
select pg_temp.expect_error('delete from public.postings', '42501');
select pg_temp.expect_error(format('select public.request_simulated_funding(%L)',
  (select value from fixture where key='app_a')), '42501');
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
select pg_temp.assert_true((select count(*) = 1 from public.applications), 'Staff sees institution A only');
select pg_temp.assert_true((select count(*) > 0 from public.audit_events), 'Scoped staff sees audit');
select pg_temp.assert_true((select count(*) = 0 from public.applications where id =
  (select value from fixture where key='app_b')), 'Staff cannot see institution B');
set local role anon;
select pg_temp.expect_error('select * from public.applications', '42501');

-- Outbox lease fencing: a wrong token may not acknowledge delivery.
reset role;
set local role service_role;
create temporary table claimed as select * from public.claim_outbox(2);
select pg_temp.assert_true((select count(*) = 2 from claimed), 'Worker claims bounded batch');
select pg_temp.expect_error(format('select public.finish_outbox(%L,%L,true)',
  (select event_id from claimed limit 1), gen_random_uuid()), 'P0001');
select public.finish_outbox(event_id,lease_token,true) from claimed;
select pg_temp.assert_true((select count(*) = 2 from public.outbox_delivery where delivered_at is not null), 'Acknowledged delivery');
reset role;
select 'PASS: healthcare pilot SQL assertions' as verification_result;
rollback;

-- Rollback-only checks; run after 005 as migration owner in a disposable database.
begin;
insert into auth.users(id) values
 ('10000000-0000-4000-8000-000000000001'),('10000000-0000-4000-8000-000000000002'),
 ('10000000-0000-4000-8000-000000000003'),('10000000-0000-4000-8000-000000000004');
insert into public.organizations(id,name) values('20000000-0000-4000-8000-000000000001','Rollback test institution');
insert into public.organization_memberships(organization_id,user_id,role) values
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000003','approver'),
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000004','reviewer');
create temporary table test_refs(app uuid,upload uuid,lease uuid,doc uuid,op uuid);
do $$ declare v_app uuid;v_upload uuid;v_lease uuid;v_doc uuid;v_run uuid;v_op record;begin
  v_app:=public.start_pilot_application('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','Test Applicant');
  if public.start_pilot_application('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','Other')<>v_app then raise exception 'Duplicate start created case';end if;
  if exists(select 1 from public.account_balances_text(v_app) where balance_minor<>'0')then raise exception 'New case balance nonzero';end if;
  v_upload:=public.prepare_document_upload(v_app,'10000000-0000-4000-8000-000000000001','other','text/plain',12);
  perform set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
  if not private.can_upload_evidence((select object_key from public.document_uploads where id=v_upload))then raise exception 'Authorized storage insert denied';end if;
  perform set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',true);
  if private.can_upload_evidence((select object_key from public.document_uploads where id=v_upload))then raise exception 'Cross-user storage authorization allowed';end if;
  perform set_config('request.jwt.claim.sub','',true);
  begin perform public.claim_document_ingestion(v_upload,'10000000-0000-4000-8000-000000000002');raise exception 'Cross-user claim permitted';exception when insufficient_privilege then null;end;
  v_lease:=public.claim_document_ingestion(v_upload,'10000000-0000-4000-8000-000000000001');
  begin perform public.set_ingestion_stage(v_upload,'10000000-0000-4000-8000-000000000001',gen_random_uuid(),'EXTRACTING');raise exception 'Stale lease permitted';exception when raise_exception then if sqlerrm='Stale lease permitted'then raise;end if;end;
  v_doc:=public.register_scanned_document(v_upload,'10000000-0000-4000-8000-000000000001',v_lease,repeat('a',64));
  v_run:=public.complete_document_ingestion(v_upload,'10000000-0000-4000-8000-000000000001',v_lease,'test','{"persona":"healthcare"}',100,85,false,jsonb_build_array(jsonb_build_object('document_id',v_doc,'field_path','passport_name','page_number',1,'source_excerpt','Full Name: Test Applicant')));
  if(select status from public.applications where id=v_app)<>'EXCEPTION'then raise exception 'Incomplete evidence not queued';end if;
  begin perform public.claim_document_ingestion(v_upload,'10000000-0000-4000-8000-000000000001');raise exception 'Completed upload replay permitted';exception when unique_violation then null;end;
  begin perform public.advance_pilot_application(v_app,'10000000-0000-4000-8000-000000000004','Reviewed source evidence');raise exception 'Reviewer override permitted';exception when insufficient_privilege then null;end;
  perform public.advance_pilot_application(v_app,'10000000-0000-4000-8000-000000000003','Reviewed source evidence and approved pilot override');
  if(select status from public.applications where id=v_app)<>'ROUTED'then raise exception 'Case not routed';end if;
  select * into v_op from public.prepare_operator_simulated_funding(v_app,'10000000-0000-4000-8000-000000000003');
  if v_op.amount_minor<>'5000000' or v_op.status<>'REQUESTED'then raise exception 'Unexpected demo plan';end if;
  if exists(select 1 from public.journal_entries where application_id=v_app)then raise exception 'Preparing lock posted money';end if;
  perform public.confirm_simulated_payment(v_op.operation_id,'frontend-test-confirm',repeat('b',64),'test-key',now(),'FUND','AED',5000000);
  if(select balance_minor from public.account_balances_text(v_app)where code='APPLICANT_ESCROW')<>'5000000'then raise exception 'Confirmed balance incorrect';end if;
  insert into test_refs values(v_app,v_upload,v_lease,v_doc,v_op.operation_id);
end $$;
grant select on test_refs to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
do $$ begin
  if(select count(*)from public.applicant_profiles)<>1 then raise exception 'Profile read isolation failed';end if;
  if(select count(*)from public.applications)<>1 then raise exception 'Applicant case read failed';end if;
  if(select count(*)from public.document_uploads)<>1 then raise exception 'Upload read failed';end if;
  if exists(select 1 from public.current_operator_memberships())then raise exception 'Applicant operator escalation';end if;
  begin perform lease_token from public.document_uploads;raise exception 'Lease token exposed';exception when insufficient_privilege then null;end;
  begin perform public.start_pilot_application('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','Bad');raise exception 'Authenticated command allowed';exception when insufficient_privilege then null;end;
end $$;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',true);
do $$ begin
  if exists(select 1 from public.applications)or exists(select id from public.document_uploads)then raise exception 'Cross-user data exposed';end if;
  if exists(select 1 from public.account_balances_text((select app from test_refs)))then raise exception 'Cross-user balance exposed';end if;
  if private.can_upload_evidence((select object_key from public.document_uploads limit 1))then raise exception 'Cross-user upload allowed';end if;
end $$;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000003',true);
do $$ begin
  if(select count(*)from public.current_operator_memberships())<>1 then raise exception 'Membership lookup failed';end if;
  if(select count(*)from public.applications)<>1 then raise exception 'Scoped operator read failed';end if;
end $$;
reset role;
select 'PASS: frontend authority, fenced ingestion, RLS, operator review and confirmed-only ledger' as verification_result;
rollback;

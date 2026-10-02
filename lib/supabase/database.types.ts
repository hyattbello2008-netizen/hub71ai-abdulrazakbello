/** Hand-curated RPC/read contract for 001_foundation.sql and the separate approval extension.
 * Bigint money is intentionally represented as a decimal string at the JSON boundary.
 * Regenerate the remaining schema types from the target Supabase instance when integrated.
 */
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];
type ReadOnlyTable<Row> = {
  Row: Row;
  Insert: never;
  Update: never;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
      evidence_citations: ReadOnlyTable<{id:string;application_id:string;extraction_run_id:string;document_id:string;field_path:string;page_number:number;source_excerpt:string}>;
      applicant_profiles: ReadOnlyTable<{user_id:string;display_name:string;created_at:string}>;
      applications: ReadOnlyTable<{
        id:string;protocol_id:string;organization_id:string;applicant_id:string;status:string;
        currency:string;persona:string;validated_completeness:number|null;has_conflicts:boolean;
        review_reason_code:string|null;destination_code:string|null;simulated_approval_status:string;
        created_at:string;updated_at:string;
      }>;
      application_documents: ReadOnlyTable<{
        id:string;application_id:string;document_type:string;storage_bucket:string;storage_key:string;
        sha256:string;scan_status:string;uploaded_at:string;
      }>;
      extraction_runs: ReadOnlyTable<{
        id:string;application_id:string;extracted_data:Json;llm_completeness:number|null;
        validated_completeness:number;has_conflicts:boolean;created_at:string;
      }>;
      document_uploads: ReadOnlyTable<{
        id:string;application_id:string;applicant_id:string;object_key:string;document_type:string;
        mime_type:string;expected_bytes:number;status:string;stage:string;document_id:string|null;
        error_code:string|null;extraction_run_id:string|null;created_at:string;expires_at:string;
      }>;
      payment_operations: ReadOnlyTable<{
        id: string; application_id: string; kind: 'FUND' | 'RELEASE' | 'REFUND';
        currency: string; amount_minor: string; provider: string; status: string;
      }>;
      webhook_receipts: ReadOnlyTable<{
        id: string; provider: string; event_id: string; operation_id: string; body_sha256: string;
      }>;
      journal_entries: ReadOnlyTable<{
        id: string; payment_operation_id: string; application_id: string; currency: string;
      }>;
      government_approval_receipts: ReadOnlyTable<{
        id: string; provider: string; event_id: string; application_id: string; body_sha256: string;
      }>;
    };
    Views: Record<string, never>;
    Functions: {
      current_operator_memberships:{Args:Record<string,never>;Returns:{organization_id:string;role:string}[]};
      account_balances_text:{Args:{p_application_id:string};Returns:{account_id:string;code:string;currency:string;normal_side:string;balance_minor:string}[]};
      application_tranches_text:{Args:{p_application_id:string};Returns:{id:string;milestone_code:string;currency:string;amount_minor:string;status:string}[]};
      start_pilot_application:{Args:{p_actor:string;p_organization:string;p_display_name:string};Returns:string};
      prepare_document_upload:{Args:{p_application:string;p_actor:string;p_type:string;p_mime:string;p_bytes:number};Returns:string};
      claim_document_ingestion:{Args:{p_upload:string;p_actor:string};Returns:string};
      set_ingestion_stage:{Args:{p_upload:string;p_actor:string;p_lease:string;p_stage:string};Returns:undefined};
      register_scanned_document:{Args:{p_upload:string;p_actor:string;p_lease:string;p_sha256:string};Returns:string};
      complete_document_ingestion:{Args:{p_upload:string;p_actor:string;p_lease:string;p_model:string;p_data:Json;p_llm_score:number;
        p_validated_score:number;p_conflicts:boolean;p_citations:Json};Returns:string};
      fail_document_ingestion:{Args:{p_upload:string;p_actor:string;p_lease:string;p_error_code:string};Returns:undefined};
      advance_pilot_application:{Args:{p_application:string;p_actor:string;p_reason:string};Returns:undefined};
      prepare_operator_simulated_funding:{Args:{p_application:string;p_actor:string};Returns:{operation_id:string;application_id:string;currency:string;amount_minor:string;status:string;occurred_at:string}[]};
      application_audit_text:{Args:{p_application_id:string};Returns:{id:string;event_type:string;actor_kind:string;created_at:string}[]};
      confirm_simulated_payment: {
        Args: {
          p_operation: string; p_event_id: string; p_body_sha256: string; p_key_id: string;
          p_occurred_at: string; p_kind: string; p_currency: string; p_amount_minor: string;
        };
        Returns: string;
      };
      confirm_simulated_government_approval: {
        Args: {
          p_application: string; p_event_id: string; p_body_sha256: string;
          p_key_id: string; p_occurred_at: string;
        };
        Returns: string;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

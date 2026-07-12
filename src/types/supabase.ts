export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      activity_logs: {
        Row: {
          action: string
          actor_id: string | null
          application_id: string | null
          category: string | null
          client_id: string | null
          conversation_id: string | null
          created_at: string
          detail: Json | null
          entity_id: string | null
          entity_type: string
          id: string
          note: string | null
          project_id: string | null
          subject_id: string | null
          task_id: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          application_id?: string | null
          category?: string | null
          client_id?: string | null
          conversation_id?: string | null
          created_at?: string
          detail?: Json | null
          entity_id?: string | null
          entity_type: string
          id?: string
          note?: string | null
          project_id?: string | null
          subject_id?: string | null
          task_id?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          application_id?: string | null
          category?: string | null
          client_id?: string | null
          conversation_id?: string | null
          created_at?: string
          detail?: Json | null
          entity_id?: string | null
          entity_type?: string
          id?: string
          note?: string | null
          project_id?: string | null
          subject_id?: string | null
          task_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "activity_logs_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_logs_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "job_applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_logs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_logs_conversation_fk"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_logs_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "ad_projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_logs_subject_id_fkey"
            columns: ["subject_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_logs_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      ad_accounts: {
        Row: {
          account_id: string
          business_id: string | null
          client_id: string
          connection_id: string
          created_at: string
          currency: string | null
          id: string
          is_active: boolean
          name: string
          provider: string
          timezone: string | null
          updated_at: string
        }
        Insert: {
          account_id: string
          business_id?: string | null
          client_id: string
          connection_id: string
          created_at?: string
          currency?: string | null
          id?: string
          is_active?: boolean
          name: string
          provider: string
          timezone?: string | null
          updated_at?: string
        }
        Update: {
          account_id?: string
          business_id?: string | null
          client_id?: string
          connection_id?: string
          created_at?: string
          currency?: string | null
          id?: string
          is_active?: boolean
          name?: string
          provider?: string
          timezone?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ad_accounts_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "ad_businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ad_accounts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ad_accounts_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "provider_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      ad_assets: {
        Row: {
          age_range: string | null
          audience: string | null
          conversion_event: string | null
          created_at: string
          created_by: string | null
          cta: string | null
          description: string | null
          destination_url: string | null
          gender: string | null
          headline: string | null
          id: string
          kind: string
          languages: string | null
          location: string | null
          media_url: string | null
          pixel: string | null
          placement: string | null
          primary_text: string | null
          project_id: string
          updated_at: string
          utm: string | null
        }
        Insert: {
          age_range?: string | null
          audience?: string | null
          conversion_event?: string | null
          created_at?: string
          created_by?: string | null
          cta?: string | null
          description?: string | null
          destination_url?: string | null
          gender?: string | null
          headline?: string | null
          id?: string
          kind?: string
          languages?: string | null
          location?: string | null
          media_url?: string | null
          pixel?: string | null
          placement?: string | null
          primary_text?: string | null
          project_id: string
          updated_at?: string
          utm?: string | null
        }
        Update: {
          age_range?: string | null
          audience?: string | null
          conversion_event?: string | null
          created_at?: string
          created_by?: string | null
          cta?: string | null
          description?: string | null
          destination_url?: string | null
          gender?: string | null
          headline?: string | null
          id?: string
          kind?: string
          languages?: string | null
          location?: string | null
          media_url?: string | null
          pixel?: string | null
          placement?: string | null
          primary_text?: string | null
          project_id?: string
          updated_at?: string
          utm?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ad_assets_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ad_assets_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "ad_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      ad_attachments: {
        Row: {
          created_at: string
          file_name: string | null
          file_url: string
          id: string
          kind: string | null
          project_id: string
          uploaded_by: string | null
        }
        Insert: {
          created_at?: string
          file_name?: string | null
          file_url: string
          id?: string
          kind?: string | null
          project_id: string
          uploaded_by?: string | null
        }
        Update: {
          created_at?: string
          file_name?: string | null
          file_url?: string
          id?: string
          kind?: string | null
          project_id?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ad_attachments_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "ad_projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ad_attachments_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      ad_businesses: {
        Row: {
          business_id: string
          client_id: string
          connection_id: string
          created_at: string
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          business_id: string
          client_id: string
          connection_id: string
          created_at?: string
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          business_id?: string
          client_id?: string
          connection_id?: string
          created_at?: string
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ad_businesses_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ad_businesses_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "provider_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      ad_campaigns: {
        Row: {
          ad_account_id: string
          campaign_type: string | null
          client_id: string | null
          connection_id: string | null
          created_at: string
          external_campaign_id: string
          first_seen_at: string
          id: string
          last_seen_at: string
          last_synced_at: string | null
          mapping_status: string
          name: string
          objective: string | null
          project_id: string | null
          provider: string
          raw: Json | null
          status: string | null
          updated_at: string
        }
        Insert: {
          ad_account_id: string
          campaign_type?: string | null
          client_id?: string | null
          connection_id?: string | null
          created_at?: string
          external_campaign_id: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          last_synced_at?: string | null
          mapping_status?: string
          name: string
          objective?: string | null
          project_id?: string | null
          provider?: string
          raw?: Json | null
          status?: string | null
          updated_at?: string
        }
        Update: {
          ad_account_id?: string
          campaign_type?: string | null
          client_id?: string | null
          connection_id?: string | null
          created_at?: string
          external_campaign_id?: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          last_synced_at?: string | null
          mapping_status?: string
          name?: string
          objective?: string | null
          project_id?: string | null
          provider?: string
          raw?: Json | null
          status?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ad_campaigns_ad_account_id_fkey"
            columns: ["ad_account_id"]
            isOneToOne: false
            referencedRelation: "ad_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ad_campaigns_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ad_campaigns_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "provider_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ad_campaigns_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "ad_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      ad_daily_metrics: {
        Row: {
          ad_currency: string | null
          adds_to_cart: number | null
          approved_at: string | null
          approved_by: string | null
          base_currency: string | null
          billing_currency: string | null
          checkouts: number | null
          clicks: number | null
          conversions: number | null
          cpc: number | null
          cpm: number | null
          cpr: number | null
          created_at: string
          ctr: number | null
          currency: string
          entered_by: string | null
          exchange_rate_ad_to_base: number | null
          exchange_rate_ad_to_billing: number | null
          frequency: number | null
          id: string
          impressions: number | null
          landing_page_views: number | null
          leads: number | null
          messages: number | null
          metric_date: string
          notes: string | null
          project_id: string
          purchases: number | null
          reach: number | null
          remaining_budget: number | null
          result_cost: number | null
          revenue: number | null
          roas: number | null
          source: string
          spend: number | null
          status: string
          sync_state: string
          updated_at: string
          version: number
          video_views: number | null
        }
        Insert: {
          ad_currency?: string | null
          adds_to_cart?: number | null
          approved_at?: string | null
          approved_by?: string | null
          base_currency?: string | null
          billing_currency?: string | null
          checkouts?: number | null
          clicks?: number | null
          conversions?: number | null
          cpc?: number | null
          cpm?: number | null
          cpr?: number | null
          created_at?: string
          ctr?: number | null
          currency?: string
          entered_by?: string | null
          exchange_rate_ad_to_base?: number | null
          exchange_rate_ad_to_billing?: number | null
          frequency?: number | null
          id?: string
          impressions?: number | null
          landing_page_views?: number | null
          leads?: number | null
          messages?: number | null
          metric_date: string
          notes?: string | null
          project_id: string
          purchases?: number | null
          reach?: number | null
          remaining_budget?: number | null
          result_cost?: number | null
          revenue?: number | null
          roas?: number | null
          source?: string
          spend?: number | null
          status?: string
          sync_state?: string
          updated_at?: string
          version?: number
          video_views?: number | null
        }
        Update: {
          ad_currency?: string | null
          adds_to_cart?: number | null
          approved_at?: string | null
          approved_by?: string | null
          base_currency?: string | null
          billing_currency?: string | null
          checkouts?: number | null
          clicks?: number | null
          conversions?: number | null
          cpc?: number | null
          cpm?: number | null
          cpr?: number | null
          created_at?: string
          ctr?: number | null
          currency?: string
          entered_by?: string | null
          exchange_rate_ad_to_base?: number | null
          exchange_rate_ad_to_billing?: number | null
          frequency?: number | null
          id?: string
          impressions?: number | null
          landing_page_views?: number | null
          leads?: number | null
          messages?: number | null
          metric_date?: string
          notes?: string | null
          project_id?: string
          purchases?: number | null
          reach?: number | null
          remaining_budget?: number | null
          result_cost?: number | null
          revenue?: number | null
          roas?: number | null
          source?: string
          spend?: number | null
          status?: string
          sync_state?: string
          updated_at?: string
          version?: number
          video_views?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "ad_daily_metrics_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ad_daily_metrics_entered_by_fkey"
            columns: ["entered_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ad_daily_metrics_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "ad_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      ad_events: {
        Row: {
          actor_id: string | null
          created_at: string
          detail: Json | null
          event_type: string
          id: string
          project_id: string
        }
        Insert: {
          actor_id?: string | null
          created_at?: string
          detail?: Json | null
          event_type: string
          id?: string
          project_id: string
        }
        Update: {
          actor_id?: string | null
          created_at?: string
          detail?: Json | null
          event_type?: string
          id?: string
          project_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ad_events_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ad_events_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "ad_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      ad_fund_allocations: {
        Row: {
          ad_project_id: string
          amount: number
          amount_inr: number
          cashbook_entry_id: string
          created_at: string
          created_by: string | null
          deleted_at: string | null
          id: string
          notes: string | null
          updated_at: string
        }
        Insert: {
          ad_project_id: string
          amount: number
          amount_inr?: number
          cashbook_entry_id: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          notes?: string | null
          updated_at?: string
        }
        Update: {
          ad_project_id?: string
          amount?: number
          amount_inr?: number
          cashbook_entry_id?: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          notes?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ad_fund_allocations_ad_project_id_fkey"
            columns: ["ad_project_id"]
            isOneToOne: false
            referencedRelation: "ad_projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ad_fund_allocations_cashbook_entry_id_fkey"
            columns: ["cashbook_entry_id"]
            isOneToOne: false
            referencedRelation: "cashbook_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ad_fund_allocations_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      ad_notes: {
        Row: {
          author_id: string | null
          body: string
          created_at: string
          id: string
          project_id: string
        }
        Insert: {
          author_id?: string | null
          body: string
          created_at?: string
          id?: string
          project_id: string
        }
        Update: {
          author_id?: string | null
          body?: string
          created_at?: string
          id?: string
          project_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ad_notes_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ad_notes_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "ad_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      ad_project_tasks: {
        Row: {
          created_at: string
          project_id: string
          task_id: string
        }
        Insert: {
          created_at?: string
          project_id: string
          task_id: string
        }
        Update: {
          created_at?: string
          project_id?: string
          task_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ad_project_tasks_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "ad_projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ad_project_tasks_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      ad_projects: {
        Row: {
          ad_account_id: string | null
          ad_budget_amount: number
          ad_budget_currency: string
          budget_days: number | null
          budget_input_mode: string
          campaign_name: string
          campaign_type: string | null
          client_id: string | null
          created_at: string
          created_by: string | null
          daily_budget: number | null
          deleted_at: string | null
          end_date: string | null
          external_campaign_id: string | null
          id: string
          last_sync_at: string | null
          last_sync_error: string | null
          notes: string | null
          objective: string | null
          optimization_goal: string | null
          platform: string
          provider_metadata: Json | null
          request_id: string | null
          service_charge_type: string
          service_charge_value: number
          service_id: string | null
          start_date: string | null
          status: string
          sync_enabled: boolean
          sync_status: string
          tax_percent: number
          tracking_config: Json | null
          updated_at: string
        }
        Insert: {
          ad_account_id?: string | null
          ad_budget_amount?: number
          ad_budget_currency?: string
          budget_days?: number | null
          budget_input_mode?: string
          campaign_name: string
          campaign_type?: string | null
          client_id?: string | null
          created_at?: string
          created_by?: string | null
          daily_budget?: number | null
          deleted_at?: string | null
          end_date?: string | null
          external_campaign_id?: string | null
          id?: string
          last_sync_at?: string | null
          last_sync_error?: string | null
          notes?: string | null
          objective?: string | null
          optimization_goal?: string | null
          platform?: string
          provider_metadata?: Json | null
          request_id?: string | null
          service_charge_type?: string
          service_charge_value?: number
          service_id?: string | null
          start_date?: string | null
          status?: string
          sync_enabled?: boolean
          sync_status?: string
          tax_percent?: number
          tracking_config?: Json | null
          updated_at?: string
        }
        Update: {
          ad_account_id?: string | null
          ad_budget_amount?: number
          ad_budget_currency?: string
          budget_days?: number | null
          budget_input_mode?: string
          campaign_name?: string
          campaign_type?: string | null
          client_id?: string | null
          created_at?: string
          created_by?: string | null
          daily_budget?: number | null
          deleted_at?: string | null
          end_date?: string | null
          external_campaign_id?: string | null
          id?: string
          last_sync_at?: string | null
          last_sync_error?: string | null
          notes?: string | null
          objective?: string | null
          optimization_goal?: string | null
          platform?: string
          provider_metadata?: Json | null
          request_id?: string | null
          service_charge_type?: string
          service_charge_value?: number
          service_id?: string | null
          start_date?: string | null
          status?: string
          sync_enabled?: boolean
          sync_status?: string
          tax_percent?: number
          tracking_config?: Json | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ad_projects_ad_account_id_fkey"
            columns: ["ad_account_id"]
            isOneToOne: false
            referencedRelation: "ad_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ad_projects_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ad_projects_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ad_projects_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "task_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ad_projects_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      ad_report_analytics: {
        Row: {
          event: string
          format: string | null
          id: string
          metadata: Json
          occurred_at: string
          recipient_email: string | null
          report_id: string
          user_id: string | null
        }
        Insert: {
          event: string
          format?: string | null
          id?: string
          metadata?: Json
          occurred_at?: string
          recipient_email?: string | null
          report_id: string
          user_id?: string | null
        }
        Update: {
          event?: string
          format?: string | null
          id?: string
          metadata?: Json
          occurred_at?: string
          recipient_email?: string | null
          report_id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ad_report_analytics_report_id_fkey"
            columns: ["report_id"]
            isOneToOne: false
            referencedRelation: "ad_reports"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ad_report_analytics_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      ad_report_schedules: {
        Row: {
          client_id: string
          created_at: string
          created_by: string | null
          cron_expression: string | null
          delivery_hour: number
          delivery_timezone: string
          formats: Json
          frequency: string
          id: string
          include_comparison: boolean
          is_active: boolean
          last_run_at: string | null
          next_run_at: string | null
          project_id: string
          recipients: Json
          report_type: string
          template: string
          updated_at: string
        }
        Insert: {
          client_id: string
          created_at?: string
          created_by?: string | null
          cron_expression?: string | null
          delivery_hour?: number
          delivery_timezone?: string
          formats?: Json
          frequency?: string
          id?: string
          include_comparison?: boolean
          is_active?: boolean
          last_run_at?: string | null
          next_run_at?: string | null
          project_id: string
          recipients?: Json
          report_type?: string
          template?: string
          updated_at?: string
        }
        Update: {
          client_id?: string
          created_at?: string
          created_by?: string | null
          cron_expression?: string | null
          delivery_hour?: number
          delivery_timezone?: string
          formats?: Json
          frequency?: string
          id?: string
          include_comparison?: boolean
          is_active?: boolean
          last_run_at?: string | null
          next_run_at?: string | null
          project_id?: string
          recipients?: Json
          report_type?: string
          template?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ad_report_schedules_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ad_report_schedules_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ad_report_schedules_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "ad_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      ad_reports: {
        Row: {
          ai_narrative: Json | null
          client_id: string
          comparison_from: string | null
          comparison_to: string | null
          created_at: string
          csv_url: string | null
          date_from: string
          date_to: string
          error_message: string | null
          generated_at: string | null
          generated_by: string | null
          generation_cost: number | null
          generation_time_ms: number | null
          id: string
          image_url_portrait: string | null
          image_url_square: string | null
          pdf_url: string | null
          project_id: string
          render_data: Json | null
          report_type: string
          schedule_id: string | null
          status: string
          template: string
          xlsx_url: string | null
        }
        Insert: {
          ai_narrative?: Json | null
          client_id: string
          comparison_from?: string | null
          comparison_to?: string | null
          created_at?: string
          csv_url?: string | null
          date_from: string
          date_to: string
          error_message?: string | null
          generated_at?: string | null
          generated_by?: string | null
          generation_cost?: number | null
          generation_time_ms?: number | null
          id?: string
          image_url_portrait?: string | null
          image_url_square?: string | null
          pdf_url?: string | null
          project_id: string
          render_data?: Json | null
          report_type?: string
          schedule_id?: string | null
          status?: string
          template?: string
          xlsx_url?: string | null
        }
        Update: {
          ai_narrative?: Json | null
          client_id?: string
          comparison_from?: string | null
          comparison_to?: string | null
          created_at?: string
          csv_url?: string | null
          date_from?: string
          date_to?: string
          error_message?: string | null
          generated_at?: string | null
          generated_by?: string | null
          generation_cost?: number | null
          generation_time_ms?: number | null
          id?: string
          image_url_portrait?: string | null
          image_url_square?: string | null
          pdf_url?: string | null
          project_id?: string
          render_data?: Json | null
          report_type?: string
          schedule_id?: string | null
          status?: string
          template?: string
          xlsx_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ad_reports_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ad_reports_generated_by_fkey"
            columns: ["generated_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ad_reports_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "ad_projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ad_reports_schedule_fk"
            columns: ["schedule_id"]
            isOneToOne: false
            referencedRelation: "ad_report_schedules"
            referencedColumns: ["id"]
          },
        ]
      }
      ad_sync_logs: {
        Row: {
          api_calls_made: number | null
          client_id: string | null
          created_at: string
          duration_ms: number | null
          error_message: string | null
          failed_records: number | null
          finished_at: string | null
          id: string
          job_id: string | null
          project_id: string | null
          provider: string
          records_imported: number | null
          records_skipped: number | null
          records_updated: number | null
          started_at: string
          status: string
          trigger_source: string
        }
        Insert: {
          api_calls_made?: number | null
          client_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          failed_records?: number | null
          finished_at?: string | null
          id?: string
          job_id?: string | null
          project_id?: string | null
          provider: string
          records_imported?: number | null
          records_skipped?: number | null
          records_updated?: number | null
          started_at?: string
          status: string
          trigger_source: string
        }
        Update: {
          api_calls_made?: number | null
          client_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          failed_records?: number | null
          finished_at?: string | null
          id?: string
          job_id?: string | null
          project_id?: string | null
          provider?: string
          records_imported?: number | null
          records_skipped?: number | null
          records_updated?: number | null
          started_at?: string
          status?: string
          trigger_source?: string
        }
        Relationships: [
          {
            foreignKeyName: "ad_sync_logs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ad_sync_logs_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "system_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ad_sync_logs_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "ad_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      ad_wallet_ledger: {
        Row: {
          ad_project_id: string | null
          amount: number
          amount_inr: number
          cashbook_entry_id: string | null
          client_id: string
          created_at: string
          created_by: string | null
          deleted_at: string | null
          direction: string
          id: string
          kind: string
          notes: string | null
          updated_at: string
        }
        Insert: {
          ad_project_id?: string | null
          amount: number
          amount_inr?: number
          cashbook_entry_id?: string | null
          client_id: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          direction: string
          id?: string
          kind: string
          notes?: string | null
          updated_at?: string
        }
        Update: {
          ad_project_id?: string | null
          amount?: number
          amount_inr?: number
          cashbook_entry_id?: string | null
          client_id?: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          direction?: string
          id?: string
          kind?: string
          notes?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ad_wallet_ledger_ad_project_id_fkey"
            columns: ["ad_project_id"]
            isOneToOne: false
            referencedRelation: "ad_projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ad_wallet_ledger_cashbook_entry_id_fkey"
            columns: ["cashbook_entry_id"]
            isOneToOne: false
            referencedRelation: "cashbook_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ad_wallet_ledger_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ad_wallet_ledger_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      agencies: {
        Row: {
          contact_name: string | null
          created_at: string
          email: string | null
          id: string
          is_active: boolean
          name: string
          phone: string | null
        }
        Insert: {
          contact_name?: string | null
          created_at?: string
          email?: string | null
          id?: string
          is_active?: boolean
          name: string
          phone?: string | null
        }
        Update: {
          contact_name?: string | null
          created_at?: string
          email?: string | null
          id?: string
          is_active?: boolean
          name?: string
          phone?: string | null
        }
        Relationships: []
      }
      allocation_audit_log: {
        Row: {
          action: string
          allocation_id: string | null
          cashbook_entry_id: string
          id: string
          new_amount: number | null
          new_invoice_id: string | null
          old_amount: number | null
          old_invoice_id: string | null
          operator: string | null
          timestamp: string
        }
        Insert: {
          action: string
          allocation_id?: string | null
          cashbook_entry_id: string
          id?: string
          new_amount?: number | null
          new_invoice_id?: string | null
          old_amount?: number | null
          old_invoice_id?: string | null
          operator?: string | null
          timestamp?: string
        }
        Update: {
          action?: string
          allocation_id?: string | null
          cashbook_entry_id?: string
          id?: string
          new_amount?: number | null
          new_invoice_id?: string | null
          old_amount?: number | null
          old_invoice_id?: string | null
          operator?: string | null
          timestamp?: string
        }
        Relationships: []
      }
      application_documents: {
        Row: {
          application_id: string
          created_at: string
          doc_type: string
          file_name: string | null
          id: string
          mime_type: string | null
          size_bytes: number | null
          storage_path: string
          uploaded_by: string | null
        }
        Insert: {
          application_id: string
          created_at?: string
          doc_type?: string
          file_name?: string | null
          id?: string
          mime_type?: string | null
          size_bytes?: number | null
          storage_path: string
          uploaded_by?: string | null
        }
        Update: {
          application_id?: string
          created_at?: string
          doc_type?: string
          file_name?: string | null
          id?: string
          mime_type?: string | null
          size_bytes?: number | null
          storage_path?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "application_documents_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "job_applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_documents_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      application_interviews: {
        Row: {
          application_id: string
          created_at: string
          created_by: string | null
          duration_minutes: number
          id: string
          interviewer_id: string | null
          meeting_link: string | null
          outcome_notes: string | null
          reminder_sent_at: string | null
          scheduled_at: string
          status: string
          updated_at: string
        }
        Insert: {
          application_id: string
          created_at?: string
          created_by?: string | null
          duration_minutes?: number
          id?: string
          interviewer_id?: string | null
          meeting_link?: string | null
          outcome_notes?: string | null
          reminder_sent_at?: string | null
          scheduled_at: string
          status?: string
          updated_at?: string
        }
        Update: {
          application_id?: string
          created_at?: string
          created_by?: string | null
          duration_minutes?: number
          id?: string
          interviewer_id?: string | null
          meeting_link?: string | null
          outcome_notes?: string | null
          reminder_sent_at?: string | null
          scheduled_at?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "application_interviews_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "job_applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_interviews_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_interviews_interviewer_id_fkey"
            columns: ["interviewer_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      application_notes: {
        Row: {
          application_id: string
          author_id: string
          created_at: string
          id: string
          note: string
        }
        Insert: {
          application_id: string
          author_id: string
          created_at?: string
          id?: string
          note: string
        }
        Update: {
          application_id?: string
          author_id?: string
          created_at?: string
          id?: string
          note?: string
        }
        Relationships: [
          {
            foreignKeyName: "application_notes_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "job_applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_notes_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      application_offers: {
        Row: {
          application_id: string
          created_at: string
          created_by: string | null
          currency: string
          expiry_date: string | null
          id: string
          notes: string | null
          offered_salary: number | null
          position_title: string | null
          responded_at: string | null
          sent_at: string | null
          start_date: string | null
          status: string
          updated_at: string
        }
        Insert: {
          application_id: string
          created_at?: string
          created_by?: string | null
          currency?: string
          expiry_date?: string | null
          id?: string
          notes?: string | null
          offered_salary?: number | null
          position_title?: string | null
          responded_at?: string | null
          sent_at?: string | null
          start_date?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          application_id?: string
          created_at?: string
          created_by?: string | null
          currency?: string
          expiry_date?: string | null
          id?: string
          notes?: string | null
          offered_salary?: number | null
          position_title?: string | null
          responded_at?: string | null
          sent_at?: string | null
          start_date?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "application_offers_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "job_applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_offers_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      approval_events: {
        Row: {
          actor_id: string | null
          approval_id: string
          attachment_id: string | null
          comment: string | null
          created_at: string
          event: string
          id: string
          version_no: number | null
        }
        Insert: {
          actor_id?: string | null
          approval_id: string
          attachment_id?: string | null
          comment?: string | null
          created_at?: string
          event: string
          id?: string
          version_no?: number | null
        }
        Update: {
          actor_id?: string | null
          approval_id?: string
          attachment_id?: string | null
          comment?: string | null
          created_at?: string
          event?: string
          id?: string
          version_no?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "approval_events_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approval_events_approval_id_fkey"
            columns: ["approval_id"]
            isOneToOne: false
            referencedRelation: "approvals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approval_events_attachment_id_fkey"
            columns: ["attachment_id"]
            isOneToOne: false
            referencedRelation: "message_attachments"
            referencedColumns: ["id"]
          },
        ]
      }
      approval_steps: {
        Row: {
          approval_id: string
          approver_designation_id: string | null
          approver_employee_id: string | null
          approver_permission: string | null
          created_at: string
          decided_at: string | null
          decided_by: string | null
          id: string
          status: string
          step_no: number
        }
        Insert: {
          approval_id: string
          approver_designation_id?: string | null
          approver_employee_id?: string | null
          approver_permission?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          status?: string
          step_no: number
        }
        Update: {
          approval_id?: string
          approver_designation_id?: string | null
          approver_employee_id?: string | null
          approver_permission?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          status?: string
          step_no?: number
        }
        Relationships: [
          {
            foreignKeyName: "approval_steps_approval_id_fkey"
            columns: ["approval_id"]
            isOneToOne: false
            referencedRelation: "approvals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approval_steps_approver_designation_id_fkey"
            columns: ["approver_designation_id"]
            isOneToOne: false
            referencedRelation: "designations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approval_steps_approver_employee_id_fkey"
            columns: ["approver_employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approval_steps_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      approvals: {
        Row: {
          approver_designation_id: string | null
          approver_employee_id: string | null
          approver_permission: string | null
          client_id: string | null
          conversation_id: string | null
          created_at: string
          decided_at: string | null
          decided_by: string | null
          description: string | null
          due_at: string | null
          entity_id: string | null
          entity_type: string
          id: string
          message_id: string | null
          project_id: string | null
          requested_by: string
          status: string
          step: number
          task_id: string | null
          title: string
          updated_at: string
        }
        Insert: {
          approver_designation_id?: string | null
          approver_employee_id?: string | null
          approver_permission?: string | null
          client_id?: string | null
          conversation_id?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          description?: string | null
          due_at?: string | null
          entity_id?: string | null
          entity_type: string
          id?: string
          message_id?: string | null
          project_id?: string | null
          requested_by: string
          status?: string
          step?: number
          task_id?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          approver_designation_id?: string | null
          approver_employee_id?: string | null
          approver_permission?: string | null
          client_id?: string | null
          conversation_id?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          description?: string | null
          due_at?: string | null
          entity_id?: string | null
          entity_type?: string
          id?: string
          message_id?: string | null
          project_id?: string | null
          requested_by?: string
          status?: string
          step?: number
          task_id?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "approvals_approver_designation_id_fkey"
            columns: ["approver_designation_id"]
            isOneToOne: false
            referencedRelation: "designations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approvals_approver_employee_id_fkey"
            columns: ["approver_employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approvals_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approvals_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approvals_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approvals_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approvals_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "ad_projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approvals_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approvals_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: string
          created_at: string | null
          employee_id: string | null
          id: string
          ip_address: string | null
          new_value: Json | null
          old_value: Json | null
          record_id: string | null
          table_name: string | null
        }
        Insert: {
          action: string
          created_at?: string | null
          employee_id?: string | null
          id?: string
          ip_address?: string | null
          new_value?: Json | null
          old_value?: Json | null
          record_id?: string | null
          table_name?: string | null
        }
        Update: {
          action?: string
          created_at?: string | null
          employee_id?: string | null
          id?: string
          ip_address?: string | null
          new_value?: Json | null
          old_value?: Json | null
          record_id?: string | null
          table_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      bank_accounts: {
        Row: {
          account_number: string | null
          bank_name: string | null
          created_at: string | null
          currency: string | null
          display_order: number | null
          id: string
          is_active: boolean | null
          is_default: boolean | null
          name: string
          opening_balance: number | null
          type: string | null
        }
        Insert: {
          account_number?: string | null
          bank_name?: string | null
          created_at?: string | null
          currency?: string | null
          display_order?: number | null
          id?: string
          is_active?: boolean | null
          is_default?: boolean | null
          name: string
          opening_balance?: number | null
          type?: string | null
        }
        Update: {
          account_number?: string | null
          bank_name?: string | null
          created_at?: string | null
          currency?: string | null
          display_order?: number | null
          id?: string
          is_active?: boolean | null
          is_default?: boolean | null
          name?: string
          opening_balance?: number | null
          type?: string | null
        }
        Relationships: []
      }
      business_partners: {
        Row: {
          commission_type: string | null
          commission_value: number | null
          company: string | null
          created_at: string | null
          email: string | null
          id: string
          name: string
          notes: string | null
          partner_code: string
          phone: string | null
          status: string
          updated_at: string | null
        }
        Insert: {
          commission_type?: string | null
          commission_value?: number | null
          company?: string | null
          created_at?: string | null
          email?: string | null
          id?: string
          name: string
          notes?: string | null
          partner_code: string
          phone?: string | null
          status?: string
          updated_at?: string | null
        }
        Update: {
          commission_type?: string | null
          commission_value?: number | null
          company?: string | null
          created_at?: string | null
          email?: string | null
          id?: string
          name?: string
          notes?: string | null
          partner_code?: string
          phone?: string | null
          status?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      cashbook_audit_log: {
        Row: {
          changed_at: string
          changed_by: string | null
          entry_id: string | null
          id: string
          invoice_id: string | null
          new_amount: number | null
          new_paid_amount: number | null
          new_status: string | null
          notes: string | null
          old_amount: number | null
          old_paid_amount: number | null
          old_status: string | null
          operation: string
        }
        Insert: {
          changed_at?: string
          changed_by?: string | null
          entry_id?: string | null
          id?: string
          invoice_id?: string | null
          new_amount?: number | null
          new_paid_amount?: number | null
          new_status?: string | null
          notes?: string | null
          old_amount?: number | null
          old_paid_amount?: number | null
          old_status?: string | null
          operation: string
        }
        Update: {
          changed_at?: string
          changed_by?: string | null
          entry_id?: string | null
          id?: string
          invoice_id?: string | null
          new_amount?: number | null
          new_paid_amount?: number | null
          new_status?: string | null
          notes?: string | null
          old_amount?: number | null
          old_paid_amount?: number | null
          old_status?: string | null
          operation?: string
        }
        Relationships: [
          {
            foreignKeyName: "cashbook_audit_log_entry_id_fkey"
            columns: ["entry_id"]
            isOneToOne: false
            referencedRelation: "cashbook_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cashbook_audit_log_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      cashbook_categories: {
        Row: {
          category_group: string | null
          created_at: string | null
          display_order: number | null
          has_billable_flag: boolean | null
          has_client_link: boolean | null
          id: string
          is_active: boolean | null
          name: string
          type: string
        }
        Insert: {
          category_group?: string | null
          created_at?: string | null
          display_order?: number | null
          has_billable_flag?: boolean | null
          has_client_link?: boolean | null
          id?: string
          is_active?: boolean | null
          name: string
          type: string
        }
        Update: {
          category_group?: string | null
          created_at?: string | null
          display_order?: number | null
          has_billable_flag?: boolean | null
          has_client_link?: boolean | null
          id?: string
          is_active?: boolean | null
          name?: string
          type?: string
        }
        Relationships: []
      }
      cashbook_entries: {
        Row: {
          amount: number
          amount_inr: number
          bank_account_id: string | null
          category_id: string | null
          client_id: string | null
          created_at: string | null
          created_by: string | null
          currency: string | null
          deleted_at: string | null
          description: string | null
          employee_id: string | null
          entry_date: string
          exchange_rate: number
          id: string
          invoice_id: string | null
          is_billable: boolean | null
          is_reviewed: boolean
          notes: string | null
          payment_method: string | null
          rate_date: string | null
          rate_source: string
          receipt_number: string | null
          reference: string | null
          service_id: string | null
          transfer_ref: string | null
          type: string
          updated_at: string | null
        }
        Insert: {
          amount: number
          amount_inr: number
          bank_account_id?: string | null
          category_id?: string | null
          client_id?: string | null
          created_at?: string | null
          created_by?: string | null
          currency?: string | null
          deleted_at?: string | null
          description?: string | null
          employee_id?: string | null
          entry_date?: string
          exchange_rate?: number
          id?: string
          invoice_id?: string | null
          is_billable?: boolean | null
          is_reviewed?: boolean
          notes?: string | null
          payment_method?: string | null
          rate_date?: string | null
          rate_source?: string
          receipt_number?: string | null
          reference?: string | null
          service_id?: string | null
          transfer_ref?: string | null
          type: string
          updated_at?: string | null
        }
        Update: {
          amount?: number
          amount_inr?: number
          bank_account_id?: string | null
          category_id?: string | null
          client_id?: string | null
          created_at?: string | null
          created_by?: string | null
          currency?: string | null
          deleted_at?: string | null
          description?: string | null
          employee_id?: string | null
          entry_date?: string
          exchange_rate?: number
          id?: string
          invoice_id?: string | null
          is_billable?: boolean | null
          is_reviewed?: boolean
          notes?: string | null
          payment_method?: string | null
          rate_date?: string | null
          rate_source?: string
          receipt_number?: string | null
          reference?: string | null
          service_id?: string | null
          transfer_ref?: string | null
          type?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cashbook_entries_bank_account_id_fkey"
            columns: ["bank_account_id"]
            isOneToOne: false
            referencedRelation: "bank_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cashbook_entries_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "cashbook_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cashbook_entries_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cashbook_entries_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cashbook_entries_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cashbook_entries_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cashbook_entries_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      cashbook_invoice_allocations: {
        Row: {
          allocated_amount: number
          cashbook_entry_id: string
          created_at: string
          deleted_at: string | null
          id: string
          invoice_id: string
          updated_at: string
        }
        Insert: {
          allocated_amount?: number
          cashbook_entry_id: string
          created_at?: string
          deleted_at?: string | null
          id?: string
          invoice_id: string
          updated_at?: string
        }
        Update: {
          allocated_amount?: number
          cashbook_entry_id?: string
          created_at?: string
          deleted_at?: string | null
          id?: string
          invoice_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cashbook_invoice_allocations_cashbook_entry_id_fkey"
            columns: ["cashbook_entry_id"]
            isOneToOne: false
            referencedRelation: "cashbook_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cashbook_invoice_allocations_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      cashbook_payroll_allocations: {
        Row: {
          allocated_amount: number
          cashbook_entry_id: string
          created_at: string | null
          deleted_at: string | null
          id: string
          payroll_id: string
          updated_at: string | null
        }
        Insert: {
          allocated_amount?: number
          cashbook_entry_id: string
          created_at?: string | null
          deleted_at?: string | null
          id?: string
          payroll_id: string
          updated_at?: string | null
        }
        Update: {
          allocated_amount?: number
          cashbook_entry_id?: string
          created_at?: string | null
          deleted_at?: string | null
          id?: string
          payroll_id?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_cpa_cashbook_entry"
            columns: ["cashbook_entry_id"]
            isOneToOne: false
            referencedRelation: "cashbook_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_cpa_payroll"
            columns: ["payroll_id"]
            isOneToOne: false
            referencedRelation: "payroll"
            referencedColumns: ["id"]
          },
        ]
      }
      client_branding: {
        Row: {
          accent_color: string
          agency_logo_url: string | null
          agency_name: string | null
          client_id: string
          client_name: string | null
          confidential_watermark: boolean
          contact_email: string | null
          contact_phone: string | null
          contact_website: string | null
          created_at: string
          footer_text: string | null
          id: string
          logo_url: string | null
          metadata: Json
          primary_color: string
          secondary_color: string
          show_powered_by: boolean
          updated_at: string
          white_label_mode: string
        }
        Insert: {
          accent_color?: string
          agency_logo_url?: string | null
          agency_name?: string | null
          client_id: string
          client_name?: string | null
          confidential_watermark?: boolean
          contact_email?: string | null
          contact_phone?: string | null
          contact_website?: string | null
          created_at?: string
          footer_text?: string | null
          id?: string
          logo_url?: string | null
          metadata?: Json
          primary_color?: string
          secondary_color?: string
          show_powered_by?: boolean
          updated_at?: string
          white_label_mode?: string
        }
        Update: {
          accent_color?: string
          agency_logo_url?: string | null
          agency_name?: string | null
          client_id?: string
          client_name?: string | null
          confidential_watermark?: boolean
          contact_email?: string | null
          contact_phone?: string | null
          contact_website?: string | null
          created_at?: string
          footer_text?: string | null
          id?: string
          logo_url?: string | null
          metadata?: Json
          primary_color?: string
          secondary_color?: string
          show_powered_by?: boolean
          updated_at?: string
          white_label_mode?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_branding_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: true
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      client_product_assignments: {
        Row: {
          client_id: string
          created_at: string
          custom_image_id: string | null
          custom_name: string | null
          custom_weight: string | null
          id: string
          is_active: boolean
          product_id: string
          updated_at: string
        }
        Insert: {
          client_id: string
          created_at?: string
          custom_image_id?: string | null
          custom_name?: string | null
          custom_weight?: string | null
          id?: string
          is_active?: boolean
          product_id: string
          updated_at?: string
        }
        Update: {
          client_id?: string
          created_at?: string
          custom_image_id?: string | null
          custom_name?: string | null
          custom_weight?: string | null
          id?: string
          is_active?: boolean
          product_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_product_assignments_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_product_assignments_custom_image_id_fkey"
            columns: ["custom_image_id"]
            isOneToOne: false
            referencedRelation: "product_catalog_images"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_product_assignments_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "product_catalog"
            referencedColumns: ["id"]
          },
        ]
      }
      client_product_catalog: {
        Row: {
          category: string | null
          client_id: string
          created_at: string
          id: string
          image_url: string | null
          is_active: boolean
          name: string
          updated_at: string
          weight: string | null
        }
        Insert: {
          category?: string | null
          client_id: string
          created_at?: string
          id?: string
          image_url?: string | null
          is_active?: boolean
          name: string
          updated_at?: string
          weight?: string | null
        }
        Update: {
          category?: string | null
          client_id?: string
          created_at?: string
          id?: string
          image_url?: string | null
          is_active?: boolean
          name?: string
          updated_at?: string
          weight?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_product_catalog_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      client_service_pricing: {
        Row: {
          client_id: string | null
          commission_percentage: number | null
          created_at: string | null
          currency: string | null
          id: string
          is_active: boolean | null
          parameter_overrides: Json
          percentage_rate: number | null
          price: number | null
          service_id: string | null
          updated_at: string | null
          variant_pricing: Json
        }
        Insert: {
          client_id?: string | null
          commission_percentage?: number | null
          created_at?: string | null
          currency?: string | null
          id?: string
          is_active?: boolean | null
          parameter_overrides?: Json
          percentage_rate?: number | null
          price?: number | null
          service_id?: string | null
          updated_at?: string | null
          variant_pricing?: Json
        }
        Update: {
          client_id?: string | null
          commission_percentage?: number | null
          created_at?: string | null
          currency?: string | null
          id?: string
          is_active?: boolean | null
          parameter_overrides?: Json
          percentage_rate?: number | null
          price?: number | null
          service_id?: string | null
          updated_at?: string | null
          variant_pricing?: Json
        }
        Relationships: [
          {
            foreignKeyName: "client_service_pricing_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_service_pricing_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      clients: {
        Row: {
          address: string | null
          billing_cycle: string | null
          billing_day: number | null
          business_partner_id: string | null
          code: string
          contact_name: string | null
          country: string | null
          created_at: string | null
          credit_limit: number | null
          default_currency: string | null
          drive_folder_link: string | null
          email: string | null
          gstin: string | null
          has_offer_flyer_service: boolean
          hub_token: string
          id: string
          is_active: boolean | null
          name: string
          offer_intake_token: string | null
          offer_sheet_webhook_url: string | null
          offer_sheet_url: string | null
          phone: string | null
          pricing_pending: boolean
          updated_at: string | null
        }
        Insert: {
          address?: string | null
          billing_cycle?: string | null
          billing_day?: number | null
          business_partner_id?: string | null
          code: string
          contact_name?: string | null
          country?: string | null
          created_at?: string | null
          credit_limit?: number | null
          default_currency?: string | null
          drive_folder_link?: string | null
          email?: string | null
          gstin?: string | null
          has_offer_flyer_service?: boolean
          hub_token?: string
          id?: string
          is_active?: boolean | null
          name: string
          offer_intake_token?: string | null
          offer_sheet_webhook_url?: string | null
          phone?: string | null
          pricing_pending?: boolean
          updated_at?: string | null
        }
        Update: {
          address?: string | null
          billing_cycle?: string | null
          billing_day?: number | null
          business_partner_id?: string | null
          code?: string
          contact_name?: string | null
          country?: string | null
          created_at?: string | null
          credit_limit?: number | null
          default_currency?: string | null
          drive_folder_link?: string | null
          email?: string | null
          gstin?: string | null
          has_offer_flyer_service?: boolean
          hub_token?: string
          id?: string
          is_active?: boolean | null
          name?: string
          offer_intake_token?: string | null
          offer_sheet_webhook_url?: string | null
          phone?: string | null
          pricing_pending?: boolean
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "clients_business_partner_id_fkey"
            columns: ["business_partner_id"]
            isOneToOne: false
            referencedRelation: "business_partners"
            referencedColumns: ["id"]
          },
        ]
      }
      company_settings: {
        Row: {
          created_at: string | null
          id: string
          key: string
          updated_at: string | null
          value: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          key: string
          updated_at?: string | null
          value?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          key?: string
          updated_at?: string | null
          value?: string | null
        }
        Relationships: []
      }
      contribution_groups: {
        Row: {
          created_at: string | null
          description: string | null
          display_order: number | null
          id: string
          is_active: boolean | null
          name: string
          updated_at: string | null
          weight: number
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          display_order?: number | null
          id?: string
          is_active?: boolean | null
          name: string
          updated_at?: string | null
          weight?: number
        }
        Update: {
          created_at?: string | null
          description?: string | null
          display_order?: number | null
          id?: string
          is_active?: boolean | null
          name?: string
          updated_at?: string | null
          weight?: number
        }
        Relationships: []
      }
      contribution_scores: {
        Row: {
          agreement_id: string | null
          calculated_at: string | null
          earning_source: string
          earnings_inr: number | null
          employee_id: string | null
          id: string
          is_manual_override: boolean
          score_percentage: number | null
          task_id: string
        }
        Insert: {
          agreement_id?: string | null
          calculated_at?: string | null
          earning_source?: string
          earnings_inr?: number | null
          employee_id?: string | null
          id?: string
          is_manual_override?: boolean
          score_percentage?: number | null
          task_id: string
        }
        Update: {
          agreement_id?: string | null
          calculated_at?: string | null
          earning_source?: string
          earnings_inr?: number | null
          employee_id?: string | null
          id?: string
          is_manual_override?: boolean
          score_percentage?: number | null
          task_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contribution_scores_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "employee_commission_agreements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contribution_scores_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contribution_scores_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      contributions: {
        Row: {
          created_at: string | null
          employee_id: string | null
          id: string
          locked: boolean | null
          parameter_id: string | null
          task_id: string | null
          updated_at: string | null
          value: number | null
        }
        Insert: {
          created_at?: string | null
          employee_id?: string | null
          id?: string
          locked?: boolean | null
          parameter_id?: string | null
          task_id?: string | null
          updated_at?: string | null
          value?: number | null
        }
        Update: {
          created_at?: string | null
          employee_id?: string | null
          id?: string
          locked?: boolean | null
          parameter_id?: string | null
          task_id?: string | null
          updated_at?: string | null
          value?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "contributions_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contributions_parameter_id_fkey"
            columns: ["parameter_id"]
            isOneToOne: false
            referencedRelation: "parameters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contributions_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      conversation_members: {
        Row: {
          conversation_id: string
          employee_id: string
          joined_at: string
          last_read_at: string
          notify_level: string
          role: string
        }
        Insert: {
          conversation_id: string
          employee_id: string
          joined_at?: string
          last_read_at?: string
          notify_level?: string
          role?: string
        }
        Update: {
          conversation_id?: string
          employee_id?: string
          joined_at?: string
          last_read_at?: string
          notify_level?: string
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversation_members_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversation_members_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          archived_at: string | null
          category: string | null
          client_id: string | null
          created_at: string
          created_by: string | null
          id: string
          is_private: boolean
          name: string | null
          portal_token: string | null
          project_id: string | null
          request_id: string | null
          task_id: string | null
          topic: string | null
          type: string
        }
        Insert: {
          archived_at?: string | null
          category?: string | null
          client_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          is_private?: boolean
          name?: string | null
          portal_token?: string | null
          project_id?: string | null
          request_id?: string | null
          task_id?: string | null
          topic?: string | null
          type: string
        }
        Update: {
          archived_at?: string | null
          category?: string | null
          client_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          is_private?: boolean
          name?: string | null
          portal_token?: string | null
          project_id?: string | null
          request_id?: string | null
          task_id?: string | null
          topic?: string | null
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "ad_projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "task_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      credit_ledger: {
        Row: {
          amount: number
          bank_account_id: string | null
          created_at: string | null
          credit_date: string
          credit_type: string
          entity_id: string | null
          entity_type: string
          id: string
          notes: string | null
        }
        Insert: {
          amount: number
          bank_account_id?: string | null
          created_at?: string | null
          credit_date?: string
          credit_type: string
          entity_id?: string | null
          entity_type?: string
          id?: string
          notes?: string | null
        }
        Update: {
          amount?: number
          bank_account_id?: string | null
          created_at?: string | null
          credit_date?: string
          credit_type?: string
          entity_id?: string | null
          entity_type?: string
          id?: string
          notes?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "credit_ledger_bank_account_id_fkey"
            columns: ["bank_account_id"]
            isOneToOne: false
            referencedRelation: "bank_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "credit_ledger_entity_id_fkey"
            columns: ["entity_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      cron_runs: {
        Row: {
          cron_name: string
          error: string | null
          id: string
          ok: boolean
          ran_at: string
          summary: Json | null
        }
        Insert: {
          cron_name: string
          error?: string | null
          id?: string
          ok: boolean
          ran_at?: string
          summary?: Json | null
        }
        Update: {
          cron_name?: string
          error?: string | null
          id?: string
          ok?: boolean
          ran_at?: string
          summary?: Json | null
        }
        Relationships: []
      }
      deductions: {
        Row: {
          amount: number
          created_at: string | null
          employee_id: string | null
          id: string
          invoice_id: string | null
          reason: string | null
          type: string
        }
        Insert: {
          amount: number
          created_at?: string | null
          employee_id?: string | null
          id?: string
          invoice_id?: string | null
          reason?: string | null
          type: string
        }
        Update: {
          amount?: number
          created_at?: string | null
          employee_id?: string | null
          id?: string
          invoice_id?: string | null
          reason?: string | null
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "deductions_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deductions_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      designation_permissions: {
        Row: {
          allowed: boolean
          designation_id: string
          permission_id: string
        }
        Insert: {
          allowed?: boolean
          designation_id: string
          permission_id: string
        }
        Update: {
          allowed?: boolean
          designation_id?: string
          permission_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "designation_permissions_designation_id_fkey"
            columns: ["designation_id"]
            isOneToOne: false
            referencedRelation: "designations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "designation_permissions_permission_id_fkey"
            columns: ["permission_id"]
            isOneToOne: false
            referencedRelation: "permissions"
            referencedColumns: ["id"]
          },
        ]
      }
      designations: {
        Row: {
          created_at: string | null
          description: string | null
          display_order: number | null
          id: string
          is_admin: boolean | null
          is_system: boolean | null
          name: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          display_order?: number | null
          id?: string
          is_admin?: boolean | null
          is_system?: boolean | null
          name: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          description?: string | null
          display_order?: number | null
          id?: string
          is_admin?: boolean | null
          is_system?: boolean | null
          name?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      discount_logs: {
        Row: {
          client_id: string | null
          created_at: string | null
          discount_amount: number
          discount_percentage: number | null
          id: string
          invoice_id: string | null
          invoice_total: number | null
          reason: string
        }
        Insert: {
          client_id?: string | null
          created_at?: string | null
          discount_amount: number
          discount_percentage?: number | null
          id?: string
          invoice_id?: string | null
          invoice_total?: number | null
          reason: string
        }
        Update: {
          client_id?: string | null
          created_at?: string | null
          discount_amount?: number
          discount_percentage?: number | null
          id?: string
          invoice_id?: string | null
          invoice_total?: number | null
          reason?: string
        }
        Relationships: [
          {
            foreignKeyName: "discount_logs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discount_logs_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_commission_agreements: {
        Row: {
          agreement_type: string
          agreement_value: number
          client_id: string | null
          created_at: string
          created_by: string | null
          currency: string
          effective_from: string
          effective_to: string | null
          employee_id: string
          id: string
          is_active: boolean
          notes: string | null
          service_id: string | null
          updated_at: string
        }
        Insert: {
          agreement_type?: string
          agreement_value?: number
          client_id?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          effective_from?: string
          effective_to?: string | null
          employee_id: string
          id?: string
          is_active?: boolean
          notes?: string | null
          service_id?: string | null
          updated_at?: string
        }
        Update: {
          agreement_type?: string
          agreement_value?: number
          client_id?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          effective_from?: string
          effective_to?: string | null
          employee_id?: string
          id?: string
          is_active?: boolean
          notes?: string | null
          service_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "employee_commission_agreements_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_commission_agreements_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_commission_agreements_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_commission_agreements_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_favorites: {
        Row: {
          created_at: string | null
          employee_id: string
          entity_id: string | null
          entity_type: string
          href: string
          icon_key: string
          id: string
          label: string
          position: number
        }
        Insert: {
          created_at?: string | null
          employee_id: string
          entity_id?: string | null
          entity_type: string
          href: string
          icon_key: string
          id?: string
          label: string
          position?: number
        }
        Update: {
          created_at?: string | null
          employee_id?: string
          entity_id?: string | null
          entity_type?: string
          href?: string
          icon_key?: string
          id?: string
          label?: string
          position?: number
        }
        Relationships: [
          {
            foreignKeyName: "employee_favorites_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      employees: {
        Row: {
          archived_at: string | null
          auth_id: string | null
          avatar_url: string | null
          bank_details: Json | null
          base_salary: number | null
          cqid: string
          created_at: string | null
          current_workspace_id: string | null
          date_of_birth: string | null
          designation_id: string | null
          email: string
          emergency_contact_name: string | null
          emergency_contact_phone: string | null
          hourly_rate: number | null
          id: string
          invite_token: string | null
          invite_token_expires_at: string | null
          is_active: boolean | null
          is_archived: boolean | null
          joined_date: string | null
          name: string
          performance_rating: number | null
          phone: string | null
          registered_at: string | null
          reveal_salary: boolean | null
          role: string
          salary_type: string | null
          updated_at: string | null
        }
        Insert: {
          archived_at?: string | null
          auth_id?: string | null
          avatar_url?: string | null
          bank_details?: Json | null
          base_salary?: number | null
          cqid?: string
          created_at?: string | null
          current_workspace_id?: string | null
          date_of_birth?: string | null
          designation_id?: string | null
          email: string
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          hourly_rate?: number | null
          id?: string
          invite_token?: string | null
          invite_token_expires_at?: string | null
          is_active?: boolean | null
          is_archived?: boolean | null
          joined_date?: string | null
          name: string
          performance_rating?: number | null
          phone?: string | null
          registered_at?: string | null
          reveal_salary?: boolean | null
          role?: string
          salary_type?: string | null
          updated_at?: string | null
        }
        Update: {
          archived_at?: string | null
          auth_id?: string | null
          avatar_url?: string | null
          bank_details?: Json | null
          base_salary?: number | null
          cqid?: string
          created_at?: string | null
          current_workspace_id?: string | null
          date_of_birth?: string | null
          designation_id?: string | null
          email?: string
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          hourly_rate?: number | null
          id?: string
          invite_token?: string | null
          invite_token_expires_at?: string | null
          is_active?: boolean | null
          is_archived?: boolean | null
          joined_date?: string | null
          name?: string
          performance_rating?: number | null
          phone?: string | null
          registered_at?: string | null
          reveal_salary?: boolean | null
          role?: string
          salary_type?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "employees_current_workspace_id_fkey"
            columns: ["current_workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_designation_id_fkey"
            columns: ["designation_id"]
            isOneToOne: false
            referencedRelation: "designations"
            referencedColumns: ["id"]
          },
        ]
      }
      exchange_rates: {
        Row: {
          currency: string
          id: string
          last_updated: string | null
          rate_date: string | null
          rate_source: string
          rate_to_inr: number
        }
        Insert: {
          currency: string
          id?: string
          last_updated?: string | null
          rate_date?: string | null
          rate_source?: string
          rate_to_inr: number
        }
        Update: {
          currency?: string
          id?: string
          last_updated?: string | null
          rate_date?: string | null
          rate_source?: string
          rate_to_inr?: number
        }
        Relationships: []
      }
      group_services: {
        Row: {
          group_id: string
          service_id: string
        }
        Insert: {
          group_id: string
          service_id: string
        }
        Update: {
          group_id?: string
          service_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "group_services_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "contribution_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "group_services_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      hr_reference_sequences: {
        Row: {
          next_seq: number
          year_key: string
        }
        Insert: {
          next_seq?: number
          year_key: string
        }
        Update: {
          next_seq?: number
          year_key?: string
        }
        Relationships: []
      }
      intake_links: {
        Row: {
          agency_id: string | null
          client_id: string | null
          created_at: string
          created_by: string | null
          expires_at: string | null
          id: string
          is_active: boolean
          label: string | null
          last_used_at: string | null
          revoked_at: string | null
          token: string
          type: string
        }
        Insert: {
          agency_id?: string | null
          client_id?: string | null
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          is_active?: boolean
          label?: string | null
          last_used_at?: string | null
          revoked_at?: string | null
          token?: string
          type?: string
        }
        Update: {
          agency_id?: string | null
          client_id?: string | null
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          is_active?: boolean
          label?: string | null
          last_used_at?: string | null
          revoked_at?: string | null
          token?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "intake_links_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "intake_links_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "intake_links_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_ad_spend_items: {
        Row: {
          ad_project_id: string | null
          amount: number
          amount_inr: number
          created_at: string
          currency: string
          description: string
          display_order: number
          id: string
          invoice_id: string
        }
        Insert: {
          ad_project_id?: string | null
          amount?: number
          amount_inr?: number
          created_at?: string
          currency?: string
          description?: string
          display_order?: number
          id?: string
          invoice_id: string
        }
        Update: {
          ad_project_id?: string | null
          amount?: number
          amount_inr?: number
          created_at?: string
          currency?: string
          description?: string
          display_order?: number
          id?: string
          invoice_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoice_ad_spend_items_ad_project_id_fkey"
            columns: ["ad_project_id"]
            isOneToOne: false
            referencedRelation: "ad_projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_ad_spend_items_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_change_logs: {
        Row: {
          changed_at: string | null
          field_name: string
          id: string
          invoice_id: string | null
          new_value: string | null
          old_value: string | null
          reason: string
        }
        Insert: {
          changed_at?: string | null
          field_name: string
          id?: string
          invoice_id?: string | null
          new_value?: string | null
          old_value?: string | null
          reason: string
        }
        Update: {
          changed_at?: string | null
          field_name?: string
          id?: string
          invoice_id?: string | null
          new_value?: string | null
          old_value?: string | null
          reason?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoice_change_logs_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_expense_items: {
        Row: {
          amount: number
          amount_inr: number
          cashbook_entry_id: string
          created_at: string
          currency: string
          description: string
          id: string
          invoice_id: string
          markup_amount: number
          markup_type: string
          markup_value: number
          notes: string | null
          original_amount: number
          original_amount_inr: number
        }
        Insert: {
          amount?: number
          amount_inr?: number
          cashbook_entry_id: string
          created_at?: string
          currency?: string
          description?: string
          id?: string
          invoice_id: string
          markup_amount?: number
          markup_type?: string
          markup_value?: number
          notes?: string | null
          original_amount?: number
          original_amount_inr?: number
        }
        Update: {
          amount?: number
          amount_inr?: number
          cashbook_entry_id?: string
          created_at?: string
          currency?: string
          description?: string
          id?: string
          invoice_id?: string
          markup_amount?: number
          markup_type?: string
          markup_value?: number
          notes?: string | null
          original_amount?: number
          original_amount_inr?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoice_expense_items_cashbook_entry_id_fkey"
            columns: ["cashbook_entry_id"]
            isOneToOne: true
            referencedRelation: "cashbook_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_expense_items_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_followups: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          invoice_id: string
          next_followup_date: string | null
          note: string | null
          outcome: string | null
          promised_date: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          invoice_id: string
          next_followup_date?: string | null
          note?: string | null
          outcome?: string | null
          promised_date?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          invoice_id?: string
          next_followup_date?: string | null
          note?: string | null
          outcome?: string | null
          promised_date?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoice_followups_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_followups_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_items: {
        Row: {
          currency: string | null
          description: string
          display_order: number | null
          id: string
          invoice_id: string | null
          quantity: number | null
          service_id: string | null
          task_id: string | null
          total: number | null
          unit_price: number | null
        }
        Insert: {
          currency?: string | null
          description: string
          display_order?: number | null
          id?: string
          invoice_id?: string | null
          quantity?: number | null
          service_id?: string | null
          task_id?: string | null
          total?: number | null
          unit_price?: number | null
        }
        Update: {
          currency?: string | null
          description?: string
          display_order?: number | null
          id?: string
          invoice_id?: string | null
          quantity?: number | null
          service_id?: string | null
          task_id?: string | null
          total?: number | null
          unit_price?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "invoice_items_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_items_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_items_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          ad_project_id: string | null
          ad_spend_mode: string
          billing_period_end: string | null
          billing_period_start: string | null
          client_id: string | null
          created_at: string | null
          created_by: string | null
          currency: string | null
          discount_amount: number | null
          due_date: string | null
          exchange_rate: number
          expenses_mode: string
          id: string
          invoice_number: string
          invoice_sequence_month: string | null
          issue_date: string
          notes: string | null
          paid_amount: number | null
          paid_amount_inr: number | null
          previous_balance: number | null
          public_token: string
          quotation_id: string | null
          status: string | null
          subtotal: number | null
          tax_amount: number | null
          tax_rate: number | null
          total_amount: number | null
          total_amount_inr: number | null
          updated_at: string | null
        }
        Insert: {
          ad_project_id?: string | null
          ad_spend_mode?: string
          billing_period_end?: string | null
          billing_period_start?: string | null
          client_id?: string | null
          created_at?: string | null
          created_by?: string | null
          currency?: string | null
          discount_amount?: number | null
          due_date?: string | null
          exchange_rate?: number
          expenses_mode?: string
          id?: string
          invoice_number: string
          invoice_sequence_month?: string | null
          issue_date?: string
          notes?: string | null
          paid_amount?: number | null
          paid_amount_inr?: number | null
          previous_balance?: number | null
          public_token?: string
          quotation_id?: string | null
          status?: string | null
          subtotal?: number | null
          tax_amount?: number | null
          tax_rate?: number | null
          total_amount?: number | null
          total_amount_inr?: number | null
          updated_at?: string | null
        }
        Update: {
          ad_project_id?: string | null
          ad_spend_mode?: string
          billing_period_end?: string | null
          billing_period_start?: string | null
          client_id?: string | null
          created_at?: string | null
          created_by?: string | null
          currency?: string | null
          discount_amount?: number | null
          due_date?: string | null
          exchange_rate?: number
          expenses_mode?: string
          id?: string
          invoice_number?: string
          invoice_sequence_month?: string | null
          issue_date?: string
          notes?: string | null
          paid_amount?: number | null
          paid_amount_inr?: number | null
          previous_balance?: number | null
          public_token?: string
          quotation_id?: string | null
          status?: string | null
          subtotal?: number | null
          tax_amount?: number | null
          tax_rate?: number | null
          total_amount?: number | null
          total_amount_inr?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoices_ad_project_id_fkey"
            columns: ["ad_project_id"]
            isOneToOne: false
            referencedRelation: "ad_projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_quotation_id_fkey"
            columns: ["quotation_id"]
            isOneToOne: false
            referencedRelation: "quotations"
            referencedColumns: ["id"]
          },
        ]
      }
      item_usage: {
        Row: {
          count: number
          employee_id: string
          href: string
          item_key: string
          item_type: string
          label: string
          last_used_at: string
          workspace_id: string | null
        }
        Insert: {
          count?: number
          employee_id: string
          href: string
          item_key: string
          item_type?: string
          label: string
          last_used_at?: string
          workspace_id?: string | null
        }
        Update: {
          count?: number
          employee_id?: string
          href?: string
          item_key?: string
          item_type?: string
          label?: string
          last_used_at?: string
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "item_usage_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "item_usage_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      job_applications: {
        Row: {
          assigned_to: string | null
          availability: string | null
          country: string | null
          cover_letter: string | null
          created_at: string
          email: string
          expected_salary: number | null
          experience: string | null
          full_name: string
          id: string
          linkedin_url: string | null
          location: string | null
          phone: string | null
          portfolio_url: string | null
          position_id: string | null
          position_title: string
          reference_number: string
          rejected_reason: string | null
          resume_storage_path: string | null
          skills: string[]
          source: string
          stage: string
          submitted_ip: string | null
          updated_at: string
          why_join: string | null
        }
        Insert: {
          assigned_to?: string | null
          availability?: string | null
          country?: string | null
          cover_letter?: string | null
          created_at?: string
          email: string
          expected_salary?: number | null
          experience?: string | null
          full_name: string
          id?: string
          linkedin_url?: string | null
          location?: string | null
          phone?: string | null
          portfolio_url?: string | null
          position_id?: string | null
          position_title: string
          reference_number: string
          rejected_reason?: string | null
          resume_storage_path?: string | null
          skills?: string[]
          source?: string
          stage?: string
          submitted_ip?: string | null
          updated_at?: string
          why_join?: string | null
        }
        Update: {
          assigned_to?: string | null
          availability?: string | null
          country?: string | null
          cover_letter?: string | null
          created_at?: string
          email?: string
          expected_salary?: number | null
          experience?: string | null
          full_name?: string
          id?: string
          linkedin_url?: string | null
          location?: string | null
          phone?: string | null
          portfolio_url?: string | null
          position_id?: string | null
          position_title?: string
          reference_number?: string
          rejected_reason?: string | null
          resume_storage_path?: string | null
          skills?: string[]
          source?: string
          stage?: string
          submitted_ip?: string | null
          updated_at?: string
          why_join?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "job_applications_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_applications_position_id_fkey"
            columns: ["position_id"]
            isOneToOne: false
            referencedRelation: "job_positions"
            referencedColumns: ["id"]
          },
        ]
      }
      job_positions: {
        Row: {
          created_at: string
          created_by: string | null
          department: string | null
          description: string | null
          employment_type: string
          id: string
          is_remote: boolean
          location: string | null
          openings: number
          requirements: string | null
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          department?: string | null
          description?: string | null
          employment_type?: string
          id?: string
          is_remote?: boolean
          location?: string | null
          openings?: number
          requirements?: string | null
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          department?: string | null
          description?: string | null
          employment_type?: string
          id?: string
          is_remote?: boolean
          location?: string | null
          openings?: number
          requirements?: string | null
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_positions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      message_attachments: {
        Row: {
          created_at: string
          file_name: string
          id: string
          message_id: string
          mime_type: string | null
          size_bytes: number | null
          storage_path: string
        }
        Insert: {
          created_at?: string
          file_name: string
          id?: string
          message_id: string
          mime_type?: string | null
          size_bytes?: number | null
          storage_path: string
        }
        Update: {
          created_at?: string
          file_name?: string
          id?: string
          message_id?: string
          mime_type?: string | null
          size_bytes?: number | null
          storage_path?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_attachments_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
        ]
      }
      message_plays: {
        Row: {
          conversation_id: string
          employee_id: string
          message_id: string
          played_at: string
        }
        Insert: {
          conversation_id: string
          employee_id: string
          message_id: string
          played_at?: string
        }
        Update: {
          conversation_id?: string
          employee_id?: string
          message_id?: string
          played_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_plays_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_plays_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_plays_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
        ]
      }
      message_reactions: {
        Row: {
          created_at: string
          emoji: string
          employee_id: string
          message_id: string
        }
        Insert: {
          created_at?: string
          emoji: string
          employee_id: string
          message_id: string
        }
        Update: {
          created_at?: string
          emoji?: string
          employee_id?: string
          message_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_reactions_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_reactions_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
        ]
      }
      message_reads: {
        Row: {
          conversation_id: string
          employee_id: string
          message_id: string
          read_at: string
        }
        Insert: {
          conversation_id: string
          employee_id: string
          message_id: string
          read_at?: string
        }
        Update: {
          conversation_id?: string
          employee_id?: string
          message_id?: string
          read_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_reads_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_reads_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_reads_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          body: string
          body_search: unknown
          conversation_id: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          id: string
          kind: string
          metadata: Json
          parent_id: string | null
          sender_id: string | null
          sender_portal: string | null
        }
        Insert: {
          body?: string
          body_search?: unknown
          conversation_id: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          kind?: string
          metadata?: Json
          parent_id?: string | null
          sender_id?: string | null
          sender_portal?: string | null
        }
        Update: {
          body?: string
          body_search?: unknown
          conversation_id?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          kind?: string
          metadata?: Json
          parent_id?: string | null
          sender_id?: string | null
          sender_portal?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_sender_id_fkey"
            columns: ["sender_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          created_at: string | null
          employee_id: string | null
          id: string
          link: string | null
          message: string | null
          read: boolean | null
          source_key: string | null
          title: string
          type: string
        }
        Insert: {
          created_at?: string | null
          employee_id?: string | null
          id?: string
          link?: string | null
          message?: string | null
          read?: boolean | null
          source_key?: string | null
          title: string
          type: string
        }
        Update: {
          created_at?: string | null
          employee_id?: string | null
          id?: string
          link?: string | null
          message?: string | null
          read?: boolean | null
          source_key?: string | null
          title?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      offer_badges: {
        Row: {
          color: string
          created_at: string
          display_order: number
          id: string
          is_active: boolean
          label: string
        }
        Insert: {
          color?: string
          created_at?: string
          display_order?: number
          id?: string
          is_active?: boolean
          label: string
        }
        Update: {
          color?: string
          created_at?: string
          display_order?: number
          id?: string
          is_active?: boolean
          label?: string
        }
        Relationships: []
      }
      offer_campaigns: {
        Row: {
          client_id: string
          created_at: string
          date_type: string
          id: string
          offer_date: string | null
          offer_date_from: string | null
          offer_date_to: string | null
          offer_token: string
          sheet_last_synced_at: string | null
          sheet_sync_error: string | null
          status: string
          title: string | null
          updated_at: string
        }
        Insert: {
          client_id: string
          created_at?: string
          date_type?: string
          id?: string
          offer_date?: string | null
          offer_date_from?: string | null
          offer_date_to?: string | null
          offer_token?: string
          sheet_last_synced_at?: string | null
          sheet_sync_error?: string | null
          status?: string
          title?: string | null
          updated_at?: string
        }
        Update: {
          client_id?: string
          created_at?: string
          date_type?: string
          id?: string
          offer_date?: string | null
          offer_date_from?: string | null
          offer_date_to?: string | null
          offer_token?: string
          sheet_last_synced_at?: string | null
          sheet_sync_error?: string | null
          status?: string
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "offer_campaigns_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      offer_change_logs: {
        Row: {
          acknowledged: boolean
          acknowledged_at: string | null
          acknowledged_by: string | null
          campaign_id: string
          created_at: string
          field: string | null
          id: string
          log_type: string
          new_value: string | null
          note: string | null
          old_value: string | null
          product_id: string | null
          product_name: string | null
        }
        Insert: {
          acknowledged?: boolean
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          campaign_id: string
          created_at?: string
          field?: string | null
          id?: string
          log_type: string
          new_value?: string | null
          note?: string | null
          old_value?: string | null
          product_id?: string | null
          product_name?: string | null
        }
        Update: {
          acknowledged?: boolean
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          campaign_id?: string
          created_at?: string
          field?: string | null
          id?: string
          log_type?: string
          new_value?: string | null
          note?: string | null
          old_value?: string | null
          product_id?: string | null
          product_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "offer_change_logs_acknowledged_by_fkey"
            columns: ["acknowledged_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "offer_change_logs_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "offer_campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "offer_change_logs_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "offer_products"
            referencedColumns: ["id"]
          },
        ]
      }
      offer_product_badges: {
        Row: {
          badge_id: string | null
          color: string
          created_at: string
          custom_label: string | null
          display_order: number
          id: string
          product_id: string
        }
        Insert: {
          badge_id?: string | null
          color?: string
          created_at?: string
          custom_label?: string | null
          display_order?: number
          id?: string
          product_id: string
        }
        Update: {
          badge_id?: string | null
          color?: string
          created_at?: string
          custom_label?: string | null
          display_order?: number
          id?: string
          product_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "offer_product_badges_badge_id_fkey"
            columns: ["badge_id"]
            isOneToOne: false
            referencedRelation: "offer_badges"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "offer_product_badges_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "offer_products"
            referencedColumns: ["id"]
          },
        ]
      }
      offer_products: {
        Row: {
          badge_id: string | null
          campaign_id: string
          catalog_id: string | null
          created_at: string
          display_order: number
          id: string
          image_url: string | null
          mrp: number | null
          name: string
          offer_text: string | null
          offer_type: string
          page: number
          price: number | null
          updated_at: string
          weight: string | null
        }
        Insert: {
          badge_id?: string | null
          campaign_id: string
          catalog_id?: string | null
          created_at?: string
          display_order?: number
          id?: string
          image_url?: string | null
          mrp?: number | null
          name: string
          offer_text?: string | null
          offer_type?: string
          page?: number
          price?: number | null
          updated_at?: string
          weight?: string | null
        }
        Update: {
          badge_id?: string | null
          campaign_id?: string
          catalog_id?: string | null
          created_at?: string
          display_order?: number
          id?: string
          image_url?: string | null
          mrp?: number | null
          name?: string
          offer_text?: string | null
          offer_type?: string
          page?: number
          price?: number | null
          updated_at?: string
          weight?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "offer_products_badge_id_fkey"
            columns: ["badge_id"]
            isOneToOne: false
            referencedRelation: "offer_badges"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "offer_products_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "offer_campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "offer_products_catalog_id_fkey"
            columns: ["catalog_id"]
            isOneToOne: false
            referencedRelation: "client_product_catalog"
            referencedColumns: ["id"]
          },
        ]
      }
      parameter_services: {
        Row: {
          parameter_id: string
          service_id: string
        }
        Insert: {
          parameter_id: string
          service_id: string
        }
        Update: {
          parameter_id?: string
          service_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "parameter_services_parameter_id_fkey"
            columns: ["parameter_id"]
            isOneToOne: false
            referencedRelation: "parameters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parameter_services_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      parameters: {
        Row: {
          created_at: string | null
          description: string | null
          display_order: number | null
          group_id: string | null
          id: string
          input_type: string
          is_active: boolean | null
          is_master: boolean
          name: string
          updated_at: string | null
          weight: number | null
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          display_order?: number | null
          group_id?: string | null
          id?: string
          input_type?: string
          is_active?: boolean | null
          is_master?: boolean
          name: string
          updated_at?: string | null
          weight?: number | null
        }
        Update: {
          created_at?: string | null
          description?: string | null
          display_order?: number | null
          group_id?: string | null
          id?: string
          input_type?: string
          is_active?: boolean | null
          is_master?: boolean
          name?: string
          updated_at?: string | null
          weight?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "parameters_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "contribution_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount: number
          amount_inr: number | null
          bank_account_id: string | null
          created_at: string | null
          currency: string
          exchange_rate: number
          id: string
          invoice_id: string | null
          notes: string | null
          payment_date: string
          payment_method: string | null
          rate_date: string | null
          rate_source: string
          reference: string | null
        }
        Insert: {
          amount: number
          amount_inr?: number | null
          bank_account_id?: string | null
          created_at?: string | null
          currency?: string
          exchange_rate?: number
          id?: string
          invoice_id?: string | null
          notes?: string | null
          payment_date?: string
          payment_method?: string | null
          rate_date?: string | null
          rate_source?: string
          reference?: string | null
        }
        Update: {
          amount?: number
          amount_inr?: number | null
          bank_account_id?: string | null
          created_at?: string | null
          currency?: string
          exchange_rate?: number
          id?: string
          invoice_id?: string | null
          notes?: string | null
          payment_date?: string
          payment_method?: string | null
          rate_date?: string | null
          rate_source?: string
          reference?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payments_bank_account_id_fkey"
            columns: ["bank_account_id"]
            isOneToOne: false
            referencedRelation: "bank_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      payroll: {
        Row: {
          advances_deducted: number | null
          base_salary: number | null
          bonus: number | null
          commission_earned: number | null
          created_at: string | null
          employee_id: string | null
          id: string
          month: number
          net_salary: number | null
          notes: string | null
          other_deductions: number | null
          paid_date: string | null
          payslip_number: string | null
          status: string | null
          updated_at: string | null
          year: number
        }
        Insert: {
          advances_deducted?: number | null
          base_salary?: number | null
          bonus?: number | null
          commission_earned?: number | null
          created_at?: string | null
          employee_id?: string | null
          id?: string
          month: number
          net_salary?: number | null
          notes?: string | null
          other_deductions?: number | null
          paid_date?: string | null
          payslip_number?: string | null
          status?: string | null
          updated_at?: string | null
          year: number
        }
        Update: {
          advances_deducted?: number | null
          base_salary?: number | null
          bonus?: number | null
          commission_earned?: number | null
          created_at?: string | null
          employee_id?: string | null
          id?: string
          month?: number
          net_salary?: number | null
          notes?: string | null
          other_deductions?: number | null
          paid_date?: string | null
          payslip_number?: string | null
          status?: string | null
          updated_at?: string | null
          year?: number
        }
        Relationships: [
          {
            foreignKeyName: "payroll_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      payslip_emails: {
        Row: {
          employee_id: string
          error: string | null
          id: string
          month: number
          resend_id: string | null
          sent_at: string
          sent_by: string | null
          sent_to: string
          snapshot: Json | null
          status: string
          subject: string
          year: number
        }
        Insert: {
          employee_id: string
          error?: string | null
          id?: string
          month: number
          resend_id?: string | null
          sent_at?: string
          sent_by?: string | null
          sent_to: string
          snapshot?: Json | null
          status?: string
          subject: string
          year: number
        }
        Update: {
          employee_id?: string
          error?: string | null
          id?: string
          month?: number
          resend_id?: string | null
          sent_at?: string
          sent_by?: string | null
          sent_to?: string
          snapshot?: Json | null
          status?: string
          subject?: string
          year?: number
        }
        Relationships: [
          {
            foreignKeyName: "payslip_emails_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payslip_emails_sent_by_fkey"
            columns: ["sent_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      performance_metrics: {
        Row: {
          active_days: number | null
          avg_score: number | null
          created_at: string | null
          employee_id: string | null
          id: string
          month: number
          quality_0_25: number | null
          quality_100: number | null
          quality_26_50: number | null
          quality_51_75: number | null
          quality_76_99: number | null
          suggested_rating: number | null
          suggestion_reason: string | null
          total_creatives: number | null
          total_tasks: number | null
          year: number
        }
        Insert: {
          active_days?: number | null
          avg_score?: number | null
          created_at?: string | null
          employee_id?: string | null
          id?: string
          month: number
          quality_0_25?: number | null
          quality_100?: number | null
          quality_26_50?: number | null
          quality_51_75?: number | null
          quality_76_99?: number | null
          suggested_rating?: number | null
          suggestion_reason?: string | null
          total_creatives?: number | null
          total_tasks?: number | null
          year: number
        }
        Update: {
          active_days?: number | null
          avg_score?: number | null
          created_at?: string | null
          employee_id?: string | null
          id?: string
          month?: number
          quality_0_25?: number | null
          quality_100?: number | null
          quality_26_50?: number | null
          quality_51_75?: number | null
          quality_76_99?: number | null
          suggested_rating?: number | null
          suggestion_reason?: string | null
          total_creatives?: number | null
          total_tasks?: number | null
          year?: number
        }
        Relationships: [
          {
            foreignKeyName: "performance_metrics_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      permissions: {
        Row: {
          action: string
          description: string | null
          display_order: number | null
          id: string
          key: string
          label: string
          module: string
        }
        Insert: {
          action: string
          description?: string | null
          display_order?: number | null
          id?: string
          key: string
          label: string
          module: string
        }
        Update: {
          action?: string
          description?: string | null
          display_order?: number | null
          id?: string
          key?: string
          label?: string
          module?: string
        }
        Relationships: []
      }
      product_catalog: {
        Row: {
          barcode: string | null
          brand: string | null
          category: string | null
          created_at: string
          id: string
          image_url: string | null
          name: string
          notes: string | null
          product_code: string
          status: string
          updated_at: string
          weight: string | null
        }
        Insert: {
          barcode?: string | null
          brand?: string | null
          category?: string | null
          created_at?: string
          id?: string
          image_url?: string | null
          name: string
          notes?: string | null
          product_code?: string
          status?: string
          updated_at?: string
          weight?: string | null
        }
        Update: {
          barcode?: string | null
          brand?: string | null
          category?: string | null
          created_at?: string
          id?: string
          image_url?: string | null
          name?: string
          notes?: string | null
          product_code?: string
          status?: string
          updated_at?: string
          weight?: string | null
        }
        Relationships: []
      }
      product_catalog_images: {
        Row: {
          created_at: string
          id: string
          is_primary: boolean
          product_id: string
          source: string
          storage_path: string | null
          url: string
          version: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_primary?: boolean
          product_id: string
          source?: string
          storage_path?: string | null
          url: string
          version?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_primary?: boolean
          product_id?: string
          source?: string
          storage_path?: string | null
          url?: string
          version?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_catalog_images_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "product_catalog"
            referencedColumns: ["id"]
          },
        ]
      }
      profile_change_requests: {
        Row: {
          changes: Json
          employee_id: string
          id: string
          rejection_reason: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          submitted_at: string | null
        }
        Insert: {
          changes: Json
          employee_id: string
          id?: string
          rejection_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          submitted_at?: string | null
        }
        Update: {
          changes?: Json
          employee_id?: string
          id?: string
          rejection_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          submitted_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "profile_change_requests_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profile_change_requests_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      provider_connections: {
        Row: {
          access_token: string | null
          client_id: string
          connected_by: string | null
          created_at: string
          id: string
          last_auth_at: string | null
          provider: string
          refresh_time: string | null
          refresh_token: string | null
          status: string
          token_expires_at: string | null
          updated_at: string
        }
        Insert: {
          access_token?: string | null
          client_id: string
          connected_by?: string | null
          created_at?: string
          id?: string
          last_auth_at?: string | null
          provider: string
          refresh_time?: string | null
          refresh_token?: string | null
          status?: string
          token_expires_at?: string | null
          updated_at?: string
        }
        Update: {
          access_token?: string | null
          client_id?: string
          connected_by?: string | null
          created_at?: string
          id?: string
          last_auth_at?: string | null
          provider?: string
          refresh_time?: string | null
          refresh_token?: string | null
          status?: string
          token_expires_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "provider_connections_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "provider_connections_connected_by_fkey"
            columns: ["connected_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      push_subscriptions: {
        Row: {
          auth: string
          created_at: string
          employee_id: string
          endpoint: string
          id: string
          last_used_at: string | null
          p256dh: string
          user_agent: string | null
        }
        Insert: {
          auth: string
          created_at?: string
          employee_id: string
          endpoint: string
          id?: string
          last_used_at?: string | null
          p256dh: string
          user_agent?: string | null
        }
        Update: {
          auth?: string
          created_at?: string
          employee_id?: string
          endpoint?: string
          id?: string
          last_used_at?: string | null
          p256dh?: string
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "push_subscriptions_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      quotation_items: {
        Row: {
          currency: string | null
          description: string
          display_order: number | null
          id: string
          quantity: number | null
          quotation_id: string | null
          service_id: string | null
          total: number | null
          unit_price: number | null
        }
        Insert: {
          currency?: string | null
          description: string
          display_order?: number | null
          id?: string
          quantity?: number | null
          quotation_id?: string | null
          service_id?: string | null
          total?: number | null
          unit_price?: number | null
        }
        Update: {
          currency?: string | null
          description?: string
          display_order?: number | null
          id?: string
          quantity?: number | null
          quotation_id?: string | null
          service_id?: string | null
          total?: number | null
          unit_price?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "quotation_items_quotation_id_fkey"
            columns: ["quotation_id"]
            isOneToOne: false
            referencedRelation: "quotations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotation_items_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      quotations: {
        Row: {
          client_id: string | null
          created_at: string | null
          created_by: string | null
          currency: string | null
          id: string
          issue_date: string
          notes: string | null
          quotation_number: string
          status: string | null
          terms: string | null
          total_amount: number | null
          updated_at: string | null
          valid_until: string | null
        }
        Insert: {
          client_id?: string | null
          created_at?: string | null
          created_by?: string | null
          currency?: string | null
          id?: string
          issue_date?: string
          notes?: string | null
          quotation_number: string
          status?: string | null
          terms?: string | null
          total_amount?: number | null
          updated_at?: string | null
          valid_until?: string | null
        }
        Update: {
          client_id?: string | null
          created_at?: string | null
          created_by?: string | null
          currency?: string | null
          id?: string
          issue_date?: string
          notes?: string | null
          quotation_number?: string
          status?: string | null
          terms?: string | null
          total_amount?: number | null
          updated_at?: string | null
          valid_until?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "quotations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotations_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      receipt_number_sequences: {
        Row: {
          month_key: string
          next_seq: number
        }
        Insert: {
          month_key: string
          next_seq?: number
        }
        Update: {
          month_key?: string
          next_seq?: number
        }
        Relationships: []
      }
      report_layouts: {
        Row: {
          created_at: string | null
          id: string
          is_system_default: boolean
          layout_json: Json
          report_name: string
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          is_system_default?: boolean
          layout_json?: Json
          report_name: string
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          is_system_default?: boolean
          layout_json?: Json
          report_name?: string
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "report_layouts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      request_activity: {
        Row: {
          action: string
          actor_id: string | null
          actor_label: string | null
          actor_type: string
          created_at: string
          detail: Json | null
          id: string
          request_id: string
          visibility: string
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_label?: string | null
          actor_type?: string
          created_at?: string
          detail?: Json | null
          id?: string
          request_id: string
          visibility?: string
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_label?: string | null
          actor_type?: string
          created_at?: string
          detail?: Json | null
          id?: string
          request_id?: string
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "request_activity_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "task_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      request_revisions: {
        Row: {
          created_at: string
          id: string
          link: string | null
          note: string
          request_id: string
          requested_by_type: string
          resolved_at: string | null
          status: string
        }
        Insert: {
          created_at?: string
          id?: string
          link?: string | null
          note: string
          request_id: string
          requested_by_type?: string
          resolved_at?: string | null
          status?: string
        }
        Update: {
          created_at?: string
          id?: string
          link?: string | null
          note?: string
          request_id?: string
          requested_by_type?: string
          resolved_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "request_revisions_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "task_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      salary_advances: {
        Row: {
          advance_date: string
          amount: number
          created_at: string | null
          employee_id: string | null
          id: string
          notes: string | null
          reason: string | null
          repayment_type: string | null
          status: string | null
        }
        Insert: {
          advance_date?: string
          amount: number
          created_at?: string | null
          employee_id?: string | null
          id?: string
          notes?: string | null
          reason?: string | null
          repayment_type?: string | null
          status?: string | null
        }
        Update: {
          advance_date?: string
          amount?: number
          created_at?: string | null
          employee_id?: string | null
          id?: string
          notes?: string | null
          reason?: string | null
          repayment_type?: string | null
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "salary_advances_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      scenario_snapshot_records: {
        Row: {
          id: string
          new_values: Json
          old_values: Json
          record_id: string
          snapshot_id: string
          table_name: string
        }
        Insert: {
          id?: string
          new_values: Json
          old_values: Json
          record_id: string
          snapshot_id: string
          table_name: string
        }
        Update: {
          id?: string
          new_values?: Json
          old_values?: Json
          record_id?: string
          snapshot_id?: string
          table_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "scenario_snapshot_records_snapshot_id_fkey"
            columns: ["snapshot_id"]
            isOneToOne: false
            referencedRelation: "scenario_snapshots"
            referencedColumns: ["id"]
          },
        ]
      }
      scenario_snapshots: {
        Row: {
          applied_at: string | null
          applied_by: string | null
          created_at: string | null
          created_by: string | null
          id: string
          notes: string | null
          record_count: number
          scenario_json: Json
          scenario_name: string
        }
        Insert: {
          applied_at?: string | null
          applied_by?: string | null
          created_at?: string | null
          created_by?: string | null
          id?: string
          notes?: string | null
          record_count?: number
          scenario_json: Json
          scenario_name: string
        }
        Update: {
          applied_at?: string | null
          applied_by?: string | null
          created_at?: string | null
          created_by?: string | null
          id?: string
          notes?: string | null
          record_count?: number
          scenario_json?: Json
          scenario_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "scenario_snapshots_applied_by_fkey"
            columns: ["applied_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scenario_snapshots_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      services: {
        Row: {
          created_at: string | null
          default_currency: string | null
          default_price: number | null
          default_variant_pricing: Json
          description: string | null
          display_order: number | null
          id: string
          intake_kind: string
          is_active: boolean | null
          name: string
          pricing_pending: boolean
          pricing_type: string
          retainer_cycle: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          default_currency?: string | null
          default_price?: number | null
          default_variant_pricing?: Json
          description?: string | null
          display_order?: number | null
          id?: string
          intake_kind?: string
          is_active?: boolean | null
          name: string
          pricing_pending?: boolean
          pricing_type?: string
          retainer_cycle?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          default_currency?: string | null
          default_price?: number | null
          default_variant_pricing?: Json
          description?: string | null
          display_order?: number | null
          id?: string
          intake_kind?: string
          is_active?: boolean | null
          name?: string
          pricing_pending?: boolean
          pricing_type?: string
          retainer_cycle?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      system_jobs: {
        Row: {
          attempts: number | null
          created_at: string
          error_log: string | null
          finished_at: string | null
          id: string
          job_type: string
          max_attempts: number | null
          payload: Json | null
          priority: string
          queued_at: string
          started_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          attempts?: number | null
          created_at?: string
          error_log?: string | null
          finished_at?: string | null
          id?: string
          job_type: string
          max_attempts?: number | null
          payload?: Json | null
          priority?: string
          queued_at?: string
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          attempts?: number | null
          created_at?: string
          error_log?: string | null
          finished_at?: string | null
          id?: string
          job_type?: string
          max_attempts?: number | null
          payload?: Json | null
          priority?: string
          queued_at?: string
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      task_assignments: {
        Row: {
          created_at: string
          employee_id: string
          id: string
          task_id: string
        }
        Insert: {
          created_at?: string
          employee_id: string
          id?: string
          task_id: string
        }
        Update: {
          created_at?: string
          employee_id?: string
          id?: string
          task_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_assignments_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_assignments_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      task_requests: {
        Row: {
          ad_meta: Json | null
          agency_id: string | null
          archived_at: string | null
          assigned_employee_id: string | null
          client_id: string | null
          client_status: string
          content_link: string | null
          created_at: string
          deliverables_link: string | null
          description: string | null
          design_plan: string | null
          drive_folder_link: string | null
          due_date: string | null
          estimated_value: number | null
          extra_links: Json
          id: string
          internal_notes: string | null
          is_planned: boolean
          last_external_activity_at: string | null
          last_staff_viewed_at: string | null
          link_id: string | null
          priority: string
          priority_rank: number | null
          promoted_at: string | null
          promoted_by: string | null
          promoted_task_id: string | null
          ref_no: number
          reference_link: string | null
          remarks: string | null
          service_id: string | null
          source: string
          status: string
          status_updated_at: string
          submitter_email: string | null
          submitter_name: string | null
          submitter_phone: string | null
          title: string
          track_token: string
          updated_at: string
        }
        Insert: {
          ad_meta?: Json | null
          agency_id?: string | null
          archived_at?: string | null
          assigned_employee_id?: string | null
          client_id?: string | null
          client_status?: string
          content_link?: string | null
          created_at?: string
          deliverables_link?: string | null
          description?: string | null
          design_plan?: string | null
          drive_folder_link?: string | null
          due_date?: string | null
          estimated_value?: number | null
          extra_links?: Json
          id?: string
          internal_notes?: string | null
          is_planned?: boolean
          last_external_activity_at?: string | null
          last_staff_viewed_at?: string | null
          link_id?: string | null
          priority?: string
          priority_rank?: number | null
          promoted_at?: string | null
          promoted_by?: string | null
          promoted_task_id?: string | null
          ref_no?: never
          reference_link?: string | null
          remarks?: string | null
          service_id?: string | null
          source?: string
          status?: string
          status_updated_at?: string
          submitter_email?: string | null
          submitter_name?: string | null
          submitter_phone?: string | null
          title: string
          track_token?: string
          updated_at?: string
        }
        Update: {
          ad_meta?: Json | null
          agency_id?: string | null
          archived_at?: string | null
          assigned_employee_id?: string | null
          client_id?: string | null
          client_status?: string
          content_link?: string | null
          created_at?: string
          deliverables_link?: string | null
          description?: string | null
          design_plan?: string | null
          drive_folder_link?: string | null
          due_date?: string | null
          estimated_value?: number | null
          extra_links?: Json
          id?: string
          internal_notes?: string | null
          is_planned?: boolean
          last_external_activity_at?: string | null
          last_staff_viewed_at?: string | null
          link_id?: string | null
          priority?: string
          priority_rank?: number | null
          promoted_at?: string | null
          promoted_by?: string | null
          promoted_task_id?: string | null
          ref_no?: never
          reference_link?: string | null
          remarks?: string | null
          service_id?: string | null
          source?: string
          status?: string
          status_updated_at?: string
          submitter_email?: string | null
          submitter_name?: string | null
          submitter_phone?: string | null
          title?: string
          track_token?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_requests_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_requests_assigned_employee_id_fkey"
            columns: ["assigned_employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_requests_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_requests_link_id_fkey"
            columns: ["link_id"]
            isOneToOne: false
            referencedRelation: "intake_links"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_requests_promoted_by_fkey"
            columns: ["promoted_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_requests_promoted_task_id_fkey"
            columns: ["promoted_task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_requests_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      task_tools: {
        Row: {
          created_at: string | null
          id: string
          task_id: string | null
          tool_id: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          task_id?: string | null
          tool_id?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          task_id?: string | null
          tool_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "task_tools_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_tools_tool_id_fkey"
            columns: ["tool_id"]
            isOneToOne: false
            referencedRelation: "tools"
            referencedColumns: ["id"]
          },
        ]
      }
      tasks: {
        Row: {
          billing_amount: number | null
          billing_amount_inr: number | null
          billing_exchange_rate: number | null
          billing_mode: string
          billing_override: boolean
          billing_percent: number | null
          billing_snapshot: Json | null
          cancellation_notes: string | null
          cancelled_by: string | null
          client_id: string | null
          completion_pct: number | null
          contributions_locked: boolean | null
          created_at: string | null
          created_by: string | null
          currency: string | null
          deleted_at: string | null
          description: string | null
          honor_contributions: boolean | null
          id: string
          is_billable: boolean
          is_recurring: boolean | null
          loss_amount: number | null
          parent_task_id: string | null
          quantity: number | null
          recurring_end_date: string | null
          recurring_interval: string | null
          recurring_parent_id: string | null
          service_id: string | null
          status: string | null
          task_date: string
          task_number: number | null
          title: string
          updated_at: string | null
          variant_label: string | null
          variant_type: string | null
        }
        Insert: {
          billing_amount?: number | null
          billing_amount_inr?: number | null
          billing_exchange_rate?: number | null
          billing_mode?: string
          billing_override?: boolean
          billing_percent?: number | null
          billing_snapshot?: Json | null
          cancellation_notes?: string | null
          cancelled_by?: string | null
          client_id?: string | null
          completion_pct?: number | null
          contributions_locked?: boolean | null
          created_at?: string | null
          created_by?: string | null
          currency?: string | null
          deleted_at?: string | null
          description?: string | null
          honor_contributions?: boolean | null
          id?: string
          is_billable?: boolean
          is_recurring?: boolean | null
          loss_amount?: number | null
          parent_task_id?: string | null
          quantity?: number | null
          recurring_end_date?: string | null
          recurring_interval?: string | null
          recurring_parent_id?: string | null
          service_id?: string | null
          status?: string | null
          task_date?: string
          task_number?: number | null
          title: string
          updated_at?: string | null
          variant_label?: string | null
          variant_type?: string | null
        }
        Update: {
          billing_amount?: number | null
          billing_amount_inr?: number | null
          billing_exchange_rate?: number | null
          billing_mode?: string
          billing_override?: boolean
          billing_percent?: number | null
          billing_snapshot?: Json | null
          cancellation_notes?: string | null
          cancelled_by?: string | null
          client_id?: string | null
          completion_pct?: number | null
          contributions_locked?: boolean | null
          created_at?: string | null
          created_by?: string | null
          currency?: string | null
          deleted_at?: string | null
          description?: string | null
          honor_contributions?: boolean | null
          id?: string
          is_billable?: boolean
          is_recurring?: boolean | null
          loss_amount?: number | null
          parent_task_id?: string | null
          quantity?: number | null
          recurring_end_date?: string | null
          recurring_interval?: string | null
          recurring_parent_id?: string | null
          service_id?: string | null
          status?: string | null
          task_date?: string
          task_number?: number | null
          title?: string
          updated_at?: string | null
          variant_label?: string | null
          variant_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tasks_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_parent_task_id_fkey"
            columns: ["parent_task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_recurring_parent_id_fkey"
            columns: ["recurring_parent_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      tool_services: {
        Row: {
          service_id: string
          tool_id: string
        }
        Insert: {
          service_id: string
          tool_id: string
        }
        Update: {
          service_id?: string
          tool_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tool_services_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tool_services_tool_id_fkey"
            columns: ["tool_id"]
            isOneToOne: false
            referencedRelation: "tools"
            referencedColumns: ["id"]
          },
        ]
      }
      tools: {
        Row: {
          created_at: string | null
          description: string | null
          fixed_percentage: number
          group_id: string | null
          id: string
          is_active: boolean | null
          name: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          fixed_percentage?: number
          group_id?: string | null
          id?: string
          is_active?: boolean | null
          name: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          description?: string | null
          fixed_percentage?: number
          group_id?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tools_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "contribution_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_items: {
        Row: {
          body: string | null
          conversation_id: string | null
          created_at: string
          done_at: string | null
          due_date: string | null
          employee_id: string
          id: string
          is_done: boolean
          kind: string
          ref_id: string | null
          ref_type: string | null
          remind_at: string | null
          reminded_at: string | null
          sort_order: number
          title: string
          updated_at: string
        }
        Insert: {
          body?: string | null
          conversation_id?: string | null
          created_at?: string
          done_at?: string | null
          due_date?: string | null
          employee_id: string
          id?: string
          is_done?: boolean
          kind?: string
          ref_id?: string | null
          ref_type?: string | null
          remind_at?: string | null
          reminded_at?: string | null
          sort_order?: number
          title: string
          updated_at?: string
        }
        Update: {
          body?: string | null
          conversation_id?: string | null
          created_at?: string
          done_at?: string | null
          due_date?: string | null
          employee_id?: string
          id?: string
          is_done?: boolean
          kind?: string
          ref_id?: string | null
          ref_type?: string | null
          remind_at?: string | null
          reminded_at?: string | null
          sort_order?: number
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_items_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_items_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_members: {
        Row: {
          added_at: string
          employee_id: string
          workspace_id: string
        }
        Insert: {
          added_at?: string
          employee_id: string
          workspace_id: string
        }
        Update: {
          added_at?: string
          employee_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_members_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_members_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          color: string
          created_at: string
          created_by: string | null
          dashboard_widget_keys: string[] | null
          default_landing_href: string
          icon: string
          id: string
          is_system: boolean
          name: string
          sidebar_module_hrefs: string[] | null
          updated_at: string
        }
        Insert: {
          color?: string
          created_at?: string
          created_by?: string | null
          dashboard_widget_keys?: string[] | null
          default_landing_href?: string
          icon?: string
          id?: string
          is_system?: boolean
          name: string
          sidebar_module_hrefs?: string[] | null
          updated_at?: string
        }
        Update: {
          color?: string
          created_at?: string
          created_by?: string | null
          dashboard_widget_keys?: string[] | null
          default_landing_href?: string
          icon?: string
          id?: string
          is_system?: boolean
          name?: string
          sidebar_module_hrefs?: string[] | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspaces_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      invoice_summary: {
        Row: {
          client_code: string | null
          client_name: string | null
          total_billed: number | null
          total_invoices: number | null
          total_outstanding: number | null
          total_received: number | null
        }
        Relationships: []
      }
      monthly_cashbook_summary: {
        Row: {
          month: number | null
          net: number | null
          total_inflow: number | null
          total_outflow: number | null
          year: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      apply_invoice_payment: {
        Args: { p_amount: number; p_invoice_id: string }
        Returns: undefined
      }
      assign_org_creator_role: {
        Args: { p_org_id: string }
        Returns: undefined
      }
      assign_org_invite_role: {
        Args: { p_org_id: string; p_role: string }
        Returns: undefined
      }
      current_employee_designation_has: {
        Args: { perm_key: string }
        Returns: boolean
      }
      current_employee_id: { Args: never; Returns: string }
      current_user_org_id: { Args: never; Returns: string }
      current_user_role: { Args: never; Returns: string }
      dequeue_jobs: {
        Args: { p_max_jobs?: number; p_worker_id: string }
        Returns: {
          attempts: number | null
          created_at: string
          error_log: string | null
          finished_at: string | null
          id: string
          job_type: string
          max_attempts: number | null
          payload: Json | null
          priority: string
          queued_at: string
          started_at: string | null
          status: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "system_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      find_or_create_client_month_draft: {
        Args: {
          p_client_id: string
          p_currency: string
          p_exchange_rate: number
          p_period: string
        }
        Returns: string
      }
      generate_hr_reference_number: {
        Args: { p_date?: string }
        Returns: string
      }
      generate_receipt_number: {
        Args: { p_client_code?: string; p_entry_date: string }
        Returns: string
      }
      is_conversation_member: { Args: { conv_id: string }; Returns: boolean }
      is_current_employee_admin: { Args: never; Returns: boolean }
      next_cqid: { Args: never; Returns: string }
      rate_to_inr_for: { Args: { p_currency: string }; Returns: number }
      recalc_invoice_totals: {
        Args: { p_invoice_id: string }
        Returns: undefined
      }
      recalculate_invoice: {
        Args: { p_invoice_id: string }
        Returns: undefined
      }
      recompute_invoice_from_allocations: {
        Args: { p_invoice_id: string }
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

CREATE TABLE "ai_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"engine" text NOT NULL,
	"model" text,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"error_class" text,
	"error" text,
	"latency_ms" integer NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	"total_tokens" integer,
	"prompt_chars" integer,
	"prompt_sha256" text,
	"request_id" text,
	"user_email" text,
	"meta" jsonb
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"seq" serial NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_space_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"email" text NOT NULL,
	"shown" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hidden" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chats" (
	"id" text PRIMARY KEY NOT NULL,
	"user_email" text NOT NULL,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dispatch_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 1 NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"payload_text" text,
	"payload_meta" jsonb,
	"prompt_chars" integer,
	"prompt_sha256" text,
	"leased_by" text,
	"leased_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone,
	"result_text" text,
	"result_meta" jsonb,
	"error_class" text,
	"error" text,
	"latency_ms" integer,
	"finished_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"scrubbed_at" timestamp with time zone,
	"request_id" text
);
--> statement-breakpoint
CREATE TABLE "dispatch_workers" (
	"id" text PRIMARY KEY NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" text,
	"agy_version" text,
	"meta" jsonb
);
--> statement-breakpoint
CREATE TABLE "drive_workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"email" text NOT NULL,
	"root_folder_id" text NOT NULL,
	"folders" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_verified_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "focus_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"email" text NOT NULL,
	"vips" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"goals" text DEFAULT '' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "google_oauth_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"email" text NOT NULL,
	"refresh_token" text NOT NULL,
	"scope" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "google_prefs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"ga4_property_id" text,
	"gsc_site_url" text,
	"bigquery_project_id" text,
	"gbp_account_id" text,
	"gbp_location_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reports" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"timezone" text,
	"updated_by" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hub_secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"company_id" text NOT NULL,
	"name" text NOT NULL,
	"ciphertext" text NOT NULL,
	"key_id" text NOT NULL,
	"provider" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"report_id" text NOT NULL,
	"window_start" text NOT NULL,
	"window_end" text,
	"document_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tool" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"brief" text NOT NULL,
	"inputs" jsonb,
	"result_md" text,
	"error_class" text,
	"error" text,
	"user_email" text NOT NULL,
	"chat_id" text,
	"job_id" uuid,
	"attempt" integer DEFAULT 0 NOT NULL,
	"model" text,
	"latency_ms" integer,
	"usage" jsonb,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"resource_id" text NOT NULL,
	"page_token" text,
	"expiration" timestamp with time zone NOT NULL,
	"address" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_chunks" ADD COLUMN "embedding_model" text;--> statement-breakpoint
ALTER TABLE "hub_users" ADD COLUMN "google_refresh_token" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_space_preferences" ADD CONSTRAINT "chat_space_preferences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_workspaces" ADD CONSTRAINT "drive_workspaces_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "focus_preferences" ADD CONSTRAINT "focus_preferences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_oauth_tokens" ADD CONSTRAINT "google_oauth_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_prefs" ADD CONSTRAINT "google_prefs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_secrets" ADD CONSTRAINT "hub_secrets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_channels" ADD CONSTRAINT "webhook_channels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_runs_created_idx" ON "ai_runs" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "chat_messages_chat_seq_idx" ON "chat_messages" USING btree ("chat_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_space_prefs_email_tenant_uniq" ON "chat_space_preferences" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE INDEX "chats_user_updated_idx" ON "chats" USING btree ("user_email","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "dispatch_jobs_claim_idx" ON "dispatch_jobs" USING btree ("state","priority","created_at");--> statement-breakpoint
CREATE INDEX "dispatch_jobs_created_idx" ON "dispatch_jobs" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "drive_workspaces_email_tenant_uniq" ON "drive_workspaces" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "focus_preferences_email_tenant_uniq" ON "focus_preferences" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "google_oauth_tokens_email_tenant_uniq" ON "google_oauth_tokens" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "google_prefs_tenant_uniq" ON "google_prefs" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hub_secrets_scope_name_uniq" ON "hub_secrets" USING btree ("tenant_id","company_id","name");--> statement-breakpoint
CREATE INDEX "hub_secrets_key_id_idx" ON "hub_secrets" USING btree ("key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "report_runs_window_uniq" ON "report_runs" USING btree ("tenant_id","report_id","window_start");--> statement-breakpoint
CREATE INDEX "report_runs_created_idx" ON "report_runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "tool_runs_user_created_idx" ON "tool_runs" USING btree ("user_email","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tool_runs_job_idx" ON "tool_runs" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_channels_tenant_kind_uniq" ON "webhook_channels" USING btree ("tenant_id","kind");--> statement-breakpoint
CREATE INDEX "event_log_type_created_idx" ON "event_log" USING btree ("event_type","created_at");
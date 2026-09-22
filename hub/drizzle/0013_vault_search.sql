CREATE TABLE IF NOT EXISTS "vault_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"corpus" text DEFAULT 'antigravityhq' NOT NULL,
	"vault_path" text NOT NULL,
	"note_title" text,
	"frontmatter" jsonb,
	"content_sha" text NOT NULL,
	"indexed_commit_sha" text,
	"embedding_model" text,
	"source_modified_at" timestamp with time zone,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vault_notes" ADD CONSTRAINT "vault_notes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vault_notes_tenant_corpus_path_uniq" ON "vault_notes" ("tenant_id","corpus","vault_path");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vault_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" uuid NOT NULL,
	"tenant_id" text NOT NULL,
	"corpus" text DEFAULT 'antigravityhq' NOT NULL,
	"vault_path" text NOT NULL,
	"heading_path" text,
	"char_start" integer NOT NULL,
	"char_end" integer NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(768),
	"embedding_model" text,
	"content_sha" text NOT NULL,
	"indexed_commit_sha" text,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vault_chunks" ADD CONSTRAINT "vault_chunks_note_id_vault_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "vault_notes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vault_chunks" ADD CONSTRAINT "vault_chunks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vault_chunks_embedding_hnsw_idx" ON "vault_chunks" USING hnsw ("embedding" vector_cosine_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vault_chunks_note_idx" ON "vault_chunks" ("note_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vault_chunks_scope_idx" ON "vault_chunks" ("tenant_id","corpus","embedding_model");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vault_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"corpus" text DEFAULT 'antigravityhq' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"from_commit" text,
	"to_commit" text,
	"notes_scanned" integer DEFAULT 0 NOT NULL,
	"notes_indexed" integer DEFAULT 0 NOT NULL,
	"notes_failed" integer DEFAULT 0 NOT NULL,
	"failed_paths" jsonb,
	"error" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vault_sync_runs" ADD CONSTRAINT "vault_sync_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vault_sync_runs_started_idx" ON "vault_sync_runs" ("tenant_id","corpus","started_at" DESC);

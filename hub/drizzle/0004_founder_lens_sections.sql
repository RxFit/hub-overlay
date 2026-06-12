CREATE TABLE IF NOT EXISTS "founder_lens_sections" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"org_id" text NOT NULL,
	"role" text NOT NULL,
	"sections" jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "founder_lens_sections" ADD CONSTRAINT "founder_lens_sections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "founder_lens_org_role_uniq" ON "founder_lens_sections" ("tenant_id","org_id","role");

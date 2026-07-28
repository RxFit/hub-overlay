CREATE TABLE IF NOT EXISTS "google_prefs" (
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
DO $$ BEGIN
 ALTER TABLE "google_prefs" ADD CONSTRAINT "google_prefs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "google_prefs_tenant_uniq" ON "google_prefs" ("tenant_id");

CREATE TABLE IF NOT EXISTS "focus_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"email" text NOT NULL,
	"vips" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"goals" text DEFAULT '' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "focus_preferences" ADD CONSTRAINT "focus_preferences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "focus_preferences_email_tenant_uniq" ON "focus_preferences" ("tenant_id","email");

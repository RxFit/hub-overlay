DROP INDEX "tool_runs_user_created_idx";--> statement-breakpoint
ALTER TABLE "tool_runs" ADD COLUMN "tenant_id" text;--> statement-breakpoint
UPDATE "tool_runs" SET "tenant_id" = 'rxfit' WHERE "tenant_id" IS NULL;--> statement-breakpoint
ALTER TABLE "tool_runs" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_runs" ADD CONSTRAINT "tool_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_runs_user_created_idx" ON "tool_runs" USING btree ("tenant_id","user_email","created_at" DESC NULLS LAST);--> statement-breakpoint
DROP INDEX "tool_runs_one_active_per_user";--> statement-breakpoint
CREATE UNIQUE INDEX "tool_runs_one_active_per_user" ON "tool_runs" ("tenant_id","user_email") WHERE status = 'queued';

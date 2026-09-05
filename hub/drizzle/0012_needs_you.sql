ALTER TABLE "tool_runs" ADD COLUMN IF NOT EXISTS "retry_of" uuid;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "queue_dismissals" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_email" text NOT NULL,
	"item_key" text NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "queue_dismissals_user_key_uniq" ON "queue_dismissals" ("tenant_id","user_email","item_key");

CREATE TABLE IF NOT EXISTS "ai_runs" (
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
CREATE INDEX IF NOT EXISTS "ai_runs_created_idx" ON "ai_runs" ("created_at" DESC);

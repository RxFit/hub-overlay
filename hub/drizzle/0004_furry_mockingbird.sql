CREATE TABLE "ai_action_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_email" text,
	"actor" text DEFAULT 'ai' NOT NULL,
	"action_type" text NOT NULL,
	"target" jsonb,
	"intent" text,
	"gate_token_id" text,
	"request_id" text,
	"status" text NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE INDEX "ai_action_log_user_created_idx" ON "ai_action_log" USING btree ("user_email","created_at" DESC NULLS LAST);

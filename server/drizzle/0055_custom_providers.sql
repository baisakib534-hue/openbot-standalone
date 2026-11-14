CREATE TABLE "custom_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"base_url" text NOT NULL,
	"key_variable" text NOT NULL,
	"default_model" text NOT NULL,
	"api" text DEFAULT 'chat' NOT NULL,
	"base_url_variable" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

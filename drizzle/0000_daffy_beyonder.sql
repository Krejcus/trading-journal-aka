CREATE TABLE "accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"initial_balance" real DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"is_default" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"entry_price" real NOT NULL,
	"exit_price" real,
	"sl_price" real,
	"tp_price" real,
	"size" real NOT NULL,
	"pnl" real,
	"status" text NOT NULL,
	"entry_time" integer NOT NULL,
	"exit_time" integer,
	"notes" text,
	"screenshot_url" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;
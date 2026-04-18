import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260418071633 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "razorpay_webhook_event" drop constraint if exists "razorpay_webhook_event_event_id_unique";`);
    this.addSql(`alter table if exists "razorpay_payment_refund_record" drop constraint if exists "razorpay_payment_refund_record_razorpay_refund_id_unique";`);
    this.addSql(`alter table if exists "razorpay_payment_completion_job" drop constraint if exists "razorpay_payment_completion_job_attempt_id_unique";`);
    this.addSql(`alter table if exists "razorpay_payment_attempt" drop constraint if exists "razorpay_payment_attempt_razorpay_order_id_unique";`);
    this.addSql(`create table if not exists "razorpay_payment_attempt" ("id" text not null, "cart_id" text not null, "payment_collection_id" text null, "payment_session_id" text null, "razorpay_order_id" text null, "razorpay_payment_id" text null, "order_id" text null, "provider_id" text not null default 'pp_razorpay_razorpay', "status" text check ("status" in ('pending', 'pending_capture', 'captured', 'processing', 'completed', 'failed', 'abandoned', 'expired', 'refunded', 'partially_refunded')) not null default 'pending', "currency_code" text not null, "expected_amount_minor" integer not null, "payment_amount_minor" integer null, "active" boolean not null default true, "expires_at" timestamptz null, "completed_at" timestamptz null, "last_synced_at" timestamptz null, "last_failed_at" timestamptz null, "last_error" text null, "metadata" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "razorpay_payment_attempt_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_razorpay_payment_attempt_cart_id" ON "razorpay_payment_attempt" ("cart_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_razorpay_payment_attempt_razorpay_order_id_unique" ON "razorpay_payment_attempt" ("razorpay_order_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_razorpay_payment_attempt_deleted_at" ON "razorpay_payment_attempt" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_razorpay_payment_attempt_cart_status" ON "razorpay_payment_attempt" ("cart_id", "status") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_razorpay_payment_attempt_active" ON "razorpay_payment_attempt" ("cart_id", "active") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_razorpay_payment_attempt_collection" ON "razorpay_payment_attempt" ("payment_collection_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_razorpay_payment_attempt_session" ON "razorpay_payment_attempt" ("payment_session_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_razorpay_payment_attempt_payment" ON "razorpay_payment_attempt" ("razorpay_payment_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_razorpay_payment_attempt_order" ON "razorpay_payment_attempt" ("order_id") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "razorpay_payment_completion_job" ("id" text not null, "attempt_id" text not null, "cart_id" text not null, "status" text check ("status" in ('pending', 'processing', 'completed', 'dead')) not null default 'pending', "attempts" integer not null default 0, "next_run_at" timestamptz null, "last_attempt_at" timestamptz null, "completed_at" timestamptz null, "last_error" text null, "metadata" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "razorpay_payment_completion_job_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_razorpay_payment_completion_job_attempt_id_unique" ON "razorpay_payment_completion_job" ("attempt_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_razorpay_payment_completion_job_cart_id" ON "razorpay_payment_completion_job" ("cart_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_razorpay_payment_completion_job_deleted_at" ON "razorpay_payment_completion_job" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_razorpay_payment_completion_job_next_run" ON "razorpay_payment_completion_job" ("status", "next_run_at") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "razorpay_payment_refund_record" ("id" text not null, "attempt_id" text null, "order_id" text null, "payment_id" text null, "medusa_refund_id" text null, "razorpay_refund_id" text null, "status" text check ("status" in ('pending', 'processed', 'failed', 'full', 'partial')) not null default 'pending', "refund_amount_minor" integer not null, "currency_code" text not null, "raw_response" jsonb null, "last_error" text null, "processed_at" timestamptz null, "metadata" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "razorpay_payment_refund_record_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_razorpay_payment_refund_record_razorpay_refund_id_unique" ON "razorpay_payment_refund_record" ("razorpay_refund_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_razorpay_payment_refund_record_deleted_at" ON "razorpay_payment_refund_record" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_razorpay_payment_refund_record_order" ON "razorpay_payment_refund_record" ("order_id", "status") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_razorpay_payment_refund_record_attempt" ON "razorpay_payment_refund_record" ("attempt_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_razorpay_payment_refund_record_payment" ON "razorpay_payment_refund_record" ("payment_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_razorpay_payment_refund_record_medusa_refund" ON "razorpay_payment_refund_record" ("medusa_refund_id") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "razorpay_webhook_event" ("id" text not null, "event_id" text not null, "event_type" text not null, "provider_id" text not null default 'pp_razorpay_razorpay', "status" text check ("status" in ('received', 'processing', 'processed', 'ignored', 'failed')) not null default 'received', "cart_id" text null, "payment_session_id" text null, "razorpay_order_id" text null, "payload" jsonb null, "processed_at" timestamptz null, "failed_at" timestamptz null, "failure_reason" text null, "metadata" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "razorpay_webhook_event_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_razorpay_webhook_event_event_id_unique" ON "razorpay_webhook_event" ("event_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_razorpay_webhook_event_deleted_at" ON "razorpay_webhook_event" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_razorpay_webhook_event_type" ON "razorpay_webhook_event" ("event_type", "status") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_razorpay_webhook_event_cart" ON "razorpay_webhook_event" ("cart_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_razorpay_webhook_event_session" ON "razorpay_webhook_event" ("payment_session_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_razorpay_webhook_event_order" ON "razorpay_webhook_event" ("razorpay_order_id") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "razorpay_payment_attempt" cascade;`);

    this.addSql(`drop table if exists "razorpay_payment_completion_job" cascade;`);

    this.addSql(`drop table if exists "razorpay_payment_refund_record" cascade;`);

    this.addSql(`drop table if exists "razorpay_webhook_event" cascade;`);
  }

}

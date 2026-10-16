-- runMigrations() builds this index concurrently before transactional migrations.
-- Fresh/small outboxes can build it here; direct migrations must not block a large live outbox.
DO $$
BEGIN
  IF to_regclass('idx_outbox_events_request_finalized') IS NULL
    AND pg_relation_size('outbox_events'::regclass) > 64 * 1024 * 1024 THEN
    RAISE EXCEPTION 'Migration 0125 would block writes while indexing a large outbox'
      USING DETAIL = 'Build the index first: CREATE INDEX CONCURRENTLY "idx_outbox_events_request_finalized" ON "outbox_events" USING btree ("aggregate_id") WHERE "event_type" = ''request_finalized'' AND "aggregate_type" = ''message_request'';',
            HINT = 'runMigrations() (AUTO_MIGRATE=true or bun run db:migrate) builds this index concurrently automatically.';
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_outbox_events_request_finalized" ON "outbox_events" USING btree ("aggregate_id") WHERE "outbox_events"."event_type" = 'request_finalized' AND "outbox_events"."aggregate_type" = 'message_request';--> statement-breakpoint
COMMENT ON INDEX "idx_outbox_events_request_finalized" IS 'cch:migration:0125:outbox-request-lookup-index:v1';

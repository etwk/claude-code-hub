import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type * as ProjectionWorker from "@/lib/availability/projection-worker";

const dsn = process.env.DSN ?? process.env.DATABASE_URL;
const run = describe.skipIf(!dsn);
const schemaName = `it_availability_${randomUUID().replaceAll("-", "")}`;
const originalDsn = process.env.DSN;
const HOUR_MS = 60 * 60 * 1000;
const RANGE_DAYS = 100;

type HistoricalRequest = {
  id: number;
  createdAt: Date;
  statusCode: number | null;
  isReplay?: boolean;
};

type EventRow = { requestId: number; eventId: string; published: boolean };

run.sequential("availability projection bootstrap (PostgreSQL)", () => {
  let admin: Sql;
  let client: Sql;
  let database: PostgresJsDatabase;
  let worker: typeof ProjectionWorker;
  let schemaCreated = false;
  let nowMs: number;

  function resetScheduler(): void {
    Reflect.deleteProperty(globalThis, "__CCH_AVAIL_PROJ_WORKER__");
  }

  async function reloadWorker(): Promise<typeof ProjectionWorker> {
    resetScheduler();
    vi.resetModules();
    // A real schema-scoped PostgreSQL connection replaces only the application's pool.
    vi.doMock("@/drizzle/db", () => ({ db: database }));
    // Dynamic import intentionally recreates the module boundary of a process restart.
    return await import("@/lib/availability/projection-worker");
  }

  async function insertHistory(requests: HistoricalRequest[]): Promise<void> {
    // Simulate requests that existed before migration 0120 installed the live trigger.
    await client`ALTER TABLE message_request DISABLE TRIGGER message_request_outbox_aiud`;
    try {
      const rows = requests.map((request) => ({
        id: request.id,
        provider_id: 7,
        model: "availability-regression",
        created_at: request.createdAt.toISOString(),
        status_code: request.statusCode,
        duration_ms: 10,
        is_replay: request.isReplay ?? false,
      }));
      await client`INSERT INTO message_request ${client(rows)}`;
    } finally {
      await client`ALTER TABLE message_request ENABLE TRIGGER message_request_outbox_aiud`;
    }
  }

  async function events(): Promise<EventRow[]> {
    return await client<EventRow[]>`
      SELECT aggregate_id::int AS "requestId", event_id AS "eventId",
             published_at IS NOT NULL AS published
      FROM outbox_events
      WHERE event_type = 'request_finalized' AND aggregate_type = 'message_request'
      ORDER BY aggregate_id
    `;
  }

  async function marker() {
    const rows = await client<{ value: { rangeDays: number; inserted: number; at: string } }[]>`
      SELECT value FROM projection_meta WHERE key = 'backfill_done'
    `;
    return rows[0]?.value;
  }

  beforeAll(async () => {
    if (!dsn) throw new TypeError("DSN or DATABASE_URL is required");
    const databaseName = decodeURIComponent(new URL(dsn).pathname.slice(1));
    if (!/test/i.test(databaseName)) throw new Error("A dedicated test database is required");
    admin = postgres(dsn, { max: 1, connect_timeout: 5 });
    const [actual] = await admin<{ name: string }[]>`SELECT current_database() AS name`;
    expect(actual.name).toMatch(/test/i);

    await admin`CREATE SCHEMA ${admin(schemaName)}`;
    schemaCreated = true;
    client = postgres(dsn, {
      max: 1,
      connect_timeout: 5,
      connection: { search_path: schemaName, application_name: "cch-availability-regression" },
    });
    database = drizzle(client);
    process.env.DSN = dsn;
    nowMs = Date.now();

    await client.unsafe(`
      CREATE TABLE providers (id integer PRIMARY KEY, group_tag varchar);
      INSERT INTO providers (id, group_tag) VALUES (7, 'availability-regression');
      CREATE TABLE message_request (
        id bigserial PRIMARY KEY,
        provider_id integer,
        model varchar,
        created_at timestamptz NOT NULL DEFAULT now(),
        status_code integer,
        duration_ms integer,
        ttfb_ms integer,
        blocked_by varchar,
        error_message text,
        provider_chain jsonb,
        is_replay boolean DEFAULT false
      );
    `);
    const outcomeMigration = await readFile(
      new URL("../../drizzle/0121_legacy_hedge_abort_health.sql", import.meta.url),
      "utf8"
    );
    for (const statement of outcomeMigration.split("--> statement-breakpoint")) {
      if (statement.includes("CREATE OR REPLACE FUNCTION")) await client.unsafe(statement);
    }
    const projectionMigration = await readFile(
      new URL("../../drizzle/0120_availability_projection.sql", import.meta.url),
      "utf8"
    );
    for (const statement of projectionMigration.split("--> statement-breakpoint")) {
      // gen_random_uuid() is built into supported PostgreSQL; do not install a global extension.
      if (statement.trim() && !statement.includes("CREATE EXTENSION")) {
        await client.unsafe(statement);
      }
    }
    const lookupMigration = await readFile(
      new URL("../../drizzle/0125_outbox_request_lookup.sql", import.meta.url),
      "utf8"
    );
    for (const statement of lookupMigration.split("--> statement-breakpoint")) {
      if (statement.trim()) await client.unsafe(statement);
    }
  });

  beforeEach(async () => {
    await client`
      TRUNCATE message_request, outbox_events, proj_applied_requests,
               avail_bucket_1m, avail_current, projection_meta RESTART IDENTITY
    `;
    vi.spyOn(Date, "now").mockReturnValue(nowMs);
    worker = await reloadWorker();
  });

  afterAll(async () => {
    resetScheduler();
    vi.doUnmock("@/drizzle/db");
    const failures: unknown[] = [];
    try {
      await client?.end({ timeout: 5 });
    } catch (error) {
      failures.push(error);
    }
    try {
      if (schemaCreated) await admin`DROP SCHEMA ${admin(schemaName)} CASCADE`;
    } catch (error) {
      failures.push(error);
    }
    try {
      await admin?.end({ timeout: 5 });
    } catch (error) {
      failures.push(error);
    }
    if (originalDsn === undefined) delete process.env.DSN;
    else process.env.DSN = originalDsn;
    if (failures.length > 0)
      throw new AggregateError(failures, "availability fixture cleanup failed");
  });

  test("writes a typed completion marker and a completed restart leaves history unchanged", async () => {
    const recent = new Date(nowMs - HOUR_MS);
    await insertHistory([
      { id: 1, createdAt: recent, statusCode: 200 },
      { id: 2, createdAt: recent, statusCode: 503 },
      { id: 3, createdAt: recent, statusCode: 200, isReplay: true },
      { id: 4, createdAt: recent, statusCode: null },
      { id: 5, createdAt: new Date(nowMs - (RANGE_DAYS + 1) * 24 * HOUR_MS), statusCode: 200 },
    ]);
    // Other event kinds or aggregate types must not suppress legitimate history.
    await client`
      INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, occurred_at, payload)
      VALUES ('request_started', 'message_request', 1, now(), '{}'),
             ('request_finalized', 'other_aggregate', 2, now(), '{}')
    `;

    await worker.__test__.bootstrapBackfill();
    expect(await marker()).toEqual({
      at: expect.any(String),
      note: "availability backfill",
      rangeDays: worker.__test__.BACKFILL_RANGE_DAYS,
      inserted: 2,
    });
    const originalEvents = await events();
    expect(originalEvents.map((event) => event.requestId)).toEqual([1, 2]);
    expect(originalEvents.every((event) => !event.published)).toBe(true);

    worker = await reloadWorker();
    await worker.__test__.bootstrapBackfill();
    expect(await events()).toEqual(originalEvents);
    expect(await worker.processBatch()).toBe(2);
    expect(await worker.processBatch()).toBe(0);
    expect(await events()).toEqual(originalEvents.map((event) => ({ ...event, published: true })));
  });

  test("restarts after a failed completion write without duplicating unpublished enqueues", async () => {
    await insertHistory([
      { id: 1, createdAt: new Date(nowMs - HOUR_MS), statusCode: 200 },
      { id: 2, createdAt: new Date(nowMs - HOUR_MS), statusCode: 503 },
    ]);
    await client`
      ALTER TABLE projection_meta ADD CONSTRAINT availability_marker_failure
      CHECK (key <> 'backfill_done')
    `;
    try {
      await expect(worker.__test__.bootstrapBackfill()).rejects.toThrow();
      expect(await marker()).toBeUndefined();
      const originalEvents = await events();
      expect(originalEvents).toHaveLength(2);
      expect(originalEvents.every((event) => !event.published)).toBe(true);
      expect(await client`SELECT request_id FROM proj_applied_requests`).toHaveLength(0);

      await client`ALTER TABLE projection_meta DROP CONSTRAINT availability_marker_failure`;
      worker = await reloadWorker();
      await worker.__test__.bootstrapBackfill();
      expect(await events()).toEqual(originalEvents);
      expect(await marker()).toMatchObject({ rangeDays: RANGE_DAYS, inserted: 0 });
      expect(await worker.processBatch()).toBe(2);
    } finally {
      await client`ALTER TABLE projection_meta DROP CONSTRAINT IF EXISTS availability_marker_failure`;
    }
  });

  test("resumes failed chunks with both applied and unpublished prior events exactly once", async () => {
    const firstChunkTime = new Date(nowMs - RANGE_DAYS * 24 * HOUR_MS + HOUR_MS);
    await insertHistory([
      ...Array.from({ length: 305 }, (_, index) => ({
        id: index + 1,
        createdAt: firstChunkTime,
        statusCode: 200,
      })),
      {
        id: 306,
        createdAt: new Date(firstChunkTime.getTime() + 6 * HOUR_MS),
        statusCode: 503,
      },
    ]);
    await client`
      ALTER TABLE outbox_events ADD CONSTRAINT availability_chunk_failure
      CHECK (aggregate_id <> 306)
    `;
    try {
      await expect(worker.__test__.bootstrapBackfill()).rejects.toThrow();
      expect(await marker()).toBeUndefined();
      expect(await events()).toHaveLength(305);
      expect(await worker.processBatch()).toBe(worker.__test__.BATCH);
      const beforeRestart = await events();
      expect(beforeRestart.filter((event) => event.published)).toHaveLength(300);
      expect(beforeRestart.filter((event) => !event.published)).toHaveLength(5);

      await client`ALTER TABLE outbox_events DROP CONSTRAINT availability_chunk_failure`;
      worker = await reloadWorker();
      await worker.__test__.bootstrapBackfill();
      const resumed = await events();
      expect(resumed).toHaveLength(306);
      expect(resumed.slice(0, 305)).toEqual(beforeRestart);
      expect(await marker()).toMatchObject({ rangeDays: RANGE_DAYS, inserted: 1 });
      expect(await worker.processBatch()).toBe(6);
      expect(await worker.processBatch()).toBe(0);
      expect((await events()).every((event) => event.published)).toBe(true);
      const [totals] = await client`
        SELECT SUM(success_cnt)::int AS successes, SUM(failure_cnt)::int AS failures,
               SUM(latency_cnt)::int AS latencies, SUM(latency_sum_ms)::int AS duration
        FROM avail_bucket_1m
      `;
      expect(totals).toEqual({ successes: 305, failures: 1, latencies: 306, duration: 3060 });
      expect(await client`SELECT request_id FROM proj_applied_requests`).toHaveLength(306);
    } finally {
      await client`ALTER TABLE outbox_events DROP CONSTRAINT IF EXISTS availability_chunk_failure`;
    }
  });

  test("live finalization still emits and applies update and insert events around bootstrap", async () => {
    await client`
      INSERT INTO message_request (id, provider_id, created_at)
      VALUES (1, 7, now() - INTERVAL '1 minute')
    `;
    expect(await events()).toHaveLength(0);
    await client`UPDATE message_request SET status_code = 200, duration_ms = 25 WHERE id = 1`;
    const finalized = await events();
    expect(finalized).toHaveLength(1);

    await worker.__test__.bootstrapBackfill();
    expect(await events()).toEqual(finalized);
    expect(await marker()).toMatchObject({ inserted: 0 });
    expect(await worker.processBatch()).toBe(1);
    await client`UPDATE message_request SET status_code = 503, duration_ms = 50 WHERE id = 1`;
    expect(await worker.processBatch()).toBe(0);
    await client`
      INSERT INTO message_request (id, provider_id, status_code, duration_ms)
      VALUES (2, 7, 503, 75)
    `;
    expect(await worker.processBatch()).toBe(1);
    expect((await events()).map((event) => event.requestId)).toEqual([1, 2]);
    const [current] = await client`
      SELECT state, availability, request_count FROM avail_current WHERE provider_id = 7
    `;
    expect(current).toEqual({ state: "yellow", availability: 0.5, request_count: 2 });
    const [bucket] = await client`
      SELECT SUM(success_cnt)::int AS successes, SUM(failure_cnt)::int AS failures,
             SUM(latency_sum_ms)::int AS duration
      FROM avail_bucket_1m WHERE provider_id = 7
    `;
    expect(bucket).toEqual({ successes: 1, failures: 1, duration: 100 });
  });
});

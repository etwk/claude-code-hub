import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { ProxyReplayGuard } from "@/app/v1/_lib/proxy/replay/replay-guard";
import { deriveReplayIdentity } from "@/app/v1/_lib/proxy/replay/replay-identity";
import { getReplayStore } from "@/app/v1/_lib/proxy/replay/replay-store";
import type { ProxySession } from "@/app/v1/_lib/proxy/session";
import { db } from "@/drizzle/db";
import { messageRequest, replayPayloads, usageLedger } from "@/drizzle/schema";
import { backfillUsageLedger } from "@/lib/ledger-backfill";
import { isLedgerOnlyMode } from "@/lib/ledger-fallback";
import * as proxyRuntime from "@/lib/system-settings/proxy-runtime";
import { findUsageLogs, materializeReplayAuditFromSource } from "@/repository/message";
import { sumProviderTotalCost, sumUserTotalCost } from "@/repository/statistics";

if (!process.env.DSN && process.env.DATABASE_URL) {
  process.env.DSN = process.env.DATABASE_URL;
}

const HAS_DB = Boolean(process.env.DSN);
const run = describe.skipIf(!HAS_DB);

const KEY_PREFIX = `it-usage-ledger-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const ID_SEED = Math.floor(Date.now() / 1000) % 1_000_000;

const replayIds = new Set<string>();
let idCursor = 0;
let keyCursor = 0;

function nextUserId() {
  idCursor += 1;
  return 700_000_000 + ID_SEED * 10 + idCursor;
}

function nextProviderId() {
  idCursor += 1;
  return 800_000_000 + ID_SEED * 10 + idCursor;
}

function nextKey(tag: string) {
  keyCursor += 1;
  return `${KEY_PREFIX}-${tag}-${keyCursor}`;
}

function toNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

type InsertRequestInput = {
  key: string;
  userId: number;
  providerId: number;
  model?: string | null;
  originalModel?: string | null;
  endpoint?: string | null;
  apiType?: string | null;
  statusCode?: number | null;
  blockedBy?: string | null;
  errorMessage?: string | null;
  costUsd?: string | null;
  costMultiplier?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  providerChain?: Array<{ id: number; name: string }> | null;
  sessionId?: string | null;
  sessionIdentity?: string | null;
  sessionIdentityKind?: "session_id" | "prefix_affinity" | null;
  affinityScopeTag?: string | null;
  affinityFingerprint?: string | null;
  affinityFingerprintChain?: string[] | null;
  isReplay?: boolean;
  replaySourceRequestId?: number | null;
  createdAt?: Date;
};

async function insertMessageRequestRow(input: InsertRequestInput) {
  const [row] = await db
    .insert(messageRequest)
    .values({
      key: input.key,
      userId: input.userId,
      providerId: input.providerId,
      model: input.model,
      originalModel: input.originalModel,
      endpoint: input.endpoint,
      apiType: input.apiType,
      statusCode: input.statusCode,
      blockedBy: input.blockedBy,
      errorMessage: input.errorMessage,
      costUsd: input.costUsd,
      costMultiplier: input.costMultiplier,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      providerChain: input.providerChain,
      sessionId: input.sessionId,
      sessionIdentity: input.sessionIdentity,
      sessionIdentityKind: input.sessionIdentityKind,
      affinityScopeTag: input.affinityScopeTag,
      affinityFingerprint: input.affinityFingerprint,
      affinityFingerprintChain: input.affinityFingerprintChain,
      isReplay: input.isReplay,
      replaySourceRequestId: input.replaySourceRequestId,
      createdAt: input.createdAt,
    })
    .returning({ id: messageRequest.id });

  if (!row) {
    throw new Error("failed to insert message_request test row");
  }

  return row.id;
}

async function selectLedgerRowByRequestId(requestId: number) {
  const [row] = await db
    .select({
      id: usageLedger.id,
      requestId: usageLedger.requestId,
      userId: usageLedger.userId,
      key: usageLedger.key,
      providerId: usageLedger.providerId,
      finalProviderId: usageLedger.finalProviderId,
      model: usageLedger.model,
      originalModel: usageLedger.originalModel,
      endpoint: usageLedger.endpoint,
      apiType: usageLedger.apiType,
      sessionId: usageLedger.sessionId,
      sessionIdentity: usageLedger.sessionIdentity,
      sessionIdentityKind: usageLedger.sessionIdentityKind,
      affinityScopeTag: usageLedger.affinityScopeTag,
      affinityFingerprint: usageLedger.affinityFingerprint,
      affinityFingerprintChain: usageLedger.affinityFingerprintChain,
      isReplay: usageLedger.isReplay,
      replaySourceRequestId: usageLedger.replaySourceRequestId,
      statusCode: usageLedger.statusCode,
      isSuccess: usageLedger.isSuccess,
      successRateOutcome: usageLedger.successRateOutcome,
      blockedBy: usageLedger.blockedBy,
      costUsd: usageLedger.costUsd,
      costMultiplier: usageLedger.costMultiplier,
      inputTokens: usageLedger.inputTokens,
      outputTokens: usageLedger.outputTokens,
      createdAt: usageLedger.createdAt,
    })
    .from(usageLedger)
    .where(eq(usageLedger.requestId, requestId))
    .limit(1);

  return row ?? null;
}

async function cleanupTestRows() {
  const keyLike = `${KEY_PREFIX}%`;
  if (replayIds.size > 0) {
    await db.delete(replayPayloads).where(inArray(replayPayloads.replayId, [...replayIds]));
    replayIds.clear();
  }
  await db.delete(messageRequest).where(sql`${messageRequest.key} LIKE ${keyLike}`);
  await db.delete(usageLedger).where(sql`${usageLedger.key} LIKE ${keyLike}`);
}

run("usage ledger integration", () => {
  beforeAll(async () => {
    await cleanupTestRows();
  });

  afterAll(async () => {
    await cleanupTestRows();
  });

  describe("trigger", () => {
    test("inserts usage_ledger row after inserting message_request", async () => {
      const key = nextKey("trigger-insert");
      const userId = nextUserId();
      const providerId = nextProviderId();
      const createdAt = new Date("2026-02-19T03:00:00.000Z");

      const requestId = await insertMessageRequestRow({
        key,
        userId,
        providerId,
        model: "model-a",
        originalModel: "model-a-original",
        endpoint: "/v1/messages",
        apiType: "response",
        statusCode: 200,
        costUsd: "1.250000000000000",
        costMultiplier: "1.1000",
        inputTokens: 12,
        outputTokens: 34,
        createdAt,
      });

      const ledgerRow = await selectLedgerRowByRequestId(requestId);
      expect(ledgerRow).not.toBeNull();
      expect(ledgerRow?.requestId).toBe(requestId);
      expect(ledgerRow?.key).toBe(key);
      expect(ledgerRow?.userId).toBe(userId);
      expect(ledgerRow?.providerId).toBe(providerId);
      expect(ledgerRow?.finalProviderId).toBe(providerId);
      expect(ledgerRow?.model).toBe("model-a");
      expect(ledgerRow?.originalModel).toBe("model-a-original");
      expect(ledgerRow?.endpoint).toBe("/v1/messages");
      expect(ledgerRow?.apiType).toBe("response");
      expect(ledgerRow?.statusCode).toBe(200);
      expect(ledgerRow?.isSuccess).toBe(true);
      expect(ledgerRow?.successRateOutcome).toBe("success");
      expect(toNumber(ledgerRow?.costUsd)).toBeCloseTo(1.25, 10);
      expect(ledgerRow?.inputTokens).toBe(12);
      expect(ledgerRow?.outputTokens).toBe(34);
      expect(ledgerRow?.createdAt).toEqual(createdAt);
    });

    test("updates usage_ledger row on message_request update (UPSERT)", async () => {
      const key = nextKey("trigger-update");
      const userId = nextUserId();
      const providerId = nextProviderId();

      const requestId = await insertMessageRequestRow({
        key,
        userId,
        providerId,
        model: "model-before",
        costUsd: "0",
      });

      await db
        .update(messageRequest)
        .set({
          model: "model-after",
          costUsd: "3.500000000000000",
          inputTokens: 101,
          outputTokens: 202,
          statusCode: 201,
        })
        .where(eq(messageRequest.id, requestId));

      const rows = await db
        .select({
          id: usageLedger.id,
          model: usageLedger.model,
          costUsd: usageLedger.costUsd,
          inputTokens: usageLedger.inputTokens,
          outputTokens: usageLedger.outputTokens,
          statusCode: usageLedger.statusCode,
        })
        .from(usageLedger)
        .where(eq(usageLedger.requestId, requestId));

      expect(rows).toHaveLength(1);
      expect(rows[0]?.model).toBe("model-after");
      expect(toNumber(rows[0]?.costUsd)).toBeCloseTo(3.5, 10);
      expect(rows[0]?.inputTokens).toBe(101);
      expect(rows[0]?.outputTokens).toBe(202);
      expect(rows[0]?.statusCode).toBe(201);
    });

    test("projects prefix Session identity and zero-cost Replay provenance", async () => {
      const requestId = await insertMessageRequestRow({
        key: nextKey("trigger-replay-identity"),
        userId: nextUserId(),
        providerId: nextProviderId(),
        sessionId: "physical-session",
        sessionIdentity: "pfx:scope-a:fingerprint-a",
        sessionIdentityKind: "prefix_affinity",
        affinityScopeTag: "scope-a",
        affinityFingerprint: "fingerprint-a",
        affinityFingerprintChain: ["fingerprint-root", "fingerprint-a"],
        isReplay: true,
        replaySourceRequestId: 7,
        costUsd: "9.990000000000000",
      });

      const ledgerRow = await selectLedgerRowByRequestId(requestId);
      expect(ledgerRow).toMatchObject({
        sessionId: "physical-session",
        sessionIdentity: "pfx:scope-a:fingerprint-a",
        sessionIdentityKind: "prefix_affinity",
        affinityScopeTag: "scope-a",
        affinityFingerprint: "fingerprint-a",
        affinityFingerprintChain: ["fingerprint-root", "fingerprint-a"],
        isReplay: true,
        replaySourceRequestId: 7,
      });
      expect(toNumber(ledgerRow?.costUsd)).toBe(0);
    });

    test("does not insert usage_ledger row for warmup requests", async () => {
      const requestId = await insertMessageRequestRow({
        key: nextKey("trigger-warmup"),
        userId: nextUserId(),
        providerId: nextProviderId(),
        blockedBy: "warmup",
        costUsd: "8.900000000000000",
      });

      const ledgerRow = await selectLedgerRowByRequestId(requestId);
      expect(ledgerRow).toBeNull();
    });

    test("extracts final_provider_id from provider_chain", async () => {
      const providerId = nextProviderId();
      const requestId = await insertMessageRequestRow({
        key: nextKey("trigger-provider-chain"),
        userId: nextUserId(),
        providerId,
        providerChain: [
          { id: providerId, name: "origin" },
          { id: providerId + 777, name: "final" },
        ],
      });

      const ledgerRow = await selectLedgerRowByRequestId(requestId);
      expect(ledgerRow).not.toBeNull();
      expect(ledgerRow?.finalProviderId).toBe(providerId + 777);
    });

    test("sets is_success=false when error_message exists", async () => {
      const requestId = await insertMessageRequestRow({
        key: nextKey("trigger-error"),
        userId: nextUserId(),
        providerId: nextProviderId(),
        errorMessage: "upstream failed",
        statusCode: 500,
      });

      const ledgerRow = await selectLedgerRowByRequestId(requestId);
      expect(ledgerRow?.isSuccess).toBe(false);
      expect(ledgerRow?.successRateOutcome).toBe("failure");
    });

    test("sets is_success=true when error_message is absent", async () => {
      const requestId = await insertMessageRequestRow({
        key: nextKey("trigger-success"),
        userId: nextUserId(),
        providerId: nextProviderId(),
        statusCode: 200,
      });

      const ledgerRow = await selectLedgerRowByRequestId(requestId);
      expect(ledgerRow?.isSuccess).toBe(true);
      expect(ledgerRow?.successRateOutcome).toBe("success");
    });

    test("marks non-upstream failures as excluded for success-rate outcome", async () => {
      const requestId = await insertMessageRequestRow({
        key: nextKey("trigger-excluded"),
        userId: nextUserId(),
        providerId: nextProviderId(),
        statusCode: 499,
        errorMessage: "request aborted by client",
      });

      const ledgerRow = await selectLedgerRowByRequestId(requestId);
      expect(ledgerRow?.successRateOutcome).toBe("excluded");
    });
  });

  describe("completed Replay audit projection", () => {
    async function createReplayFixture(
      statusCode = 499,
      errorMessage: string | null = "CLIENT_ABORTED"
    ) {
      const runtime: proxyRuntime.ProxyRuntimeSettings = {
        streamGateMode: "off",
        affinityIgnoreClientSessionId: true,
        replayEnabled: true,
        replayCacheTtlMinutes: 60,
        cacheEffectivenessEnabled: true,
      };
      vi.spyOn(proxyRuntime, "getProxyRuntimeSettings").mockResolvedValue(runtime);
      vi.spyOn(proxyRuntime, "getCachedProxyRuntimeSettings").mockReturnValue(runtime);
      const store = getReplayStore();
      vi.spyOn(store, "getMeta").mockResolvedValue(null);
      vi.spyOn(store, "tryClaimOwner").mockResolvedValue(false);
      const key = nextKey("replay-audit");
      const userId = nextUserId();
      const providerId = nextProviderId();
      const session = {
        method: "POST",
        headers: new Headers(),
        request: {
          model: "requested-model",
          message: {
            model: "requested-model",
            stream: true,
            messages: [{ role: "user", content: key }],
          },
        },
        authState: { key: { id: providerId }, user: { id: userId }, apiKey: key },
        originalFormat: "claude",
        sessionId: "replay-delivery-session",
        requestSequence: 2,
        replayState: null,
        getEndpointPolicy: () => ({ kind: "default" }),
        getOriginalModel: () => "requested-model",
        getEndpoint: () => "/v1/messages",
        getMessagesLength: () => 1,
        getSessionIdentityMetadata: () => ({
          identity: "replay-delivery-session",
          kind: "session_id",
          scopeTag: null,
          fingerprint: null,
          fingerprints: [],
        }),
      } as unknown as ProxySession;
      const identity = deriveReplayIdentity(session);
      if (!identity) throw new Error("fixture must derive Replay identity");
      replayIds.add(identity.replayId);
      const [source] = await db
        .insert(messageRequest)
        .values({
          key,
          userId,
          providerId,
          model: "routed-model",
          originalModel: "requested-model",
          actualResponseModel: "upstream-model",
          statusCode,
          errorMessage,
          inputTokens: 463,
          outputTokens: 11,
          cacheCreationInputTokens: 31,
          cacheReadInputTokens: 17,
          cacheCreation5mInputTokens: 19,
          cacheCreation1hInputTokens: 12,
          cacheTtlApplied: "1h",
          costUsd: "0.125000000000000",
          sessionId: "source-delivery-session",
        })
        .returning();
      if (!source) throw new Error("fixture must insert source request");
      const sourceLedger = await selectLedgerRowByRequestId(source.id);
      const payload = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
      const completion = {
        ...identity,
        statusCode: 201,
        headers: { "content-type": "text/event-stream" },
        payload,
        byteSize: Buffer.byteLength(payload),
        sourceMessageRequestId: source.id,
      };
      async function createAuditRow(user = userId, auditKey = key) {
        return insertMessageRequestRow({
          key: auditKey,
          userId: user,
          providerId: 0,
          model: "requested-model",
          statusCode: 201,
          costUsd: "0",
          isReplay: true,
          replaySourceRequestId: source.id,
        });
      }
      return { store, session, identity, source, sourceLedger, completion, createAuditRow };
    }

    test.each(["pg", "redis"] as const)(
      "repeated %s hits project detached-499 usage without rewriting source delivery or billing",
      async (tier) => {
        const fixture = await createReplayFixture();
        const { store, session, identity, source, completion } = fixture;
        await store.persistCompleted(completion);
        if (tier === "redis") {
          vi.spyOn(store, "getMeta").mockResolvedValue({
            status: "completed",
            verifier: identity.verifier,
            scopeTag: identity.scopeTag,
            statusCode: completion.statusCode,
            headers: completion.headers,
            format: identity.format,
            model: identity.model,
            chunkCount: 1,
            byteSize: completion.byteSize,
            heartbeatAt: Date.now(),
            messageRequestId: source.id,
          });
          vi.spyOn(store, "readChunksForGeneration").mockResolvedValue([completion.payload]);
        }

        for (let hit = 0; hit < 2; hit += 1) {
          const response = await ProxyReplayGuard.ensure(session);
          expect(response?.status).toBe(201);
          expect(response?.headers.get("x-cch-replay")).toBe("completed");
          await expect(response?.text()).resolves.toBe(completion.payload);
        }

        const audits = await db
          .select()
          .from(messageRequest)
          .where(and(eq(messageRequest.key, source.key), eq(messageRequest.isReplay, true)));
        expect(audits).toHaveLength(2);
        for (const audit of audits) {
          expect(audit).toMatchObject({
            providerId: source.providerId,
            model: "routed-model",
            originalModel: "requested-model",
            actualResponseModel: "upstream-model",
            inputTokens: 463,
            outputTokens: 11,
            cacheCreationInputTokens: 31,
            cacheReadInputTokens: 17,
            cacheCreation5mInputTokens: 19,
            cacheCreation1hInputTokens: 12,
            cacheTtlApplied: "1h",
            statusCode: 201,
            errorMessage: null,
            costBreakdown: null,
            blockedBy: null,
            replaySourceRequestId: source.id,
            sessionId: "replay-delivery-session",
          });
          expect(toNumber(audit.costUsd)).toBe(0);
          const ledger = await selectLedgerRowByRequestId(audit.id);
          expect(ledger).toMatchObject({
            providerId: source.providerId,
            model: "routed-model",
            originalModel: "requested-model",
            inputTokens: 463,
            outputTokens: 11,
            statusCode: 201,
            isReplay: true,
            replaySourceRequestId: source.id,
          });
          expect(toNumber(ledger?.costUsd)).toBe(0);
        }
        const [unchangedSource] = await db
          .select()
          .from(messageRequest)
          .where(eq(messageRequest.id, source.id));
        expect(unchangedSource).toEqual(source);
        expect(await selectLedgerRowByRequestId(source.id)).toEqual(fixture.sourceLedger);
        expect(fixture.sourceLedger).toMatchObject({
          statusCode: 499,
          inputTokens: 463,
          outputTokens: 11,
        });
        expect(toNumber(fixture.sourceLedger?.costUsd)).toBe(0.125);
      }
    );

    test("ordinary successful Replay retains source attribution and zero billing", async () => {
      const fixture = await createReplayFixture(201, null);
      const { store, session, source, completion, createAuditRow } = fixture;
      // Existing successful-source callers do not need detached-completion evidence.
      const auditId = await createAuditRow();
      await expect(materializeReplayAuditFromSource(auditId, source.id)).resolves.toBe(true);
      await store.persistCompleted(completion);
      const response = await ProxyReplayGuard.ensure(session);
      expect(response?.status).toBe(201);
      await expect(response?.text()).resolves.toBe(completion.payload);
      const audits = await db
        .select()
        .from(messageRequest)
        .where(and(eq(messageRequest.key, source.key), eq(messageRequest.isReplay, true)));
      expect(audits).toHaveLength(2);
      for (const audit of audits) {
        expect(audit).toMatchObject({
          providerId: source.providerId,
          model: "routed-model",
          inputTokens: 463,
          outputTokens: 11,
          statusCode: 201,
          replaySourceRequestId: source.id,
        });
        expect(toNumber(audit.costUsd)).toBe(0);
      }
    });

    test.each([
      "missing completion",
      "missing identity proof",
      "wrong verifier",
      "wrong key ID",
      "wrong source ID",
      "wrong durable user",
      "wrong audit user",
      "wrong audit key",
      "failed completion",
      "empty completion",
      "expired completion",
      "other source error",
      "failed source",
    ])("rejects cancelled-source attribution with %s", async (reason) => {
      const fixture = await createReplayFixture(
        reason === "failed source" ? 502 : 499,
        reason === "other source error" || reason === "failed source"
          ? "UPSTREAM_ERROR"
          : "CLIENT_ABORTED"
      );
      const { store, identity, source, completion, createAuditRow } = fixture;
      if (reason === "wrong source ID") completion.sourceMessageRequestId = source.id + 1;
      if (reason === "wrong durable user") completion.userId += 1;
      if (reason === "failed completion") completion.statusCode = 502;
      if (reason === "empty completion") {
        completion.payload = "";
        completion.byteSize = 0;
      }
      if (reason !== "missing completion") await store.persistCompleted(completion);
      if (reason === "expired completion") {
        await db
          .update(replayPayloads)
          .set({ expiresAt: new Date(0) })
          .where(eq(replayPayloads.replayId, identity.replayId));
      }
      const proof = { ...identity };
      if (reason === "wrong verifier") proof.verifier = "f".repeat(32);
      if (reason === "wrong key ID") proof.keyId += 1;
      const auditId = await createAuditRow(
        reason === "wrong audit user" ? source.userId + 1 : source.userId,
        reason === "wrong audit key" ? nextKey("foreign-replay-audit") : source.key
      );
      await expect(
        materializeReplayAuditFromSource(
          auditId,
          source.id,
          reason === "missing identity proof" ? undefined : proof
        )
      ).resolves.toBe(false);
      const [audit] = await db.select().from(messageRequest).where(eq(messageRequest.id, auditId));
      expect(audit).toMatchObject({
        providerId: 0,
        model: "requested-model",
        inputTokens: null,
        outputTokens: null,
      });
      expect(await selectLedgerRowByRequestId(source.id)).toEqual(fixture.sourceLedger);
    });
  });

  describe("backfill", () => {
    test("backfill copies non-warmup message_request rows when ledger rows are missing", {
      timeout: 60_000,
    }, async () => {
      const userId = nextUserId();
      const providerId = nextProviderId();
      const keepA = await insertMessageRequestRow({
        key: nextKey("backfill-a"),
        userId,
        providerId,
        costUsd: "1.100000000000000",
      });
      const keepB = await insertMessageRequestRow({
        key: nextKey("backfill-b"),
        userId,
        providerId,
        costUsd: "2.200000000000000",
      });
      const warmup = await insertMessageRequestRow({
        key: nextKey("backfill-warmup"),
        userId,
        providerId,
        blockedBy: "warmup",
      });

      await db.delete(usageLedger).where(inArray(usageLedger.requestId, [keepA, keepB, warmup]));

      const summary = await backfillUsageLedger();
      expect(summary.totalProcessed).toBeGreaterThanOrEqual(2);

      const rows = await db
        .select({ requestId: usageLedger.requestId })
        .from(usageLedger)
        .where(inArray(usageLedger.requestId, [keepA, keepB, warmup]));
      const requestIds = rows.map((row) => row.requestId);

      expect(requestIds).toContain(keepA);
      expect(requestIds).toContain(keepB);
      expect(requestIds).not.toContain(warmup);
    });

    test("backfill is idempotent when running twice", { timeout: 60_000 }, async () => {
      const requestId = await insertMessageRequestRow({
        key: nextKey("backfill-idempotent"),
        userId: nextUserId(),
        providerId: nextProviderId(),
        costUsd: "6.600000000000000",
      });

      await db.delete(usageLedger).where(eq(usageLedger.requestId, requestId));

      await backfillUsageLedger();
      const countAfterFirst = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(usageLedger)
        .where(eq(usageLedger.requestId, requestId));

      await backfillUsageLedger();
      const countAfterSecond = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(usageLedger)
        .where(eq(usageLedger.requestId, requestId));

      expect(countAfterFirst[0]?.count ?? 0).toBe(1);
      expect(countAfterSecond[0]?.count ?? 0).toBe(1);
    });

    test("backfill repairs existing ledger rows whose success_rate_outcome is null", {
      timeout: 60_000,
    }, async () => {
      const requestId = await insertMessageRequestRow({
        key: nextKey("backfill-null-outcome"),
        userId: nextUserId(),
        providerId: nextProviderId(),
        statusCode: 499,
        errorMessage: "request aborted by client",
      });

      await db
        .update(usageLedger)
        .set({ successRateOutcome: null })
        .where(eq(usageLedger.requestId, requestId));

      const summary = await backfillUsageLedger();
      expect(summary.alreadyExisted).toBeGreaterThanOrEqual(1);

      const ledgerRow = await selectLedgerRowByRequestId(requestId);
      expect(ledgerRow?.successRateOutcome).toBe("excluded");
    });

    test("backfill repairs stale Session identity and Replay provenance", {
      timeout: 60_000,
    }, async () => {
      const requestId = await insertMessageRequestRow({
        key: nextKey("backfill-replay-identity"),
        userId: nextUserId(),
        providerId: nextProviderId(),
        sessionId: "physical-backfill",
        sessionIdentity: "pfx:scope-b:fingerprint-b",
        sessionIdentityKind: "prefix_affinity",
        affinityScopeTag: "scope-b",
        affinityFingerprint: "fingerprint-b",
        affinityFingerprintChain: ["fingerprint-b"],
        isReplay: true,
        replaySourceRequestId: 8,
        costUsd: "8.880000000000000",
      });

      await db
        .update(usageLedger)
        .set({
          sessionIdentity: null,
          sessionIdentityKind: null,
          affinityScopeTag: null,
          affinityFingerprint: null,
          affinityFingerprintChain: null,
          isReplay: false,
          replaySourceRequestId: null,
          costUsd: "8.880000000000000",
        })
        .where(eq(usageLedger.requestId, requestId));

      const summary = await backfillUsageLedger();
      expect(summary.alreadyExisted).toBeGreaterThanOrEqual(1);

      const ledgerRow = await selectLedgerRowByRequestId(requestId);
      expect(ledgerRow).toMatchObject({
        sessionIdentity: "pfx:scope-b:fingerprint-b",
        sessionIdentityKind: "prefix_affinity",
        affinityScopeTag: "scope-b",
        affinityFingerprint: "fingerprint-b",
        affinityFingerprintChain: ["fingerprint-b"],
        isReplay: true,
        replaySourceRequestId: 8,
      });
      expect(toNumber(ledgerRow?.costUsd)).toBe(0);
    });
  });

  describe("read path consistency", () => {
    test("sumUserTotalCost matches expected cost from trigger-written ledger data", async () => {
      const userId = nextUserId();
      const providerId = nextProviderId();

      await insertMessageRequestRow({
        key: nextKey("read-match-a"),
        userId,
        providerId,
        costUsd: "1.110000000000000",
      });
      await insertMessageRequestRow({
        key: nextKey("read-match-b"),
        userId,
        providerId,
        costUsd: "2.220000000000000",
      });

      const total = await sumUserTotalCost(userId, Number.POSITIVE_INFINITY);
      expect(total).toBeCloseTo(3.33, 10);
    });

    test("ledger totals remain stable after deleting message_request rows", async () => {
      const userId = nextUserId();
      const providerId = nextProviderId();

      const requestA = await insertMessageRequestRow({
        key: nextKey("read-delete-a"),
        userId,
        providerId,
        costUsd: "4.440000000000000",
      });
      const requestB = await insertMessageRequestRow({
        key: nextKey("read-delete-b"),
        userId,
        providerId,
        costUsd: "5.550000000000000",
      });

      const beforeUserCost = await sumUserTotalCost(userId, Number.POSITIVE_INFINITY);
      const beforeProviderCost = await sumProviderTotalCost(providerId);

      await db
        .delete(messageRequest)
        .where(
          and(eq(messageRequest.userId, userId), inArray(messageRequest.id, [requestA, requestB]))
        );

      const afterUserCost = await sumUserTotalCost(userId, Number.POSITIVE_INFINITY);
      const afterProviderCost = await sumProviderTotalCost(providerId);

      expect(afterUserCost).toBeCloseTo(beforeUserCost, 10);
      expect(afterProviderCost).toBeCloseTo(beforeProviderCost, 10);
    });
  });

  describe("ledger-only mode", () => {
    test("isLedgerOnlyMode returns boolean", async () => {
      const result = await isLedgerOnlyMode();
      expect(typeof result).toBe("boolean");
    });

    test("log listing has ledger fallback path", async () => {
      const key = nextKey("ledger-only-logs");
      const userId = nextUserId();
      const providerId = nextProviderId();
      const requestId = await insertMessageRequestRow({
        key,
        userId,
        providerId,
        costUsd: "7.770000000000000",
      });

      await db.delete(messageRequest).where(eq(messageRequest.id, requestId));

      const [remaining] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(messageRequest);

      if ((remaining?.count ?? 0) > 0) {
        const source = await readFile(resolve(process.cwd(), "src/repository/message.ts"), "utf8");
        expect(source).toContain("if (!(await isLedgerOnlyMode()))");
        expect(source).toContain(".from(usageLedger)");
        return;
      }

      vi.resetModules();
      const { findUsageLogs: findUsageLogsFresh } = await import("@/repository/message");
      const result = await findUsageLogsFresh({
        userId,
        page: 1,
        pageSize: 20,
      });

      expect(result.logs.some((row) => row.id === requestId)).toBe(true);
      expect(result.total).toBeGreaterThanOrEqual(1);
    });
  });

  test("findUsageLogs remains callable for compatibility", async () => {
    const key = nextKey("compat-call");
    const userId = nextUserId();
    const providerId = nextProviderId();

    await insertMessageRequestRow({
      key,
      userId,
      providerId,
      costUsd: "0.010000000000000",
    });

    const result = await findUsageLogs({ userId, page: 1, pageSize: 5 });
    expect(Array.isArray(result.logs)).toBe(true);
  });
});

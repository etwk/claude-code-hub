import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  sumKeyQuotaCostsById,
  sumKeyTotalCost,
  sumKeyTotalCostBatchByIds,
  sumUserQuotaCosts,
  sumUserTotalCost,
  sumUserTotalCostBatch,
} from "@/repository/statistics";

const { dbResultMock, dbExecuteMock, dbWhereMock, chain } = vi.hoisted(() => {
  // Every query resolves from the same programmable result queue.
  const dbResultMock = vi.fn<() => unknown>().mockReturnValue([{ total: 0 }]);
  const dbExecuteMock = vi.fn(async (_query: SQL) => dbResultMock());
  const dbWhereMock = vi.fn<(condition: SQL | undefined) => void>();

  function chain(): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    for (const method of ["select", "from", "groupBy", "limit"]) {
      obj[method] = vi.fn(() => chain());
    }
    obj.where = vi.fn((condition: SQL | undefined) => {
      dbWhereMock(condition);
      return chain();
    });
    obj.execute = dbExecuteMock;
    // biome-ignore lint/suspicious/noThenProperty: thenable mock for drizzle query chain
    obj.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
      try {
        resolve(dbResultMock());
      } catch (e) {
        reject(e);
      }
    };
    return obj;
  }

  return { dbResultMock, dbExecuteMock, dbWhereMock, chain };
});

const dialect = new PgDialect();

function executedQuery(index = 0) {
  const query = dbExecuteMock.mock.calls[index]?.[0];
  if (!query) throw new Error(`Missing executed query ${index}`);
  return dialect.sqlToQuery(query);
}

vi.mock("@/drizzle/db", () => ({
  db: chain(),
}));

// Mock drizzle schema -- preserve all exports so module-level sql`` calls work
vi.mock("@/drizzle/schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/drizzle/schema")>();
  return { ...actual };
});

// Mock logger
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe("statistics resetAt parameter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbResultMock.mockReturnValue([{ total: 0 }]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("sumUserTotalCost", () => {
    test("with valid resetAt -- queries DB and returns cost", async () => {
      const resetAt = new Date("2026-02-15T00:00:00Z");
      dbResultMock.mockReturnValue([{ total: 42.5 }]);

      const result = await sumUserTotalCost(10, 365, resetAt);

      expect(result).toBe(42.5);
      expect(dbResultMock).toHaveBeenCalled();
    });

    test("without resetAt -- uses maxAgeDays cutoff instead", async () => {
      dbResultMock.mockReturnValue([{ total: 100.0 }]);

      const result = await sumUserTotalCost(10, 365);

      expect(result).toBe(100.0);
      expect(dbResultMock).toHaveBeenCalled();
    });

    test("with null resetAt -- treated same as undefined", async () => {
      dbResultMock.mockReturnValue([{ total: 50.0 }]);

      const result = await sumUserTotalCost(10, 365, null);

      expect(result).toBe(50.0);
      expect(dbResultMock).toHaveBeenCalled();
    });

    test("with invalid Date (NaN) -- skips resetAt, falls through to maxAgeDays", async () => {
      const invalidDate = new Date("invalid");
      dbResultMock.mockReturnValue([{ total: 75.0 }]);

      const result = await sumUserTotalCost(10, 365, invalidDate);

      expect(result).toBe(75.0);
      expect(dbResultMock).toHaveBeenCalled();
    });
  });

  describe("sumKeyTotalCost", () => {
    test("with valid resetAt -- uses resetAt instead of maxAgeDays cutoff", async () => {
      const resetAt = new Date("2026-02-20T00:00:00Z");
      dbResultMock.mockReturnValue([{ total: 15.0 }]);

      const result = await sumKeyTotalCost("sk-hash", 365, resetAt);

      expect(result).toBe(15.0);
      expect(dbResultMock).toHaveBeenCalled();
    });

    test("without resetAt -- falls back to maxAgeDays", async () => {
      dbResultMock.mockReturnValue([{ total: 30.0 }]);

      const result = await sumKeyTotalCost("sk-hash", 365);

      expect(result).toBe(30.0);
      expect(dbResultMock).toHaveBeenCalled();
    });
  });

  describe("sumUserTotalCostBatch", () => {
    test("with resetAtMap -- aggregates reset users in one statement, batch for the rest", async () => {
      const resetAtMap = new Map([[10, new Date("2026-02-15T00:00:00Z")]]);
      // Calls: 1) VALUES-join aggregation for reset user 10 (db.execute)
      //        2) batch for user 20 => groupBy => [{ userId: 20, total: 50 }]
      dbResultMock
        .mockReturnValueOnce([{ entity_id: 10, total: 25.0 }])
        .mockReturnValueOnce([{ userId: 20, total: 50.0 }]);

      const result = await sumUserTotalCostBatch([10, 20], 365, resetAtMap);

      expect(result.get(10)).toBe(25.0);
      expect(result.get(20)).toBe(50.0);
      expect(dbExecuteMock).toHaveBeenCalledTimes(1);
    });

    test("many reset users -- still a single aggregation statement (regression #1511)", async () => {
      const userIds = Array.from({ length: 50 }, (_, i) => i + 1);
      const resetAtMap = new Map(userIds.map((id) => [id, new Date("2026-02-15T00:00:00Z")]));
      dbResultMock.mockReturnValue(userIds.map((id) => ({ entity_id: id, total: id })));

      const result = await sumUserTotalCostBatch(userIds, Infinity, resetAtMap);

      expect(dbExecuteMock).toHaveBeenCalledTimes(1);
      expect(result.get(1)).toBe(1);
      expect(result.get(50)).toBe(50);
    });

    test("reset user missing from aggregation rows -- defaults to 0", async () => {
      const resetAtMap = new Map([[10, new Date("2026-02-15T00:00:00Z")]]);
      dbResultMock.mockReturnValueOnce([]);

      const result = await sumUserTotalCostBatch([10], 365, resetAtMap);

      expect(result.get(10)).toBe(0);
    });

    test("with invalid reset date -- treated as batch user, no cutoff aggregation", async () => {
      const resetAtMap = new Map([[10, new Date("invalid")]]);
      dbResultMock.mockReturnValue([{ userId: 10, total: 33.0 }]);

      const result = await sumUserTotalCostBatch([10], 365, resetAtMap);

      expect(result.get(10)).toBe(33.0);
      expect(dbExecuteMock).not.toHaveBeenCalled();
    });

    test("with empty resetAtMap -- single batch query for all users", async () => {
      dbResultMock.mockReturnValue([
        { userId: 10, total: 25.0 },
        { userId: 20, total: 50.0 },
      ]);

      const result = await sumUserTotalCostBatch([10, 20], 365, new Map());

      expect(result.get(10)).toBe(25.0);
      expect(result.get(20)).toBe(50.0);
    });

    test("empty userIds -- returns empty map immediately", async () => {
      const result = await sumUserTotalCostBatch([], 365);

      expect(result.size).toBe(0);
    });

    test.each([
      ["2026-02-15T00:00:00.000Z", "2026-02-22T00:00:00.000Z"],
      ["2026-02-25T00:00:00.000Z", "2026-02-25T00:00:00.000Z"],
      ["2026-03-02T00:00:00.000Z", "2026-03-02T00:00:00.000Z"],
    ])("uses the later of max age and reset %s", async (resetAt, expectedCutoff) => {
      vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-03-01T00:00:00Z"));
      dbResultMock.mockReturnValue([{ entity_id: 10, total: "9.25" }]);

      const result = await sumUserTotalCostBatch([10], 7, new Map([[10, new Date(resetAt)]]));
      const query = executedQuery();

      expect(result.get(10)).toBe(9.25);
      expect(query.params.slice(0, 3)).toEqual([10, 10, expectedCutoff]);
      expect(query.sql).toContain('ON "usage_ledger"."user_id" = c.entity_key');
      expect(query.sql).toContain('"usage_ledger"."created_at" >= c.cutoff');
      expect(query.sql).toContain('"usage_ledger"."blocked_by" IS NULL');
      expect(query.sql).toContain('"usage_ledger"."is_replay" = false');
      expect(query.params).toContain("/v1/messages/count_tokens");
      expect(query.params).toContain("/v1/responses/compact");
      expect(query.sql).not.toMatch(/\bWHERE\b/i);
      expect(query.sql).not.toContain('"message_request"');
    });

    test("invalid resets retain the finite max-age boundary", async () => {
      vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-03-01T00:00:00Z"));
      dbResultMock.mockReturnValue([]);

      const result = await sumUserTotalCostBatch([10], 7, new Map([[10, new Date("invalid")]]));
      const query = dialect.sqlToQuery(dbWhereMock.mock.calls[0][0] as SQL);

      expect(result.get(10)).toBe(0);
      expect(dbExecuteMock).not.toHaveBeenCalled();
      expect(query.sql).toContain('"usage_ledger"."created_at" >=');
      expect(query.params).toContain("2026-02-22T00:00:00.000Z");
    });

    test("deduplicates requested IDs and zero-fills missing and zero totals", async () => {
      const resetAt = new Date("2026-02-15T00:00:00Z");
      dbResultMock.mockReturnValue([
        { entity_id: 10, total: "2.5" },
        { entity_id: 20, total: "0" },
      ]);

      const result = await sumUserTotalCostBatch(
        [10, 10, 20, 30],
        Infinity,
        new Map([10, 20, 30].map((id) => [id, resetAt]))
      );

      expect([...result]).toEqual([
        [10, 2.5],
        [20, 0],
        [30, 0],
      ]);
      expect(executedQuery().params.slice(0, 9)).toEqual([
        10,
        10,
        resetAt.toISOString(),
        20,
        20,
        resetAt.toISOString(),
        30,
        30,
        resetAt.toISOString(),
      ]);
      expect(executedQuery().params).toHaveLength(11);
    });

    test("chunks reset aggregation after 1000 unique IDs without losing totals", async () => {
      const userIds = Array.from({ length: 1001 }, (_, index) => index + 1);
      const resetAt = new Date("2026-02-15T00:00:00Z");
      dbResultMock
        .mockReturnValueOnce([{ entity_id: 1, total: "1.5" }])
        .mockReturnValueOnce([{ entity_id: 1001, total: "2.5" }]);

      const result = await sumUserTotalCostBatch(
        userIds,
        Infinity,
        new Map(userIds.map((id) => [id, resetAt]))
      );

      expect(dbExecuteMock).toHaveBeenCalledTimes(2);
      expect(executedQuery(0).params.slice(2997, 3000)).toEqual([
        1000,
        1000,
        resetAt.toISOString(),
      ]);
      expect(executedQuery(1).params.slice(0, 3)).toEqual([1001, 1001, resetAt.toISOString()]);
      expect(result.size).toBe(1001);
      expect(result.get(1)).toBe(1.5);
      expect(result.get(1000)).toBe(0);
      expect(result.get(1001)).toBe(2.5);
    });

    test("rejects instead of returning partial totals if a later chunk fails", async () => {
      const userIds = Array.from({ length: 1001 }, (_, index) => index + 1);
      const failure = new Error("database unavailable");
      dbResultMock.mockReturnValueOnce([]).mockImplementationOnce(() => {
        throw failure;
      });

      await expect(
        sumUserTotalCostBatch(
          userIds,
          Infinity,
          new Map(userIds.map((id) => [id, new Date("2026-02-15T00:00:00Z")]))
        )
      ).rejects.toBe(failure);
      expect(dbExecuteMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("sumKeyTotalCostBatchByIds", () => {
    test("with resetAtMap -- aggregates reset keys in one statement, batch for the rest", async () => {
      const resetAtMap = new Map([[1, new Date("2026-02-15T00:00:00Z")]]);
      dbResultMock
        // 1) PK lookup: key strings
        .mockReturnValueOnce([
          { id: 1, key: "sk-a" },
          { id: 2, key: "sk-b" },
        ])
        // 2) VALUES-join aggregation for reset key 1 (db.execute)
        .mockReturnValueOnce([{ entity_id: 1, total: 10.0 }])
        // 3) batch for key 2
        .mockReturnValueOnce([{ key: "sk-b", total: 20.0 }]);

      const result = await sumKeyTotalCostBatchByIds([1, 2], 365, resetAtMap);

      expect(result.get(1)).toBe(10.0);
      expect(result.get(2)).toBe(20.0);
      expect(dbExecuteMock).toHaveBeenCalledTimes(1);
    });

    test("many reset keys -- still a single aggregation statement (regression #1511)", async () => {
      const keyIds = Array.from({ length: 40 }, (_, i) => i + 1);
      const resetAtMap = new Map(keyIds.map((id) => [id, new Date("2026-02-15T00:00:00Z")]));
      dbResultMock
        // 1) PK lookup: key strings
        .mockReturnValueOnce(keyIds.map((id) => ({ id, key: `sk-${id}` })))
        // 2) VALUES-join aggregation for all reset keys (db.execute)
        .mockReturnValueOnce(keyIds.map((id) => ({ entity_id: id, total: id })));

      const result = await sumKeyTotalCostBatchByIds(keyIds, Infinity, resetAtMap);

      expect(dbExecuteMock).toHaveBeenCalledTimes(1);
      expect(result.get(1)).toBe(1);
      expect(result.get(40)).toBe(40);
    });

    test("keeps independent cutoffs for key IDs sharing a ledger key string", async () => {
      const earlierReset = new Date("2026-02-15T00:00:00Z");
      const laterReset = new Date("2026-02-20T00:00:00Z");
      dbResultMock
        .mockReturnValueOnce([
          { id: 1, key: "sk-shared" },
          { id: 2, key: "sk-shared" },
        ])
        .mockReturnValueOnce([
          { entity_id: 1, total: "15" },
          { entity_id: 2, total: "5" },
        ]);

      const result = await sumKeyTotalCostBatchByIds(
        [1, 2],
        Infinity,
        new Map([
          [1, earlierReset],
          [2, laterReset],
        ])
      );
      const query = executedQuery();

      expect([...result]).toEqual([
        [1, 15],
        [2, 5],
      ]);
      expect(query.params.slice(0, 6)).toEqual([
        1,
        "sk-shared",
        earlierReset.toISOString(),
        2,
        "sk-shared",
        laterReset.toISOString(),
      ]);
      expect(query.sql).toContain('ON "usage_ledger"."key" = c.entity_key');
      expect(query.sql).toContain("GROUP BY c.entity_id");
      expect(dbExecuteMock).toHaveBeenCalledTimes(1);
    });

    test("fills every duplicate key ID without mixing reset and all-time totals", async () => {
      dbResultMock
        .mockReturnValueOnce([
          { id: 1, key: "sk-shared" },
          { id: 2, key: "sk-shared" },
          { id: 3, key: "sk-shared" },
          { id: 4, key: "sk-unused" },
        ])
        .mockReturnValueOnce([{ entity_id: 1, total: "5" }])
        .mockReturnValueOnce([
          { key: "sk-shared", total: "15" },
          { key: "sk-unused", total: null },
        ]);

      const result = await sumKeyTotalCostBatchByIds(
        [1, 1, 2, 3, 4, 99],
        Infinity,
        new Map([
          [1, new Date("2026-02-20T00:00:00Z")],
          [3, new Date("invalid")],
        ])
      );

      expect([...result]).toEqual([
        [1, 5],
        [2, 15],
        [3, 15],
        [4, 0],
        [99, 0],
      ]);
      const query = dialect.sqlToQuery(dbWhereMock.mock.calls[1][0] as SQL);
      expect(query.sql).not.toContain('"usage_ledger"."created_at"');
    });

    test("missing key mappings return zeros without an aggregate query", async () => {
      dbResultMock.mockReturnValueOnce([]);

      const result = await sumKeyTotalCostBatchByIds([1, 2], Infinity);

      expect([...result]).toEqual([
        [1, 0],
        [2, 0],
      ]);
      expect(dbResultMock).toHaveBeenCalledTimes(1);
      expect(dbExecuteMock).not.toHaveBeenCalled();
    });

    test("empty keyIds -- returns empty map immediately", async () => {
      const result = await sumKeyTotalCostBatchByIds([], 365);

      expect(result.size).toBe(0);
    });
  });

  describe("sumUserQuotaCosts", () => {
    const ranges = {
      range5h: {
        startTime: new Date("2026-03-01T07:00:00Z"),
        endTime: new Date("2026-03-01T12:00:00Z"),
      },
      rangeDaily: {
        startTime: new Date("2026-03-01T00:00:00Z"),
        endTime: new Date("2026-03-01T12:00:00Z"),
      },
      rangeWeekly: {
        startTime: new Date("2026-02-23T00:00:00Z"),
        endTime: new Date("2026-03-01T12:00:00Z"),
      },
      rangeMonthly: {
        startTime: new Date("2026-02-01T00:00:00Z"),
        endTime: new Date("2026-03-01T12:00:00Z"),
      },
    };

    test("with resetAt -- returns correct cost summary", async () => {
      const resetAt = new Date("2026-02-25T00:00:00Z");
      dbResultMock.mockReturnValue([
        {
          cost5h: "1.0",
          costDaily: "2.0",
          costWeekly: "3.0",
          costMonthly: "4.0",
          costTotal: "5.0",
        },
      ]);

      const result = await sumUserQuotaCosts(10, ranges, 365, resetAt);

      expect(result.cost5h).toBe(1.0);
      expect(result.costDaily).toBe(2.0);
      expect(result.costWeekly).toBe(3.0);
      expect(result.costMonthly).toBe(4.0);
      expect(result.costTotal).toBe(5.0);
    });

    test("without resetAt -- uses only maxAgeDays cutoff", async () => {
      dbResultMock.mockReturnValue([
        { cost5h: "0", costDaily: "0", costWeekly: "0", costMonthly: "0", costTotal: "0" },
      ]);

      const result = await sumUserQuotaCosts(10, ranges, 365);

      expect(result.cost5h).toBe(0);
      expect(result.costTotal).toBe(0);
    });
  });

  describe("sumKeyQuotaCostsById", () => {
    test("with resetAt -- same cutoff logic as sumUserQuotaCosts", async () => {
      const resetAt = new Date("2026-02-25T00:00:00Z");
      const ranges = {
        range5h: {
          startTime: new Date("2026-03-01T07:00:00Z"),
          endTime: new Date("2026-03-01T12:00:00Z"),
        },
        rangeDaily: {
          startTime: new Date("2026-03-01T00:00:00Z"),
          endTime: new Date("2026-03-01T12:00:00Z"),
        },
        rangeWeekly: {
          startTime: new Date("2026-02-23T00:00:00Z"),
          endTime: new Date("2026-03-01T12:00:00Z"),
        },
        rangeMonthly: {
          startTime: new Date("2026-02-01T00:00:00Z"),
          endTime: new Date("2026-03-01T12:00:00Z"),
        },
      };
      // First: getKeyStringByIdCached lookup, then main query
      dbResultMock.mockReturnValueOnce([{ key: "sk-test-hash" }]).mockReturnValueOnce([
        {
          cost5h: "2.0",
          costDaily: "4.0",
          costWeekly: "6.0",
          costMonthly: "8.0",
          costTotal: "10.0",
        },
      ]);

      const result = await sumKeyQuotaCostsById(42, ranges, 365, resetAt);

      expect(result.cost5h).toBe(2.0);
      expect(result.costTotal).toBe(10.0);
    });
  });
});

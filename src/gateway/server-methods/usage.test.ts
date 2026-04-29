import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

vi.mock("../../infra/session-cost-usage.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/session-cost-usage.js")>(
    "../../infra/session-cost-usage.js",
  );
  return {
    ...actual,
    loadCostUsageSummary: vi.fn(async () => ({
      updatedAt: Date.now(),
      startDate: "2026-02-01",
      endDate: "2026-02-02",
      daily: [],
      totals: { totalTokens: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalCost: 0 },
    })),
  };
});

import { loadCostUsageSummary } from "../../infra/session-cost-usage.js";
import { __test, usageHandlers } from "./usage.js";

describe("gateway usage helpers", () => {
  const dayMs = 24 * 60 * 60 * 1000;
  const costSummary = (params: { date?: string; totalTokens: number; totalCost: number }) => ({
    updatedAt: Date.now(),
    days: 1,
    daily: [
      {
        date: params.date ?? "2026-02-01",
        input: params.totalTokens,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: params.totalTokens,
        totalCost: params.totalCost,
        inputCost: params.totalCost,
        outputCost: 0,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        missingCostEntries: 0,
      },
    ],
    totals: {
      input: params.totalTokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: params.totalTokens,
      totalCost: params.totalCost,
      inputCost: params.totalCost,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 0,
    },
  });

  beforeEach(() => {
    __test.costUsageCache.clear();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("parseDateToMs accepts YYYY-MM-DD and rejects invalid input", () => {
    expect(__test.parseDateToMs("2026-02-05")).toBe(Date.UTC(2026, 1, 5));
    expect(__test.parseDateToMs(" 2026-02-05 ")).toBe(Date.UTC(2026, 1, 5));
    expect(__test.parseDateToMs("2026-2-5")).toBeUndefined();
    expect(__test.parseDateToMs("nope")).toBeUndefined();
    expect(__test.parseDateToMs(undefined)).toBeUndefined();
  });

  it("parseUtcOffsetToMinutes supports whole-hour and half-hour offsets", () => {
    expect(__test.parseUtcOffsetToMinutes("UTC-4")).toBe(-240);
    expect(__test.parseUtcOffsetToMinutes("UTC+5:30")).toBe(330);
    expect(__test.parseUtcOffsetToMinutes(" UTC+14 ")).toBe(14 * 60);
  });

  it("parseUtcOffsetToMinutes rejects invalid offsets", () => {
    expect(__test.parseUtcOffsetToMinutes("UTC+14:30")).toBeUndefined();
    expect(__test.parseUtcOffsetToMinutes("UTC+5:99")).toBeUndefined();
    expect(__test.parseUtcOffsetToMinutes("UTC+25")).toBeUndefined();
    expect(__test.parseUtcOffsetToMinutes("GMT+5")).toBeUndefined();
    expect(__test.parseUtcOffsetToMinutes(undefined)).toBeUndefined();
  });

  it("parseDays coerces strings/numbers to integers", () => {
    expect(__test.parseDays(7.9)).toBe(7);
    expect(__test.parseDays("30")).toBe(30);
    expect(__test.parseDays("")).toBeUndefined();
    expect(__test.parseDays("nope")).toBeUndefined();
  });

  it("parseDateRange uses explicit start/end as UTC when mode is missing (backward compatible)", () => {
    const range = __test.parseDateRange({ startDate: "2026-02-01", endDate: "2026-02-02" });
    expect(range.startMs).toBe(Date.UTC(2026, 1, 1));
    expect(range.endMs).toBe(Date.UTC(2026, 1, 2) + dayMs - 1);
  });

  it("parseDateRange uses explicit UTC mode", () => {
    const range = __test.parseDateRange({
      startDate: "2026-02-01",
      endDate: "2026-02-02",
      mode: "utc",
    });
    expect(range.startMs).toBe(Date.UTC(2026, 1, 1));
    expect(range.endMs).toBe(Date.UTC(2026, 1, 2) + dayMs - 1);
  });

  it("parseDateRange uses specific UTC offset for explicit dates", () => {
    const range = __test.parseDateRange({
      startDate: "2026-02-01",
      endDate: "2026-02-02",
      mode: "specific",
      utcOffset: "UTC+5:30",
    });
    const start = Date.UTC(2026, 1, 1) - 5.5 * 60 * 60 * 1000;
    const endStart = Date.UTC(2026, 1, 2) - 5.5 * 60 * 60 * 1000;
    expect(range.startMs).toBe(start);
    expect(range.endMs).toBe(endStart + dayMs - 1);
  });

  it("parseDateRange falls back to UTC when specific mode offset is missing or invalid", () => {
    const missingOffset = __test.parseDateRange({
      startDate: "2026-02-01",
      endDate: "2026-02-02",
      mode: "specific",
    });
    const invalidOffset = __test.parseDateRange({
      startDate: "2026-02-01",
      endDate: "2026-02-02",
      mode: "specific",
      utcOffset: "bad-value",
    });
    expect(missingOffset.startMs).toBe(Date.UTC(2026, 1, 1));
    expect(missingOffset.endMs).toBe(Date.UTC(2026, 1, 2) + dayMs - 1);
    expect(invalidOffset.startMs).toBe(Date.UTC(2026, 1, 1));
    expect(invalidOffset.endMs).toBe(Date.UTC(2026, 1, 2) + dayMs - 1);
  });

  it("parseDateRange uses specific offset for today/day math after UTC midnight", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-17T03:57:00.000Z"));
    const range = __test.parseDateRange({
      days: 1,
      mode: "specific",
      utcOffset: "UTC-5",
    });
    expect(range.startMs).toBe(Date.UTC(2026, 1, 16, 5, 0, 0, 0));
    expect(range.endMs).toBe(Date.UTC(2026, 1, 17, 4, 59, 59, 999));
  });

  it("parseDateRange uses gateway local day boundaries in gateway mode", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-05T12:34:56.000Z"));
    const range = __test.parseDateRange({ days: 1, mode: "gateway" });
    const expectedStart = new Date(2026, 1, 5).getTime();
    expect(range.startMs).toBe(expectedStart);
    expect(range.endMs).toBe(expectedStart + dayMs - 1);
  });

  it("parseDateRange clamps days to at least 1 and defaults to 30 days", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-05T12:34:56.000Z"));
    const oneDay = __test.parseDateRange({ days: 0 });
    expect(oneDay.endMs).toBe(Date.UTC(2026, 1, 5) + dayMs - 1);
    expect(oneDay.startMs).toBe(Date.UTC(2026, 1, 5));

    const def = __test.parseDateRange({});
    expect(def.endMs).toBe(Date.UTC(2026, 1, 5) + dayMs - 1);
    expect(def.startMs).toBe(Date.UTC(2026, 1, 5) - 29 * dayMs);
  });

  it("loadCostUsageSummaryCached caches within TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-05T00:00:00.000Z"));

    const config = {} as OpenClawConfig;
    const a = await __test.loadCostUsageSummaryCached({
      startMs: 1,
      endMs: 2,
      config,
    });
    const b = await __test.loadCostUsageSummaryCached({
      startMs: 1,
      endMs: 2,
      config,
    });

    expect(a.totals.totalTokens).toBe(1);
    expect(b.totals.totalTokens).toBe(1);
    expect(vi.mocked(loadCostUsageSummary)).toHaveBeenCalledTimes(1);
  });

  it("usage.cost aggregates configured agents and scopes cache by agent set", async () => {
    vi.mocked(loadCostUsageSummary).mockImplementation(async (params) => {
      if (params?.agentId === "opus") {
        return costSummary({ totalTokens: 20, totalCost: 0.02 });
      }
      return costSummary({ totalTokens: 10, totalCost: 0.01 });
    });

    const config = {
      agents: { list: [{ id: "main" }, { id: "opus" }] },
      session: {},
    } as OpenClawConfig;
    const context = { getRuntimeConfig: () => config };
    const params = { startDate: "2026-02-01", endDate: "2026-02-01", mode: "utc" };

    const aggregateRespond = vi.fn();
    await usageHandlers["usage.cost"]({
      respond: aggregateRespond,
      params,
      context,
    } as unknown as Parameters<(typeof usageHandlers)["usage.cost"]>[0]);

    expect(vi.mocked(loadCostUsageSummary)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(loadCostUsageSummary).mock.calls.map((call) => call[0]?.agentId)).toEqual([
      "main",
      "opus",
    ]);
    expect(aggregateRespond.mock.calls[0]?.[0]).toBe(true);
    expect(aggregateRespond.mock.calls[0]?.[1]).toMatchObject({
      totals: { totalTokens: 30, totalCost: 0.03 },
      daily: [{ date: "2026-02-01", totalTokens: 30, totalCost: 0.03 }],
    });

    const mainRespond = vi.fn();
    await usageHandlers["usage.cost"]({
      respond: mainRespond,
      params: { ...params, agentId: "main" },
      context,
    } as unknown as Parameters<(typeof usageHandlers)["usage.cost"]>[0]);

    expect(vi.mocked(loadCostUsageSummary)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(loadCostUsageSummary).mock.calls[2]?.[0]?.agentId).toBe("main");
    expect(mainRespond.mock.calls[0]?.[1]).toMatchObject({
      totals: { totalTokens: 10, totalCost: 0.01 },
    });
  });
});

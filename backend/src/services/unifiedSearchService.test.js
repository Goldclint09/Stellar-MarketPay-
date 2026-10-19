"use strict";

jest.mock("../db/pool", () => ({ query: jest.fn() }));

const pool = require("../db/pool");
const { searchAll, searchJobs } = require("./unifiedSearchService");

describe("unifiedSearchService", () => {
  beforeEach(() => pool.query.mockReset());

  it("returns empty result groups for missing or whitespace-only queries", async () => {
    await expect(searchAll("   ")).resolves.toEqual({ jobs: [], freelancers: [], proposals: [] });
    await expect(searchAll(undefined)).resolves.toEqual({ jobs: [], freelancers: [], proposals: [] });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("binds punctuation and SQL-like input as a plainto_tsquery parameter", async () => {
    const query = `\" OR 1=1; -- & :*`;
    pool.query.mockResolvedValue({ rows: [] });

    await searchJobs(query, 5);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("plainto_tsquery('english', $1)");
    expect(sql).not.toContain(query);
    expect(params).toEqual([query, 5]);
  });

  it("merges normalized results from all entity queries and bounds the per-type limit", async () => {
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes("FROM jobs")) {
        return { rows: [{ id: 12, title: "Escrow", rank: "0.8", createdAt: "2026-10-01T00:00:00Z" }] };
      }
      if (sql.includes("FROM profiles")) {
        return { rows: [{ publicKey: "G" + "A".repeat(55), skills: null, rating: "4.5", rank: "0.9" }] };
      }
      return { rows: [{ id: 7, title: "DAO proposal", rank: "0.7" }] };
    });

    const result = await searchAll("stellar", 500);

    expect(result.jobs).toMatchObject([{ id: "12", title: "Escrow", rank: 0.8 }]);
    expect(result.freelancers).toMatchObject([{ displayName: expect.any(String), skills: [], rating: 4.5, rank: 0.9 }]);
    expect(result.proposals).toMatchObject([{ id: "7", title: "DAO proposal", rank: 0.7 }]);
    expect(pool.query).toHaveBeenCalledTimes(3);
    for (const [, params] of pool.query.mock.calls) expect(params[1]).toBe(20);
  });

  it("keeps successful entity groups when one search query fails", async () => {
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes("FROM jobs")) throw new Error("database unavailable");
      if (sql.includes("FROM profiles")) return { rows: [{ publicKey: "G" + "A".repeat(55), rank: "0.4" }] };
      return { rows: [] };
    });

    const result = await searchAll("design");

    expect(result.jobs).toEqual([]);
    expect(result.freelancers).toHaveLength(1);
    expect(result.proposals).toEqual([]);
  });
});

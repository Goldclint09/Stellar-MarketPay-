"use strict";

jest.mock("../db/pool", () => ({ query: jest.fn() }));

const pool = require("../db/pool");
const { generateInvoice, logTimeEntry } = require("./timeTrackingService");

const FREELANCER = `G${"A".repeat(55)}`;
const CLIENT = `G${"B".repeat(55)}`;
const JOB_ID = "11111111-1111-4111-8111-111111111111";

describe("timeTrackingService", () => {
  beforeEach(() => pool.query.mockReset());

  it.each([0, -1, 1.5, "not-a-number"])("rejects invalid duration %p", async (durationMinutes) => {
    await expect(logTimeEntry({
      jobId: JOB_ID,
      freelancerAddress: FREELANCER,
      durationMinutes,
    })).rejects.toMatchObject({ status: 400 });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("rejects an entry that overlaps an existing interval", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: JOB_ID, freelancer_address: FREELANCER, status: "in_progress" }] })
      .mockResolvedValueOnce({ rows: [{ total_minutes: 30 }] })
      .mockResolvedValueOnce({ rows: [{ id: "existing-entry" }] });

    await expect(logTimeEntry({
      jobId: JOB_ID,
      freelancerAddress: FREELANCER,
      durationMinutes: 60,
      startedAt: "2026-03-08T01:30:00-05:00",
    })).rejects.toMatchObject({ status: 409, message: "Time entry overlaps an existing entry for this job" });

    const [overlapSql, overlapParams] = pool.query.mock.calls[2];
    expect(overlapSql).toContain("timestamptz + ($4 * INTERVAL '1 minute')");
    expect(overlapSql).toContain("duration_minutes * INTERVAL '1 minute'");
    expect(overlapParams).toEqual([JOB_ID, FREELANCER, "2026-03-08T06:30:00.000Z", 60]);
    expect(pool.query).toHaveBeenCalledTimes(3);
  });

  it("allows adjacent entries and stores the requested milestone", async () => {
    const entry = {
      id: "entry-1",
      job_id: JOB_ID,
      freelancer_address: FREELANCER,
      duration_minutes: 45,
      description: "  Implemented milestone work  ",
      started_at: "2026-03-08T01:30:00-05:00",
      milestone_index: 1,
      created_at: "2026-03-08T06:30:00.000Z",
    };
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: JOB_ID, freelancer_address: FREELANCER, status: "in_progress" }] })
      .mockResolvedValueOnce({ rows: [{ total_minutes: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [entry] });

    await expect(logTimeEntry({
      jobId: JOB_ID,
      freelancerAddress: FREELANCER,
      durationMinutes: 45,
      description: entry.description,
      milestoneIndex: 1,
      startedAt: "2026-03-08T01:30:00-05:00",
    })).resolves.toMatchObject({
      durationMinutes: 45,
      milestoneIndex: 1,
      description: "Implemented milestone work",
    });
    expect(pool.query).toHaveBeenCalledTimes(4);
  });

  it("sums entries from multiple milestones into the invoice", async () => {
    const entries = [
      { id: "entry-1", duration_minutes: 30, milestone_index: 0 },
      { id: "entry-2", duration_minutes: 90, milestone_index: 1 },
    ];
    const invoice = {
      id: "invoice-1",
      job_id: JOB_ID,
      freelancer_address: FREELANCER,
      client_address: CLIENT,
      total_minutes: 120,
      hourly_rate_xlm: "20.0000000",
      total_amount_xlm: "40.0000000",
      status: "pending",
      entry_ids: ["entry-1", "entry-2"],
    };
    pool.query
      .mockResolvedValueOnce({ rows: [{
        id: JOB_ID,
        freelancer_address: FREELANCER,
        client_address: CLIENT,
        status: "in_progress",
      }] })
      .mockResolvedValueOnce({ rows: entries })
      .mockResolvedValueOnce({ rows: [invoice] });

    await expect(generateInvoice({
      jobId: JOB_ID,
      freelancerAddress: FREELANCER,
      hourlyRateXlm: 20,
      entryIds: ["entry-1", "entry-2"],
    })).resolves.toMatchObject({
      totalMinutes: 120,
      totalAmountXlm: "40.0000000",
      entryIds: ["entry-1", "entry-2"],
    });
    expect(pool.query.mock.calls[2][1]).toEqual([
      JOB_ID, FREELANCER, CLIENT, 120, "20.0000000", "40.0000000", ["entry-1", "entry-2"],
    ]);
  });
});

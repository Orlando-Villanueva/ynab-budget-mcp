import assert from "node:assert/strict";
import test from "node:test";

import {
  expandScheduledTransaction,
  inclusiveDaySpan,
} from "../src/scheduled.ts";

function schedule(frequency: string, dateFirst: string, dateNext = dateFirst) {
  return {
    id: `schedule-${frequency}`,
    date_first: dateFirst,
    date_next: dateNext,
    frequency,
    amount: -10_000,
    account_id: "account-1",
  };
}

test("scheduled recurrence expansion covers every supported frequency", () => {
  const cases = [
    ["never", "2026-01-01", "2026-12-31", 1],
    ["daily", "2026-01-01", "2026-01-03", 3],
    ["weekly", "2026-01-01", "2026-01-31", 5],
    ["everyOtherWeek", "2026-01-01", "2026-01-31", 3],
    ["every4Weeks", "2026-01-01", "2026-01-31", 2],
    ["monthly", "2026-01-01", "2026-04-01", 4],
    ["everyOtherMonth", "2026-01-01", "2026-07-01", 4],
    ["every3Months", "2026-01-01", "2026-10-01", 4],
    ["every4Months", "2026-01-01", "2026-12-31", 3],
    ["twiceAYear", "2026-01-01", "2027-01-01", 3],
    ["yearly", "2026-01-01", "2028-01-01", 3],
    ["everyOtherYear", "2026-01-01", "2030-01-01", 3],
  ] as const;

  for (const [frequency, from, through, expected] of cases) {
    assert.equal(
      expandScheduledTransaction(schedule(frequency, from), from, through).length,
      expected,
      frequency,
    );
  }
});

test("twice-monthly occurrences use the anchor day and 15 days later", () => {
  const occurrences = expandScheduledTransaction(
    schedule("twiceAMonth", "2026-01-05"),
    "2026-01-01",
    "2026-02-28",
  );

  assert.deepEqual(
    occurrences.map((occurrence) => occurrence.occurrence_date),
    ["2026-01-05", "2026-01-20", "2026-02-05", "2026-02-20"],
  );
});

test("monthly recurrences clamp to shorter months and recover the anchor day", () => {
  const occurrences = expandScheduledTransaction(
    schedule("monthly", "2026-01-31"),
    "2026-01-01",
    "2026-04-30",
  );

  assert.deepEqual(
    occurrences.map((occurrence) => occurrence.occurrence_date),
    ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"],
  );
});

test("yearly leap-day recurrences clamp and recover in a leap year", () => {
  const occurrences = expandScheduledTransaction(
    schedule("yearly", "2024-02-29"),
    "2024-02-29",
    "2028-02-29",
  );

  assert.deepEqual(
    occurrences.map((occurrence) => occurrence.occurrence_date),
    ["2024-02-29", "2025-02-28", "2026-02-28", "2027-02-28", "2028-02-29"],
  );
});

test("scheduled occurrence bounds are inclusive", () => {
  assert.equal(inclusiveDaySpan("2026-01-01", "2026-01-01"), 1);
  const occurrences = expandScheduledTransaction(
    schedule("daily", "2026-01-01"),
    "2026-01-02",
    "2026-01-03",
  );
  assert.deepEqual(
    occurrences.map((occurrence) => occurrence.occurrence_date),
    ["2026-01-02", "2026-01-03"],
  );
});

test("daily recurrence advances directly across a multi-year gap", () => {
  const occurrences = expandScheduledTransaction(
    schedule("daily", "2020-01-01"),
    "2026-07-01",
    "2026-07-03",
  );

  assert.deepEqual(
    occurrences.map((occurrence) => occurrence.occurrence_date),
    ["2026-07-01", "2026-07-02", "2026-07-03"],
  );
});

test("twice-monthly recurrence advances directly across a multi-year gap", () => {
  const occurrences = expandScheduledTransaction(
    schedule("twiceAMonth", "2020-01-05"),
    "2026-07-01",
    "2026-08-31",
  );

  assert.deepEqual(
    occurrences.map((occurrence) => occurrence.occurrence_date),
    ["2026-07-05", "2026-07-20", "2026-08-05", "2026-08-20"],
  );
});

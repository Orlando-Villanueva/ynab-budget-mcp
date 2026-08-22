import assert from "node:assert/strict";
import test from "node:test";

import { createYnabTools } from "../src/tools.ts";
import { YnabClient } from "../src/ynab/client.ts";

interface MutableCategory {
  id: string;
  name: string;
  budgeted: number;
  balance: number;
  hidden?: boolean;
  internal?: boolean;
  deleted?: boolean;
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function nextMonth(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const value = new Date(Date.UTC(year ?? 0, monthNumber ?? 0, 1));
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}`;
}

function previousMonth(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const value = new Date(Date.UTC(year ?? 0, (monthNumber ?? 1) - 2, 1));
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}`;
}

function findTool(name: string, client: YnabClient) {
  const tool = createYnabTools(client).find((candidate) => candidate.name === name);
  assert.ok(tool, `Missing tool: ${name}`);
  return tool;
}

function createStatefulClient(options: {
  failCategoryId?: string;
  ambiguousCategoryId?: string;
  ambiguousServerCategoryId?: string;
  failFinalVerification?: boolean;
} = {}) {
  const month = currentMonth();
  const futureMonth = nextMonth(month);
  const initialCategories: MutableCategory[] = [
    { id: "rent", name: "Rent", budgeted: 0, balance: 0 },
    { id: "groceries", name: "Groceries", budgeted: 100_000, balance: 100_000 },
    { id: "overspent", name: "Overspent", budgeted: 0, balance: -50_000 },
    { id: "hidden", name: "Hidden", budgeted: 0, balance: 0, hidden: true },
  ];
  const categoriesByMonth = new Map<string, MutableCategory[]>(
    [month, futureMonth].map((selectedMonth) => [
      selectedMonth,
      initialCategories.map((category) => ({ ...category })),
    ]),
  );
  const categories = categoriesByMonth.get(month)!;
  const readyToAssign = new Map([[month, 200_000], [futureMonth, 200_000]]);
  const patchOrder: string[] = [];
  const client = new YnabClient({
    accessToken: "token-123",
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      const path = url.pathname;
      if (path.endsWith("/plans")) {
        return jsonResponse({ plans: [{ id: "plan-1", name: "Plan", first_month: "2024-01-01" }] });
      }
      if (path.endsWith("/plans/plan-1")) {
        return jsonResponse({
          plan: {
            currency_format: { decimal_digits: 2, iso_code: "CAD" },
            first_month: "2024-01-01",
          },
          server_knowledge: 1,
        });
      }

      const categoryMatch = path.match(/\/months\/(\d{4}-\d{2})-01\/categories\/([^/]+)$/);
      if (categoryMatch) {
        const targetMonth = categoryMatch[1] ?? "";
        const categoryId = decodeURIComponent(categoryMatch[2] ?? "");
        const monthCategories = categoriesByMonth.get(targetMonth) ?? [];
        const category = monthCategories.find((candidate) => candidate.id === categoryId);
        if (!category) {
          return errorResponse(404, "not_found");
        }
        if (init?.method === "PATCH") {
          patchOrder.push(categoryId);
          if (categoryId === options.failCategoryId) {
            return errorResponse(400, "validation_error");
          }
          const body = JSON.parse(String(init.body)) as { category: { budgeted: number } };
          const delta = body.category.budgeted - category.budgeted;
          category.budgeted = body.category.budgeted;
          category.balance += delta;
          readyToAssign.set(targetMonth, (readyToAssign.get(targetMonth) ?? 0) - delta);
          if (categoryId === options.ambiguousCategoryId) {
            throw new TypeError("Connection closed after write.");
          }
          if (categoryId === options.ambiguousServerCategoryId) {
            return errorResponse(503, "service_unavailable");
          }
          return jsonResponse({ category, server_knowledge: 2 });
        }
        if (options.failFinalVerification && patchOrder.length > 0) {
          return errorResponse(503, "verification_unavailable");
        }
        return jsonResponse({ category });
      }

      const monthMatch = path.match(/\/months\/(\d{4}-\d{2})-01$/);
      if (monthMatch) {
        if (options.failFinalVerification && patchOrder.length > 0) {
          return errorResponse(503, "verification_unavailable");
        }
        const selectedMonth = monthMatch[1] ?? month;
        return jsonResponse({
          month: {
            month: `${selectedMonth}-01`,
            to_be_budgeted: readyToAssign.get(selectedMonth) ?? 0,
            categories: categoriesByMonth.get(selectedMonth) ?? [],
          },
        });
      }

      return errorResponse(404, "not_found");
    },
  });
  return { client, categories, categoriesByMonth, readyToAssign, patchOrder, month, futureMonth };
}

test("assignment preview validates exact deltas and issues a five-minute token", async () => {
  const state = createStatefulClient();
  const tool = findTool("ynab_preview_assignments", state.client);
  const result = await tool.handler({
    month: state.month,
    assignments: [{ category_id: "rent", delta_currency: "100.00" }],
  });

  assert.equal(result.isError, false);
  assert.equal(result.structuredContent?.assignments[0].projected_budgeted, 100_000);
  assert.equal(result.structuredContent?.guard_uncovered_spending_currency, 50);
  assert.equal(
    result.structuredContent?.projected_guard_planning_available_after_uncovered_spending_currency,
    50,
  );
  assert.equal(typeof result.structuredContent?.preview_token, "string");
  const expiry = Date.parse(result.structuredContent?.expires_at);
  assert.ok(expiry > Date.now() + 4 * 60_000 && expiry <= Date.now() + 5 * 60_000 + 1000);
});

test("preview does not double-count assignments that cover uncovered spending", async () => {
  const state = createStatefulClient();
  const tool = findTool("ynab_preview_assignments", state.client);
  const result = await tool.handler({
    month: state.month,
    assignments: [{ category_id: "overspent", delta_currency: "50.00" }],
  });

  assert.equal(result.isError, false);
  assert.equal(result.structuredContent?.projected_guard_ready_to_assign_currency, 150);
  assert.equal(result.structuredContent?.projected_guard_uncovered_spending_currency, 0);
  assert.equal(
    result.structuredContent?.projected_guard_planning_available_after_uncovered_spending_currency,
    150,
  );
});

test("assignment preview rejects malformed or unsafe inputs and requires a future guard month", async () => {
  const state = createStatefulClient();
  const tool = findTool("ynab_preview_assignments", state.client);

  const precision = await tool.handler({
    month: state.month,
    assignments: [{ category_id: "rent", delta_currency: "1.001" }],
  });
  assert.equal(precision.isError, true);

  const unsafeReduction = await tool.handler({
    month: state.month,
    assignments: [{ category_id: "groceries", delta_currency: "-101.00" }],
  });
  assert.equal(unsafeReduction.isError, true);

  const futureWithoutGuard = await tool.handler({
    month: state.futureMonth,
    assignments: [{ category_id: "rent", delta_currency: "10.00" }],
  });
  assert.equal(futureWithoutGuard.isError, true);

  const duplicate = await tool.handler({
    month: state.month,
    assignments: [
      { category_id: "rent", delta_currency: "1.00" },
      { category_id: "rent", delta_currency: "2.00" },
    ],
  });
  assert.equal(duplicate.isError, true);

  const zero = await tool.handler({
    month: state.month,
    assignments: [{ category_id: "rent", delta_currency: "0.00" }],
  });
  assert.equal(zero.isError, true);

  const past = await tool.handler({
    month: previousMonth(state.month),
    assignments: [{ category_id: "rent", delta_currency: "1.00" }],
  });
  assert.equal(past.isError, true);

  const hidden = await tool.handler({
    month: state.month,
    assignments: [{ category_id: "hidden", delta_currency: "1.00" }],
  });
  assert.equal(hidden.isError, false);
  assert.ok(hidden.structuredContent?.warnings.some((warning: string) => warning.includes("hidden")));
});

test("preview permits a partial current-month assignment while reporting remaining uncovered spending", async () => {
  const state = createStatefulClient();
  const tool = findTool("ynab_preview_assignments", state.client);
  state.readyToAssign.set(state.month, 270_000);
  const overspent = state.categories.find((category) => category.id === "overspent");
  assert.ok(overspent);
  overspent.balance = -349_900;

  const result = await tool.handler({
    month: state.month,
    assignments: [{ category_id: "rent", delta_currency: "1.35" }],
  });

  assert.equal(result.isError, false);
  assert.equal(result.structuredContent?.projected_target_ready_to_assign_currency, 268.65);
  assert.equal(result.structuredContent?.projected_target_uncovered_spending_currency, 349.9);
  const effects = result.structuredContent?.target_month_effects as Record<string, Record<string, unknown>>;
  const readyToAssign = effects.ready_to_assign as Record<string, unknown>;
  const uncoveredSpending = effects.uncovered_spending as Record<string, unknown>;
  assert.equal(readyToAssign.after_currency, 268.65);
  assert.equal(uncoveredSpending.after_currency, 349.9);
  assert.deepEqual(uncoveredSpending.remaining_categories, [
    {
      category_id: "overspent",
      category_name: "Overspent",
      balance: -349_900,
      balance_currency: -349.9,
      uncovered_spending: 349_900,
      uncovered_spending_currency: 349.9,
    },
  ]);
  assert.ok(result.structuredContent?.warnings.some((warning: string) => warning.includes("uncovered spending")));
  assert.equal(typeof result.structuredContent?.preview_token, "string");
});

test("cross-month apply changes only the target month when its Ready to Assign is already negative", async () => {
  const state = createStatefulClient();
  const tools = createYnabTools(state.client);
  const previewTool = tools.find((tool) => tool.name === "ynab_preview_assignments");
  const applyTool = tools.find((tool) => tool.name === "ynab_apply_assignment_preview");
  assert.ok(previewTool && applyTool);
  state.readyToAssign.set(state.futureMonth, -79_900);

  const preview = await previewTool.handler({
    month: state.futureMonth,
    guard_month: state.month,
    assignments: [
      { category_id: "groceries", delta_currency: "-10.00" },
      { category_id: "rent", delta_currency: "10.00" },
    ],
  });

  assert.equal(preview.isError, false);
  assert.equal(preview.structuredContent?.projected_target_ready_to_assign_currency, -79.9);
  assert.equal(preview.structuredContent?.projected_guard_ready_to_assign_currency, 200);
  assert.equal(preview.structuredContent?.cross_month_effects?.guard_month_ready_to_assign_delta_currency, 0);
  assert.ok(preview.structuredContent?.warnings.some((warning: string) => warning.includes("negative Ready to Assign")));

  const previous = process.env.YNAB_ENABLE_WRITES;
  process.env.YNAB_ENABLE_WRITES = "true";
  try {
    const applied = await applyTool.handler({ preview_token: preview.structuredContent?.preview_token });
    assert.equal(applied.isError, false);
    assert.equal(state.categoriesByMonth.get(state.month)?.find((category) => category.id === "groceries")?.budgeted, 100_000);
    assert.equal(state.categoriesByMonth.get(state.month)?.find((category) => category.id === "rent")?.budgeted, 0);
    assert.equal(state.categoriesByMonth.get(state.futureMonth)?.find((category) => category.id === "groceries")?.budgeted, 90_000);
    assert.equal(state.categoriesByMonth.get(state.futureMonth)?.find((category) => category.id === "rent")?.budgeted, 10_000);
    assert.equal(applied.structuredContent?.final_state?.cross_month_effects?.guard_month_ready_to_assign_delta_currency, 0);
  } finally {
    restoreWritesEnv(previous);
  }
});

test("apply is visible but disabled without the exact environment opt-in", async () => {
  const state = createStatefulClient();
  const tools = createYnabTools(state.client);
  const previewTool = tools.find((tool) => tool.name === "ynab_preview_assignments");
  const applyTool = tools.find((tool) => tool.name === "ynab_apply_assignment_preview");
  assert.ok(previewTool && applyTool);
  assert.equal(applyTool.annotations?.readOnlyHint, false);
  assert.equal(applyTool.annotations?.idempotentHint, false);
  const preview = await previewTool.handler({
    month: state.month,
    assignments: [{ category_id: "rent", delta_currency: "10.00" }],
  });

  const previous = process.env.YNAB_ENABLE_WRITES;
  delete process.env.YNAB_ENABLE_WRITES;
  try {
    const result = await applyTool.handler({ preview_token: preview.structuredContent?.preview_token });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.error_type, "writes_disabled");
    assert.equal(state.patchOrder.length, 0);
  } finally {
    restoreWritesEnv(previous);
  }
});

test("approved assignment apply writes, verifies, and prevents token reuse", async () => {
  const state = createStatefulClient();
  const tools = createYnabTools(state.client);
  const previewTool = tools.find((tool) => tool.name === "ynab_preview_assignments");
  const applyTool = tools.find((tool) => tool.name === "ynab_apply_assignment_preview");
  assert.ok(previewTool && applyTool);
  const preview = await previewTool.handler({
    month: state.month,
    assignments: [
      { category_id: "groceries", delta_currency: "-25.00" },
      { category_id: "rent", delta_currency: "25.00" },
    ],
  });

  const previous = process.env.YNAB_ENABLE_WRITES;
  process.env.YNAB_ENABLE_WRITES = "true";
  try {
    const applied = await applyTool.handler({ preview_token: preview.structuredContent?.preview_token });
    assert.equal(applied.isError, false);
    assert.deepEqual(state.patchOrder, ["groceries", "rent"]);
    assert.deepEqual(
      applied.structuredContent?.assignments.map((assignment: Record<string, unknown>) => assignment.status),
      ["verified", "verified"],
    );
    const reused = await applyTool.handler({ preview_token: preview.structuredContent?.preview_token });
    assert.equal(reused.structuredContent?.error_type, "preview_used");
  } finally {
    restoreWritesEnv(previous);
  }
});

test("apply rejects stale previews before mutation", async () => {
  const state = createStatefulClient();
  const tools = createYnabTools(state.client);
  const previewTool = tools.find((tool) => tool.name === "ynab_preview_assignments");
  const applyTool = tools.find((tool) => tool.name === "ynab_apply_assignment_preview");
  assert.ok(previewTool && applyTool);
  const preview = await previewTool.handler({
    month: state.month,
    assignments: [{ category_id: "rent", delta_currency: "10.00" }],
  });
  state.readyToAssign.set(state.month, 199_000);

  const previous = process.env.YNAB_ENABLE_WRITES;
  process.env.YNAB_ENABLE_WRITES = "true";
  try {
    const result = await applyTool.handler({ preview_token: preview.structuredContent?.preview_token });
    assert.equal(result.structuredContent?.error_type, "stale_preview");
    assert.equal(state.patchOrder.length, 0);
  } finally {
    restoreWritesEnv(previous);
  }
});

test("apply rejects a cross-month preview when an unassigned target category changes uncovered spending", async () => {
  const state = createStatefulClient();
  const tools = createYnabTools(state.client);
  const previewTool = tools.find((tool) => tool.name === "ynab_preview_assignments");
  const applyTool = tools.find((tool) => tool.name === "ynab_apply_assignment_preview");
  assert.ok(previewTool && applyTool);
  const preview = await previewTool.handler({
    month: state.futureMonth,
    guard_month: state.month,
    assignments: [{ category_id: "rent", delta_currency: "10.00" }],
  });
  const targetOverspent = state.categoriesByMonth.get(state.futureMonth)?.find(
    (category) => category.id === "overspent",
  );
  assert.ok(targetOverspent);
  targetOverspent.balance = -60_000;

  const previous = process.env.YNAB_ENABLE_WRITES;
  process.env.YNAB_ENABLE_WRITES = "true";
  try {
    const result = await applyTool.handler({ preview_token: preview.structuredContent?.preview_token });
    assert.equal(result.structuredContent?.error_type, "stale_preview");
    assert.equal(state.patchOrder.length, 0);
  } finally {
    restoreWritesEnv(previous);
  }
});

test("apply rejects an expired preview token", async () => {
  const state = createStatefulClient();
  const tools = createYnabTools(state.client);
  const previewTool = tools.find((tool) => tool.name === "ynab_preview_assignments");
  const applyTool = tools.find((tool) => tool.name === "ynab_apply_assignment_preview");
  assert.ok(previewTool && applyTool);
  const originalNow = Date.now;
  const createdAt = originalNow();
  const previous = process.env.YNAB_ENABLE_WRITES;
  process.env.YNAB_ENABLE_WRITES = "true";
  try {
    Date.now = () => createdAt;
    const preview = await previewTool.handler({
      month: state.month,
      assignments: [{ category_id: "rent", delta_currency: "10.00" }],
    });
    Date.now = () => createdAt + 6 * 60_000;
    const result = await applyTool.handler({ preview_token: preview.structuredContent?.preview_token });
    assert.equal(result.structuredContent?.error_type, "preview_expired");
    assert.equal(state.patchOrder.length, 0);
  } finally {
    Date.now = originalNow;
    restoreWritesEnv(previous);
  }
});

test("apply verifies an ambiguous network response before continuing", async () => {
  const state = createStatefulClient({ ambiguousCategoryId: "groceries" });
  const tools = createYnabTools(state.client);
  const previewTool = tools.find((tool) => tool.name === "ynab_preview_assignments");
  const applyTool = tools.find((tool) => tool.name === "ynab_apply_assignment_preview");
  assert.ok(previewTool && applyTool);
  const preview = await previewTool.handler({
    month: state.month,
    assignments: [
      { category_id: "groceries", delta_currency: "-10.00" },
      { category_id: "rent", delta_currency: "10.00" },
    ],
  });

  const previous = process.env.YNAB_ENABLE_WRITES;
  process.env.YNAB_ENABLE_WRITES = "true";
  try {
    const result = await applyTool.handler({ preview_token: preview.structuredContent?.preview_token });
    assert.equal(result.isError, false);
    assert.deepEqual(state.patchOrder, ["groceries", "rent"]);
    assert.ok(result.structuredContent?.assignments.every((assignment: Record<string, unknown>) => assignment.status === "verified"));
  } finally {
    restoreWritesEnv(previous);
  }
});

test("apply verifies an ambiguous server failure before continuing", async () => {
  const state = createStatefulClient({ ambiguousServerCategoryId: "groceries" });
  const tools = createYnabTools(state.client);
  const previewTool = tools.find((tool) => tool.name === "ynab_preview_assignments");
  const applyTool = tools.find((tool) => tool.name === "ynab_apply_assignment_preview");
  assert.ok(previewTool && applyTool);
  const preview = await previewTool.handler({
    month: state.month,
    assignments: [
      { category_id: "groceries", delta_currency: "-10.00" },
      { category_id: "rent", delta_currency: "10.00" },
    ],
  });

  const previous = process.env.YNAB_ENABLE_WRITES;
  process.env.YNAB_ENABLE_WRITES = "true";
  try {
    const result = await applyTool.handler({ preview_token: preview.structuredContent?.preview_token });
    assert.equal(result.isError, false);
    assert.deepEqual(state.patchOrder, ["groceries", "rent"]);
    assert.ok(result.structuredContent?.assignments.every(
      (assignment: Record<string, unknown>) => assignment.status === "verified",
    ));
  } finally {
    restoreWritesEnv(previous);
  }
});

test("partial apply stops after a failure and reports untouched assignments", async () => {
  const state = createStatefulClient({ failCategoryId: "rent" });
  const tools = createYnabTools(state.client);
  const previewTool = tools.find((tool) => tool.name === "ynab_preview_assignments");
  const applyTool = tools.find((tool) => tool.name === "ynab_apply_assignment_preview");
  assert.ok(previewTool && applyTool);
  const preview = await previewTool.handler({
    month: state.month,
    assignments: [
      { category_id: "groceries", delta_currency: "-10.00" },
      { category_id: "rent", delta_currency: "5.00" },
      { category_id: "hidden", delta_currency: "5.00" },
    ],
  });

  const previous = process.env.YNAB_ENABLE_WRITES;
  process.env.YNAB_ENABLE_WRITES = "true";
  try {
    const result = await applyTool.handler({ preview_token: preview.structuredContent?.preview_token });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.partial_failure, true);
    assert.deepEqual(state.patchOrder, ["groceries", "rent"]);
    const statuses = Object.fromEntries(
      result.structuredContent?.assignments.map((assignment: Record<string, unknown>) => [assignment.category_id, assignment.status]),
    );
    assert.equal(statuses.groceries, "verified");
    assert.equal(statuses.rent, "failed");
    assert.equal(statuses.hidden, "not_attempted");
  } finally {
    restoreWritesEnv(previous);
  }
});

test("apply preserves successful write outcomes when final verification fails", async () => {
  const state = createStatefulClient({ failFinalVerification: true });
  const tools = createYnabTools(state.client);
  const previewTool = tools.find((tool) => tool.name === "ynab_preview_assignments");
  const applyTool = tools.find((tool) => tool.name === "ynab_apply_assignment_preview");
  assert.ok(previewTool && applyTool);
  const preview = await previewTool.handler({
    month: state.month,
    assignments: [
      { category_id: "groceries", delta_currency: "-10.00" },
      { category_id: "rent", delta_currency: "10.00" },
    ],
  });

  const previous = process.env.YNAB_ENABLE_WRITES;
  process.env.YNAB_ENABLE_WRITES = "true";
  try {
    const result = await applyTool.handler({ preview_token: preview.structuredContent?.preview_token });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.partial_failure, false);
    assert.equal(result.structuredContent?.write_phase_completed, true);
    assert.equal(result.structuredContent?.verification_failed, true);
    assert.equal(result.structuredContent?.final_state, null);
    assert.deepEqual(state.patchOrder, ["groceries", "rent"]);
    assert.ok(result.structuredContent?.assignments.every(
      (assignment: Record<string, unknown>) => assignment.status === "applied_unverified" && assignment.ambiguous === true,
    ));

    const reused = await applyTool.handler({ preview_token: preview.structuredContent?.preview_token });
    assert.equal(reused.structuredContent?.error_type, "preview_used");
    assert.deepEqual(state.patchOrder, ["groceries", "rent"]);
  } finally {
    restoreWritesEnv(previous);
  }
});

function jsonResponse(data: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
}

function errorResponse(status: number, name: string): Response {
  return new Response(JSON.stringify({ error: { id: String(status), name, detail: name } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function restoreWritesEnv(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.YNAB_ENABLE_WRITES;
  } else {
    process.env.YNAB_ENABLE_WRITES = value;
  }
}

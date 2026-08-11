import assert from "node:assert/strict";
import test from "node:test";

import { createYnabTools } from "../src/tools.ts";
import { YnabClient } from "../src/ynab/client.ts";

function findTool(name: string, client: YnabClient) {
  const tool = createYnabTools(client).find((entry) => entry.name === name);

  if (!tool) {
    throw new Error(`Missing tool: ${name}`);
  }

  return tool;
}

test("public beta exposes curated reads plus guarded assignments", () => {
  const tools = createYnabTools(new YnabClient({ accessToken: "token-123" }));
  const names = tools.map((tool) => tool.name);
  for (const name of [
    "ynab_list_plans",
    "ynab_get_budget_snapshot",
    "ynab_list_accounts",
    "ynab_list_categories",
    "ynab_list_transactions",
    "ynab_list_payees",
    "ynab_get_month_category",
    "ynab_list_scheduled_transactions",
    "ynab_preview_assignments",
    "ynab_apply_assignment_preview",
  ]) {
    assert.ok(names.includes(name), name);
  }
  assert.equal(tools.length, 10);
});

test("ynab_list_plans returns structured plans", async () => {
  const client = new YnabClient({
    accessToken: "token-123",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          data: {
            plans: [{ id: "plan-1", name: "Household" }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });

  const tool = findTool("ynab_list_plans", client);
  const result = await tool.handler({});

  assert.equal(result.isError, false);
  assert.equal(result.structuredContent?.plans?.length, 1);
  assert.equal(result.content[0]?.text, "1 YNAB plan(s) available.");
});

test("ynab_get_budget_snapshot summarizes accounts and categories", async () => {
  let callCount = 0;

  const client = new YnabClient({
    accessToken: "token-123",
    fetchImpl: async () => {
      callCount += 1;

      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            data: {
              plans: [
                {
                  id: "active-plan",
                  name: "2026",
                  last_modified_on: "2026-04-16T22:42:12Z",
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (callCount === 2) {
        return new Response(
          JSON.stringify({
            data: {
              plan: {
                accounts: [
                  { id: "a1", name: "Checking", on_budget: true, closed: false, balance: 5_000 },
                  { id: "a2", name: "Savings", on_budget: true, closed: false, balance: 20_000 },
                ],
                category_groups: [
                  {
                    id: "g1",
                    name: "Living",
                    categories: [
                      { id: "c1", name: "Groceries", available: -1_500, hidden: false },
                      { id: "c2", name: "Rent", available: 100_000, hidden: false },
                      { id: "c3", name: "Wife birthday", balance: -59_700, hidden: false },
                      { id: "c4", name: "Delight", balance: 32_280, hidden: false },
                    ],
                  },
                ],
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          data: {
            month: {
              month: "2026-04",
              to_be_budgeted: 12_500,
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const tool = findTool("ynab_get_budget_snapshot", client);
  const result = await tool.handler({ month: "2026-04" });

  assert.equal(result.isError, false);
  assert.equal(result.structuredContent?.requested_plan_id, "default");
  assert.equal(result.structuredContent?.resolved_plan_id, "active-plan");
  assert.equal(result.structuredContent?.selected_month, "2026-04");
  assert.equal(result.structuredContent?.accounts_summary?.total_accounts, 2);
  const categorySummary = result.structuredContent?.category_summary;

  assert.equal(categorySummary?.overspent_categories?.length, 2);
  assert.deepEqual(
    categorySummary?.overspent_categories?.map((category: Record<string, unknown>) => category.name),
    ["Wife birthday", "Groceries"],
  );
  assert.equal(categorySummary?.top_available_categories?.[0]?.name, "Rent");
  assert.equal(categorySummary?.top_available_categories?.[1]?.name, "Delight");
});

test("ynab_list_categories falls back to plan categories when month payload lacks them", async () => {
  const seenUrls: string[] = [];
  let callCount = 0;

  const client = new YnabClient({
    accessToken: "token-123",
    fetchImpl: async (input) => {
      seenUrls.push(String(input));
      callCount += 1;

      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            data: {
              plans: [
                {
                  id: "active-plan",
                  name: "2026",
                  last_modified_on: "2026-04-16T22:42:12Z",
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (callCount === 2) {
        return new Response(
          JSON.stringify({
            data: {
              month: {
                month: "2026-04",
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          data: {
            category_groups: [
              {
                id: "g1",
                name: "Living",
                categories: [{ id: "c1", name: "Groceries", available: 12_345 }],
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const tool = findTool("ynab_list_categories", client);
  const result = await tool.handler({ month: "2026-04" });

  assert.equal(result.isError, false);
  assert.equal(result.structuredContent?.source, "plan");
  assert.equal(result.structuredContent?.category_groups?.length, 1);
  assert.equal(result.structuredContent?.categories?.[0]?.category_group_id, "g1");
  assert.equal(result.structuredContent?.categories?.[0]?.category_group_name, "Living");
  assert.match(seenUrls[0] ?? "", /\/plans$/);
  assert.match(seenUrls[1] ?? "", /\/months\/2026-04-01$/);
  assert.match(seenUrls[2] ?? "", /\/categories/);
});

test("ynab_list_accounts resolves the default plan id before requesting accounts", async () => {
  const seenUrls: string[] = [];
  let callCount = 0;

  const client = new YnabClient({
    accessToken: "token-123",
    fetchImpl: async (input) => {
      const url = String(input);
      seenUrls.push(url);
      callCount += 1;

      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            data: {
              plans: [
                {
                  id: "active-plan",
                  name: "2026",
                  last_modified_on: "2026-04-16T22:42:12Z",
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          data: {
            accounts: [{ id: "acc-1", name: "Checking", balance: 1_000, closed: false }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const tool = findTool("ynab_list_accounts", client);
  const result = await tool.handler({});

  assert.equal(result.isError, false);
  assert.equal(result.structuredContent?.requested_plan_id, "default");
  assert.equal(result.structuredContent?.resolved_plan_id, "active-plan");
  assert.match(seenUrls[0] ?? "", /\/plans$/);
  assert.match(seenUrls[1] ?? "", /\/plans\/active-plan\/accounts$/);
});

test("ynab_list_transactions applies filters and wraps rate limit errors", async () => {
  const client = new YnabClient({
    accessToken: "token-123",
    fetchImpl: async (input) => {
      const url = String(input);

      if (url.endsWith("/plans")) {
        return new Response(
          JSON.stringify({
            data: {
              plans: [
                {
                  id: "active-plan",
                  name: "2026",
                  last_modified_on: "2026-04-16T22:42:12Z",
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.includes("/transactions")) {
        return new Response(
          JSON.stringify({
            data: {
              transactions: [
                {
                  id: "t1",
                  date: "2026-04-03",
                  amount: -1_000,
                  account_id: "acc-1",
                  category_id: "cat-1",
                  payee_id: "payee-1",
                },
                {
                  id: "t2",
                  date: "2026-04-07",
                  amount: -2_000,
                  account_id: "acc-2",
                  category_id: "cat-1",
                  payee_id: "payee-2",
                },
                {
                  id: "t3",
                  date: "2026-03-30",
                  amount: 5_000,
                  account_id: "acc-1",
                  category_id: "cat-2",
                  payee_id: "payee-1",
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response("{}", { status: 500 });
    },
  });

  const tool = findTool("ynab_list_transactions", client);
  const result = await tool.handler({
    month: "2026-04",
    category_id: "cat-1",
    limit: 1,
  });

  assert.equal(result.isError, false);
  assert.equal(result.structuredContent?.total_matching_transactions, 2);
  assert.equal(result.structuredContent?.returned_transactions, 1);

  const rateLimitedClient = new YnabClient({
    accessToken: "token-123",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          error: {
            id: "429",
            name: "too_many_requests",
            detail: "Too many requests",
          },
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      ),
  });

  const payeesTool = findTool("ynab_list_payees", rateLimitedClient);
  const rateLimitedResult = await payeesTool.handler({});

  assert.equal(rateLimitedResult.isError, true);
  assert.equal(rateLimitedResult.structuredContent?.kind, "rate_limit");
});

test("budget snapshot returns complete uncovered totals and derived planning availability", async () => {
  const categories: Array<Record<string, any>> = Array.from({ length: 12 }, (_, index) => ({
    id: `overspent-${index}`,
    name: `Overspent ${index}`,
    balance: -1_000,
    goal_under_funded: 2_000,
    hidden: index === 0,
  }));
  categories.push(
    { id: "internal", name: "Internal", balance: -99_000, internal: true, hidden: false },
    { id: "deleted", name: "Deleted", balance: -99_000, deleted: true, hidden: false },
  );
  const client = new YnabClient({
    accessToken: "token-123",
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("/plans")) {
        return jsonResponse({ plans: [{ id: "plan-1", name: "Plan" }] });
      }
      if (url.endsWith("/plans/plan-1")) {
        return jsonResponse({ plan: { accounts: [] } });
      }
      return jsonResponse({ month: { to_be_budgeted: 20_000, categories } });
    },
  });

  const result = await findTool("ynab_get_budget_snapshot", client).handler({ month: "2026-07" });
  const summary = result.structuredContent?.category_summary;

  assert.equal(summary.overspent_categories.length, 12);
  assert.equal(summary.overspent_highlights.length, 10);
  assert.equal(summary.negative_balance_total, -12_000);
  assert.equal(summary.uncovered_spending_total_currency, 12);
  assert.equal(summary.ready_to_assign_currency, 20);
  assert.equal(summary.planning_available_after_uncovered_spending_currency, 8);
  assert.equal(summary.hidden_categories, 1);
  assert.equal(summary.underfunded_categories.length, 12);
  assert.equal(summary.underfunded_highlights.length, 10);
  assert.equal(summary.target_underfunded_total_currency, 24);
});

test("account summary separates liquid cash from credit and debt balances", async () => {
  const client = new YnabClient({
    accessToken: "token-123",
    fetchImpl: async (input) => {
      if (String(input).endsWith("/plans")) {
        return jsonResponse({ plans: [{ id: "plan-1", name: "Plan" }] });
      }
      return jsonResponse({
        accounts: [
          { id: "checking", type: "checking", on_budget: true, balance: 100_000, cleared_balance: 90_000, uncleared_balance: 10_000 },
          { id: "cash", type: "cash", on_budget: false, balance: 20_000, cleared_balance: 20_000, uncleared_balance: 0 },
          { id: "card", type: "creditCard", on_budget: true, balance: -50_000, cleared_balance: -50_000, uncleared_balance: 0 },
          { id: "loan", type: "autoLoan", on_budget: false, balance: -500_000, cleared_balance: -500_000, uncleared_balance: 0 },
        ],
      });
    },
  });

  const result = await findTool("ynab_list_accounts", client).handler({});
  const summary = result.structuredContent?.summary;
  assert.equal(summary.liquid_on_budget_balance_currency, 100);
  assert.equal(summary.liquid_on_budget_cleared_balance_currency, 90);
  assert.equal(summary.liquid_off_budget_balance_currency, 20);
  assert.equal(summary.non_liquid_balance_currency, -550);
});

test("transaction cleanup supports all dates, upstream filters, paging, and full totals", async () => {
  let transactionUrl = "";
  const client = new YnabClient({
    accessToken: "token-123",
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("/plans")) {
        return jsonResponse({ plans: [{ id: "plan-1", name: "Plan" }] });
      }
      if (url.endsWith("/plans/plan-1")) {
        return jsonResponse({ plan: { first_month: "2024-01-01" } });
      }
      transactionUrl = url;
      return jsonResponse({
        transactions: [
          { id: "t1", date: "2024-01-01", amount: -1_000, approved: false, cleared: "uncleared" },
          { id: "t2", date: "2024-02-01", amount: -2_000, approved: false, cleared: "uncleared" },
          { id: "t3", date: "2024-03-01", amount: -3_000, approved: true, cleared: "cleared" },
        ],
      });
    },
  });

  const result = await findTool("ynab_list_transactions", client).handler({
    all_dates: true,
    until_date: "2026-07-31",
    type: "unapproved",
    approved: false,
    cleared: "uncleared",
    offset: 1,
    limit: 1,
  });

  assert.match(transactionUrl, /since_date=2024-01-01/);
  assert.match(transactionUrl, /until_date=2026-07-31/);
  assert.match(transactionUrl, /type=unapproved/);
  assert.equal(result.structuredContent?.total_matching_transactions, 2);
  assert.equal(result.structuredContent?.transactions[0].id, "t2");
  assert.equal(result.structuredContent?.totals.outflow_currency, 2);
  assert.equal(result.structuredContent?.matching_totals.outflow_currency, 3);

  const invalid = await findTool("ynab_list_transactions", client).handler({
    all_dates: true,
    month: "2026-07",
  });
  assert.equal(invalid.isError, true);
});

test("exact category and scheduled horizon tools return precise structured results", async () => {
  const client = new YnabClient({
    accessToken: "token-123",
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("/plans")) {
        return jsonResponse({ plans: [{ id: "plan-1", name: "Plan" }] });
      }
      if (url.includes("/months/2026-07-01/categories/cat-1")) {
        return jsonResponse({ category: { id: "cat-1", name: "Rent", budgeted: 1_700_000 } });
      }
      return jsonResponse({
        scheduled_transactions: [
          {
            id: "split",
            date_first: "2026-07-01",
            date_next: "2026-07-01",
            frequency: "monthly",
            amount: -30_000,
            account_id: "checking",
            account_name: "Checking",
            subtransactions: [
              { category_id: "cat-1", category_name: "Rent", amount: -20_000 },
              { category_id: "cat-2", category_name: "Utilities", amount: -10_000 },
            ],
          },
          {
            id: "transfer",
            date_first: "2026-07-15",
            date_next: "2026-07-15",
            frequency: "never",
            amount: -50_000,
            account_id: "checking",
            transfer_account_id: "savings",
          },
          { id: "deleted", date_next: "2026-07-10", frequency: "never", amount: -99_000, deleted: true },
        ],
      });
    },
  });

  const categoryResult = await findTool("ynab_get_month_category", client).handler({
    month: "2026-07",
    category_id: "cat-1",
  });
  assert.equal(categoryResult.structuredContent?.category.budgeted_currency, 1700);

  const scheduledResult = await findTool("ynab_list_scheduled_transactions", client).handler({
    from_date: "2026-07-01",
    through_date: "2026-07-31",
  });
  assert.equal(scheduledResult.structuredContent?.total_occurrences, 2);
  assert.equal(scheduledResult.structuredContent?.summary.spending_outflow_currency, 30);
  assert.equal(scheduledResult.structuredContent?.summary.transfer_net_currency, -50);
  assert.equal(scheduledResult.structuredContent?.summary.by_category.length, 2);

  const tooLong = await findTool("ynab_list_scheduled_transactions", client).handler({
    from_date: "2026-01-01",
    through_date: "2027-01-02",
  });
  assert.equal(tooLong.isError, true);

  const invalidDate = await findTool("ynab_list_scheduled_transactions", client).handler({
    from_date: "2026-02-30",
    through_date: "2026-03-01",
  });
  assert.equal(invalidDate.isError, true);
});

function jsonResponse(data: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import {
  YnabApiError,
  YnabClient,
  buildQueryString,
  selectDefaultPlanId,
} from "../src/ynab/client.ts";

test("buildQueryString sorts keys and skips undefined values", () => {
  const query = buildQueryString({
    b: "two",
    a: 1,
    c: undefined,
  });

  assert.equal(query, "a=1&b=two");
});

test("YnabClient sends bearer auth headers", async () => {
  let capturedAuthorization = "";

  const client = new YnabClient({
    accessToken: "token-123",
    fetchImpl: async (_input, init) => {
      const headers = new Headers(init?.headers);
      capturedAuthorization = headers.get("authorization") ?? "";
      return new Response(JSON.stringify({ data: { plans: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await client.listPlans();

  assert.equal(capturedAuthorization, "Bearer token-123");
});

test("YnabClient uses delta requests and merges incremental responses", async () => {
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
              server_knowledge: 1,
              accounts: [
                { id: "acc-1", name: "Checking", balance: 1_000 },
                { id: "acc-2", name: "Savings", balance: 2_000 },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          data: {
            server_knowledge: 2,
            accounts: [{ id: "acc-1", balance: 1_500 }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const first = await client.listAccounts("default");
  const second = await client.listAccounts("default");

  assert.equal(first.data.accounts.length, 2);
  assert.match(seenUrls[1] ?? "", /last_knowledge_of_server=1/);
  assert.equal(second.data.accounts.length, 2);

  const changedAccount = second.data.accounts.find((account) => account.id === "acc-1");
  assert.equal(changedAccount?.balance, 1_500);
  assert.equal(changedAccount?.balance_currency, 1.5);
});

test("YnabClient maps rate limit responses into YnabApiError", async () => {
  const client = new YnabClient({
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

  await assert.rejects(
    client.listPlans(),
    (error: unknown) => {
      assert.ok(error instanceof YnabApiError);
      assert.equal(error.status, 429);
      assert.equal(error.kind, "rate_limit");
      return true;
    },
  );
});

test("YnabClient normalizes YYYY-MM month lookups to the first of the month", async () => {
  let seenUrl = "";

  const client = new YnabClient({
    accessToken: "token-123",
    fetchImpl: async (input) => {
      seenUrl = String(input);
      return new Response(
        JSON.stringify({
          data: {
            month: {
              month: "2026-04-01",
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const response = await client.getMonth("plan-1", "2026-04");

  assert.equal(response.data.month.month, "2026-04-01");
  assert.match(seenUrl, /\/plans\/plan-1\/months\/2026-04-01$/);
});

test("selectDefaultPlanId prefers active plans over archived ones", () => {
  const planId = selectDefaultPlanId([
    {
      id: "archived",
      name: "2025 (Archived on 2025-12-05)",
      last_modified_on: "2025-12-06T02:30:39Z",
    },
    {
      id: "active-older",
      name: "New plan",
      last_modified_on: "2024-11-28T14:13:35Z",
    },
    {
      id: "active-newer",
      name: "2026",
      last_modified_on: "2026-04-16T22:42:12Z",
    },
  ]);

  assert.equal(planId, "active-newer");
});

test("YnabClient resolves default plan ids through the plans list", async () => {
  const client = new YnabClient({
    accessToken: "token-123",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          data: {
            plans: [
              {
                id: "archived",
                name: "2025 (Archived on 2025-12-05)",
                last_modified_on: "2025-12-06T02:30:39Z",
              },
              {
                id: "active",
                name: "2026",
                last_modified_on: "2026-04-16T22:42:12Z",
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });

  assert.equal(await client.resolvePlanId(), "active");
  assert.equal(await client.resolvePlanId("custom-plan"), "custom-plan");
});

test("YnabClient honors YNAB's declared default plan over the fallback heuristic", async () => {
  const client = new YnabClient({
    accessToken: "token-123",
    fetchImpl: async () => new Response(JSON.stringify({
      data: {
        default_plan: { id: "declared-default" },
        plans: [
          { id: "declared-default", name: "Older plan", last_modified_on: "2025-01-01T00:00:00Z" },
          { id: "newer-plan", name: "Newer plan", last_modified_on: "2026-01-01T00:00:00Z" },
        ],
      },
    }), { status: 200 }),
  });

  assert.equal(await client.resolvePlanId(), "declared-default");
});

test("YnabClient maps an aborted request timeout into a structured API error", async () => {
  let sawTimeoutSignal = false;
  const client = new YnabClient({
    accessToken: "token-123",
    requestTimeoutMs: 10,
    fetchImpl: async (_input, init) => {
      const signal = init?.signal;
      assert.ok(signal);
      sawTimeoutSignal = true;
      throw new DOMException("The operation timed out.", "TimeoutError");
    },
  });

  await assert.rejects(client.listPlans(), (error: unknown) => {
    assert.ok(error instanceof YnabApiError);
    assert.equal(error.status, 504);
    assert.equal(error.kind, "timeout");
    return true;
  });
  assert.equal(sawTimeoutSignal, true);
});

test("YnabClient refresh bypasses and replaces delta baselines", async () => {
  const seenUrls: string[] = [];
  let callCount = 0;
  const client = new YnabClient({
    accessToken: "token-123",
    fetchImpl: async (input) => {
      seenUrls.push(String(input));
      callCount += 1;
      const knowledge = callCount === 3 ? 10 : callCount;
      return new Response(JSON.stringify({
        data: {
          server_knowledge: knowledge,
          accounts: [{ id: "acc-1", balance: knowledge * 1000 }],
        },
      }), { status: 200 });
    },
  });

  const first = await client.listAccounts("plan-1");
  const delta = await client.listAccounts("plan-1");
  const refreshed = await client.listAccounts("plan-1", true);
  const afterRefresh = await client.listAccounts("plan-1");

  assert.equal(first.meta.response_mode, "full");
  assert.equal(delta.meta.response_mode, "delta");
  assert.equal(refreshed.meta.response_mode, "full");
  assert.equal(refreshed.meta.refresh_requested, true);
  assert.doesNotMatch(seenUrls[2] ?? "", /last_knowledge_of_server/);
  assert.match(seenUrls[3] ?? "", /last_knowledge_of_server=10/);
  assert.equal(afterRefresh.data.accounts[0]?.balance, 4_000);
});

test("YnabClient refresh bypasses TTL entries", async () => {
  let callCount = 0;
  const client = new YnabClient({
    accessToken: "token-123",
    ttlMs: 60_000,
    fetchImpl: async () => {
      callCount += 1;
      return new Response(JSON.stringify({
        data: { plans: [{ id: `plan-${callCount}`, name: "Plan" }] },
      }), { status: 200 });
    },
  });

  const first = await client.listPlans();
  const cached = await client.listPlans();
  const refreshed = await client.listPlans(true);

  assert.equal(first.meta.response_mode, "full");
  assert.equal(cached.meta.response_mode, "ttl");
  assert.equal(cached.data.plans[0]?.id, "plan-1");
  assert.equal(refreshed.data.plans[0]?.id, "plan-2");
  assert.equal(callCount, 2);
});

test("YnabClient invalidates plan-scoped caches", async () => {
  const seenUrls: string[] = [];
  const client = new YnabClient({
    accessToken: "token-123",
    fetchImpl: async (input) => {
      seenUrls.push(String(input));
      return new Response(JSON.stringify({
        data: { server_knowledge: seenUrls.length, accounts: [{ id: "a1", balance: 1000 }] },
      }), { status: 200 });
    },
  });

  await client.listAccounts("plan-1");
  await client.listAccounts("plan-1");
  client.invalidatePlanCaches("plan-1");
  await client.listAccounts("plan-1");

  assert.match(seenUrls[1] ?? "", /last_knowledge_of_server=1/);
  assert.doesNotMatch(seenUrls[2] ?? "", /last_knowledge_of_server/);
});

test("YnabClient PATCHes an absolute month category budgeted amount", async () => {
  let seenMethod = "";
  let seenBody = "";
  let seenUrl = "";
  const client = new YnabClient({
    accessToken: "token-123",
    fetchImpl: async (input, init) => {
      seenUrl = String(input);
      seenMethod = init?.method ?? "";
      seenBody = String(init?.body ?? "");
      return new Response(JSON.stringify({
        data: { category: { id: "cat-1", budgeted: 123_450 }, server_knowledge: 2 },
      }), { status: 200 });
    },
  });

  const response = await client.updateMonthCategory("plan-1", "2026-08", "cat-1", 123_450);

  assert.equal(seenMethod, "PATCH");
  assert.match(seenUrl, /\/months\/2026-08-01\/categories\/cat-1$/);
  assert.deepEqual(JSON.parse(seenBody), { category: { budgeted: 123_450 } });
  assert.equal(response.data.category.budgeted_currency, 123.45);
});

test("YnabClient POSTs the supported category creation payload", async () => {
  const accessToken = randomBytes(24).toString("base64url");
  let seenMethod = "";
  let seenBody = "";
  let seenUrl = "";
  let seenAuthorization = "";
  const client = new YnabClient({
    accessToken,
    fetchImpl: async (input, init) => {
      seenUrl = String(input);
      seenMethod = init?.method ?? "";
      seenBody = String(init?.body ?? "");
      seenAuthorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify({
        data: { category: { id: "cat-new", category_group_id: "group-1", name: "Pet Care" } },
      }), { status: 201, headers: { "content-type": "application/json" } });
    },
  });

  const response = await client.createCategory("plan-1", {
    category_group_id: "group-1",
    name: "Pet Care",
  });

  assert.equal(seenMethod, "POST");
  assert.match(seenUrl, /\/plans\/plan-1\/categories$/);
  assert.equal(seenAuthorization, `Bearer ${accessToken}`);
  assert.deepEqual(JSON.parse(seenBody), {
    category: { category_group_id: "group-1", name: "Pet Care" },
  });
  assert.deepEqual(response.data.category, {
    id: "cat-new",
    category_group_id: "group-1",
    name: "Pet Care",
  });
});

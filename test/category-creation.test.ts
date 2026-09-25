import assert from "node:assert/strict";
import test from "node:test";

import { createYnabTools } from "../src/tools.ts";
import { YnabClient } from "../src/ynab/client.ts";

interface TestCategory {
  id: string;
  name: string;
  category_group_id: string;
  deleted?: boolean;
}

interface TestCategoryGroup {
  id: string;
  name: string;
  internal?: boolean;
  deleted?: boolean;
  hidden?: boolean;
  categories: TestCategory[];
}

function findTool(client: YnabClient, name: string) {
  const tool = createYnabTools(client).find((entry) => entry.name === name);
  assert.ok(tool, `Missing tool: ${name}`);
  return tool;
}

function createCategoryClient(options: {
  createStatus?: number;
  ambiguousResponse?: boolean;
} = {}) {
  const groups: TestCategoryGroup[] = [
    {
      id: "group-1",
      name: "Household",
      categories: [
        { id: "category-existing", name: "Groceries", category_group_id: "group-1" },
      ],
    },
    {
      id: "group-internal",
      name: "Internal",
      internal: true,
      categories: [],
    },
    {
      id: "group-deleted",
      name: "Deleted",
      deleted: true,
      categories: [],
    },
  ];
  let createCalls = 0;
  let createdPayload: unknown;
  let nextCategoryId = 0;
  const client = new YnabClient({
    accessToken: "token-123",
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/plans") && init?.method !== "POST") {
        return jsonResponse({ plans: [{ id: "plan-1", name: "Plan" }] });
      }
      if (url.pathname === "/v1/plans/plan-1/categories" && init?.method === "GET") {
        return jsonResponse({ category_groups: cloneGroups(groups) });
      }
      if (url.pathname === "/v1/plans/plan-1/categories" && init?.method === "POST") {
        createCalls += 1;
        createdPayload = JSON.parse(String(init.body));
        if (options.createStatus && options.createStatus !== 201) {
          return new Response(JSON.stringify({
            error: { id: String(options.createStatus), name: "validation_error", detail: "Category rejected" },
          }), {
            status: options.createStatus,
            headers: { "content-type": "application/json" },
          });
        }

        const body = createdPayload as { category: { category_group_id: string; name: string } };
        const category: TestCategory = {
          id: `category-new-${++nextCategoryId}`,
          category_group_id: body.category.category_group_id,
          name: body.category.name,
        };
        groups.find((group) => group.id === body.category.category_group_id)?.categories.push(category);
        if (options.ambiguousResponse) {
          throw new TypeError("Connection closed after YNAB created the category.");
        }
        return new Response(JSON.stringify({ data: { category } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        error: { id: "404", name: "not_found", detail: "Not found" },
      }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return {
    client,
    groups,
    createCalls: () => createCalls,
    createdPayload: () => createdPayload,
  };
}

test("category creation preview validates the target and does not write", async () => {
  const state = createCategoryClient();
  const tools = createYnabTools(state.client);
  const previewTool = tools.find((entry) => entry.name === "ynab_preview_category_creation");
  assert.ok(previewTool);

  const result = await previewTool.handler({
    category_group_id: "group-1",
    name: "  Pet Care  ",
  });

  assert.equal(result.isError, false);
  assert.equal(result.structuredContent?.requested_plan_id, "default");
  assert.equal(result.structuredContent?.resolved_plan_id, "plan-1");
  assert.equal(result.structuredContent?.category_group_name, "Household");
  assert.equal(result.structuredContent?.category_name, "Pet Care");
  assert.equal(typeof result.structuredContent?.preview_token, "string");
  assert.equal(state.createCalls(), 0);
});

test("category creation preview rejects missing, internal, deleted, duplicate, and blank inputs", async () => {
  const state = createCategoryClient();
  const previewTool = findTool(state.client, "ynab_preview_category_creation");
  const cases = [
    { category_group_id: "missing", name: "Pet Care", message: "one existing category group" },
    { category_group_id: "group-internal", name: "Pet Care", message: "internal category group" },
    { category_group_id: "group-deleted", name: "Pet Care", message: "active category group" },
    { category_group_id: "group-1", name: " groceries ", message: "already exists" },
    { category_group_id: "group-1", name: "   ", message: "non-whitespace" },
  ];

  for (const input of cases) {
    const result = await previewTool.handler(input);
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", new RegExp(input.message, "i"));
  }
  assert.equal(state.createCalls(), 0);
});

test("category creation apply requires the write gate and creates then verifies the category", async () => {
  const state = createCategoryClient();
  const tools = createYnabTools(state.client);
  const previewTool = tools.find((entry) => entry.name === "ynab_preview_category_creation");
  const applyTool = tools.find((entry) => entry.name === "ynab_apply_category_creation_preview");
  assert.ok(previewTool && applyTool);
  const preview = await previewTool.handler({ category_group_id: "group-1", name: "Pet Care" });
  const token = preview.structuredContent?.preview_token;
  const previous = process.env.YNAB_ENABLE_WRITES;
  delete process.env.YNAB_ENABLE_WRITES;
  try {
    const blocked = await applyTool.handler({ preview_token: token });
    assert.equal(blocked.structuredContent?.error_type, "writes_disabled");
    assert.equal(state.createCalls(), 0);

    process.env.YNAB_ENABLE_WRITES = "true";
    const applied = await applyTool.handler({ preview_token: token });
    assert.equal(applied.isError, false);
    assert.equal(applied.structuredContent?.write_outcome, "created_and_verified");
    assert.equal(applied.structuredContent?.category?.name, "Pet Care");
    assert.deepEqual(state.createdPayload(), {
      category: { category_group_id: "group-1", name: "Pet Care" },
    });
    assert.equal(state.createCalls(), 1);

    const reused = await applyTool.handler({ preview_token: token });
    assert.equal(reused.structuredContent?.error_type, "preview_used");
    assert.equal(state.createCalls(), 1);
  } finally {
    restoreWritesEnv(previous);
  }
});

test("category creation apply rejects a stale preview without writing", async () => {
  const state = createCategoryClient();
  const tools = createYnabTools(state.client);
  const previewTool = tools.find((entry) => entry.name === "ynab_preview_category_creation");
  const applyTool = tools.find((entry) => entry.name === "ynab_apply_category_creation_preview");
  assert.ok(previewTool && applyTool);
  const preview = await previewTool.handler({ category_group_id: "group-1", name: "Pet Care" });
  state.groups[0]!.name = "Changed after preview";

  const previous = process.env.YNAB_ENABLE_WRITES;
  process.env.YNAB_ENABLE_WRITES = "true";
  try {
    const result = await applyTool.handler({ preview_token: preview.structuredContent?.preview_token });
    assert.equal(result.structuredContent?.error_type, "stale_preview");
    assert.equal(state.createCalls(), 0);
  } finally {
    restoreWritesEnv(previous);
  }
});

test("category creation apply reports API validation failures without claiming success", async () => {
  const state = createCategoryClient({ createStatus: 400 });
  const tools = createYnabTools(state.client);
  const previewTool = tools.find((entry) => entry.name === "ynab_preview_category_creation");
  const applyTool = tools.find((entry) => entry.name === "ynab_apply_category_creation_preview");
  assert.ok(previewTool && applyTool);
  const preview = await previewTool.handler({ category_group_id: "group-1", name: "Pet Care" });

  const previous = process.env.YNAB_ENABLE_WRITES;
  process.env.YNAB_ENABLE_WRITES = "true";
  try {
    const result = await applyTool.handler({ preview_token: preview.structuredContent?.preview_token });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.status, 400);
    assert.equal(state.createCalls(), 1);
    assert.equal(state.groups[0]?.categories.some((category) => category.name === "Pet Care"), false);
  } finally {
    restoreWritesEnv(previous);
  }
});

test("category creation reconciles an ambiguous response without retrying", async () => {
  const state = createCategoryClient({ ambiguousResponse: true });
  const tools = createYnabTools(state.client);
  const previewTool = tools.find((entry) => entry.name === "ynab_preview_category_creation");
  const applyTool = tools.find((entry) => entry.name === "ynab_apply_category_creation_preview");
  assert.ok(previewTool && applyTool);
  const preview = await previewTool.handler({ category_group_id: "group-1", name: "Pet Care" });

  const previous = process.env.YNAB_ENABLE_WRITES;
  process.env.YNAB_ENABLE_WRITES = "true";
  try {
    const result = await applyTool.handler({ preview_token: preview.structuredContent?.preview_token });
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent?.write_outcome, "present_after_ambiguous_response");
    assert.equal(result.structuredContent?.category?.name, "Pet Care");
    assert.equal(state.createCalls(), 1);
  } finally {
    restoreWritesEnv(previous);
  }
});

function cloneGroups(groups: TestCategoryGroup[]): TestCategoryGroup[] {
  return groups.map((group) => ({ ...group, categories: group.categories.map((category) => ({ ...category })) }));
}

function jsonResponse(data: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
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

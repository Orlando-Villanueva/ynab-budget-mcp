import assert from "node:assert/strict";
import test from "node:test";

import { McpServer } from "../src/mcp.ts";
import { createYnabTools } from "../src/tools.ts";
import { YnabClient } from "../src/ynab/client.ts";

test("category creation completes end to end over MCP with a mock YNAB API", async () => {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const categories: Array<Record<string, unknown>> = [];
  const client = new YnabClient({
    accessToken: "test-token",
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer test-token");

      if (method === "GET" && url.pathname === "/v1/plans") {
        calls.push({ method, path: url.pathname });
        return jsonResponse({ plans: [{ id: "plan-e2e", name: "Test Plan" }] });
      }
      if (method === "GET" && url.pathname === "/v1/plans/plan-e2e/categories") {
        calls.push({ method, path: url.pathname });
        return jsonResponse({
          category_groups: [{
            id: "group-e2e",
            name: "Household",
            internal: false,
            deleted: false,
            categories: categories.map((category) => ({ ...category })),
          }],
        });
      }
      if (method === "POST" && url.pathname === "/v1/plans/plan-e2e/categories") {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          category: { category_group_id: string; name: string };
        };
        calls.push({ method, path: url.pathname, body });
        const category = {
          id: "category-e2e",
          category_group_id: body.category.category_group_id,
          category_group_name: "Household",
          name: body.category.name,
          deleted: false,
        };
        categories.push(category);
        return new Response(JSON.stringify({ data: { category } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }

      return new Response(JSON.stringify({
        error: { id: "404", name: "not_found", detail: `Unexpected request: ${method} ${url.pathname}` },
      }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const server = new McpServer({
    name: "ynab-mcp-e2e-test",
    version: "test",
    tools: createYnabTools(client),
  });

  const previousWritesSetting = process.env.YNAB_ENABLE_WRITES;
  delete process.env.YNAB_ENABLE_WRITES;
  try {
    const initialized = successResult(await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } },
    }));
    assert.equal(initialized.result.protocolVersion, "2025-06-18");

    const listed = successResult(await server.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    }));
    const exposedTools = listed.result.tools as Array<Record<string, unknown>>;
    assert.ok(exposedTools.some((tool) => tool.name === "ynab_preview_category_creation"));
    assert.ok(exposedTools.some((tool) => tool.name === "ynab_apply_category_creation_preview"));
    assert.equal(exposedTools.length, 12);

    const preview = await callTool(server, 3, "ynab_preview_category_creation", {
      category_group_id: "group-e2e",
      name: "Pet Care",
    });
    assert.equal(preview.isError, false);
    assert.equal(preview.structuredContent.category_name, "Pet Care");
    assert.equal(calls.some((call) => call.method === "POST"), false);

    const blocked = await callTool(server, 4, "ynab_apply_category_creation_preview", {
      preview_token: preview.structuredContent.preview_token,
    });
    assert.equal(blocked.isError, true);
    assert.equal(blocked.structuredContent.error_type, "writes_disabled");
    assert.equal(calls.some((call) => call.method === "POST"), false);

    process.env.YNAB_ENABLE_WRITES = "true";
    const applied = await callTool(server, 5, "ynab_apply_category_creation_preview", {
      preview_token: preview.structuredContent.preview_token,
    });
    assert.equal(applied.isError, false);
    assert.equal(applied.structuredContent.write_outcome, "created_and_verified");
    assert.equal(applied.structuredContent.category.id, "category-e2e");
    assert.equal(applied.structuredContent.category.name, "Pet Care");
    assert.deepEqual(calls.find((call) => call.method === "POST")?.body, {
      category: { category_group_id: "group-e2e", name: "Pet Care" },
    });

    const reused = await callTool(server, 6, "ynab_apply_category_creation_preview", {
      preview_token: preview.structuredContent.preview_token,
    });
    assert.equal(reused.isError, true);
    assert.equal(reused.structuredContent.error_type, "preview_used");
    assert.equal(calls.filter((call) => call.method === "POST").length, 1);
    assert.equal(calls.filter((call) => call.method === "GET" && call.path.endsWith("/categories")).length, 3);
  } finally {
    restoreWritesEnv(previousWritesSetting);
  }
});

async function callTool(
  server: McpServer,
  id: number,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, any>> {
  const response = successResult(await server.handleMessage({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  }));
  return response.result;
}

function successResult(response: unknown): Record<string, any> {
  assert.ok(response && typeof response === "object" && "result" in response);
  return response as Record<string, any>;
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

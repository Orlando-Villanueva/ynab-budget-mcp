import assert from "node:assert/strict";
import test from "node:test";

import { McpServer } from "../src/mcp.ts";

const testServer = new McpServer({
  name: "test-server",
  version: "1.0.0",
  tools: [
    {
      name: "echo",
      description: "Echo text back.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
      handler: async (argumentsObject) => ({
        content: [{ type: "text", text: String(argumentsObject.text ?? "") }],
        structuredContent: { echoed: argumentsObject.text ?? "" },
      }),
    },
  ],
});

test("McpServer initializes and lists tools", async () => {
  const initializeResponse = await testServer.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tester", version: "1.0.0" },
    },
  });

  assert.equal(successResult(initializeResponse).protocolVersion, "2025-06-18");

  const toolsResponse = await testServer.handleMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  });

  assert.equal(successResult(toolsResponse).tools?.length, 1);
  assert.equal(successResult(toolsResponse).tools?.[0]?.name, "echo");
});

test("McpServer handles tool calls and unknown tools", async () => {
  const callResponse = await testServer.handleMessage({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "echo",
      arguments: { text: "hello" },
    },
  });

  assert.equal(successResult(callResponse).content?.[0]?.text, "hello");

  const errorResponse = await testServer.handleMessage({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "missing",
      arguments: {},
    },
  });

  assert.equal(errorDetails(errorResponse).code, -32601);
});

function successResult(response: unknown): Record<string, any> {
  assert.ok(response && typeof response === "object" && "result" in response);
  return (response as { result: Record<string, any> }).result;
}

function errorDetails(response: unknown): { code: number; message: string } {
  assert.ok(response && typeof response === "object" && "error" in response);
  return (response as { error: { code: number; message: string } }).error;
}

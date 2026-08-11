export interface TextContent {
  type: "text";
  text: string;
}

export interface CallToolResult {
  content: TextContent[];
  structuredContent?: Record<string, any> | undefined;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  handler: (argumentsObject: Record<string, unknown>) => Promise<CallToolResult>;
}

interface ServerOptions {
  name: string;
  version: string;
  instructions?: string;
  tools: ToolDefinition[];
}

type RequestId = string | number | null;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: RequestId;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcErrorResponse = {
  jsonrpc: "2.0";
  id: RequestId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type JsonRpcSuccessResponse = {
  jsonrpc: "2.0";
  id: RequestId;
  result: Record<string, any>;
};

const JSON_RPC_VERSION = "2.0";
const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

export class McpServer {
  private readonly name: string;
  private readonly version: string;
  private readonly instructions: string | undefined;
  private readonly tools = new Map<string, ToolDefinition>();
  private initialized = false;

  constructor(options: ServerOptions) {
    this.name = options.name;
    this.version = options.version;
    this.instructions = options.instructions;

    for (const tool of options.tools) {
      this.tools.set(tool.name, tool);
    }
  }

  async handleMessage(rawMessage: unknown[]): Promise<Array<JsonRpcSuccessResponse | JsonRpcErrorResponse> | null>;
  async handleMessage(rawMessage: unknown): Promise<JsonRpcSuccessResponse | JsonRpcErrorResponse | null>;
  async handleMessage(rawMessage: unknown): Promise<
    | JsonRpcSuccessResponse
    | JsonRpcErrorResponse
    | Array<JsonRpcSuccessResponse | JsonRpcErrorResponse>
    | null
  > {
    if (Array.isArray(rawMessage)) {
      const responses: Array<JsonRpcSuccessResponse | JsonRpcErrorResponse> = [];

      for (const entry of rawMessage) {
        const response = await this.handleSingle(entry);
        if (response) {
          responses.push(response);
        }
      }

      return responses.length > 0 ? responses : null;
    }

    return this.handleSingle(rawMessage);
  }

  private async handleSingle(
    rawMessage: unknown,
  ): Promise<JsonRpcSuccessResponse | JsonRpcErrorResponse | null> {
    if (!isRecord(rawMessage) || rawMessage.jsonrpc !== JSON_RPC_VERSION) {
      return this.errorResponse(null, -32600, "Invalid JSON-RPC message.");
    }

    if (typeof rawMessage.method !== "string") {
      return this.errorResponse(null, -32600, "Missing JSON-RPC method.");
    }

    const hasRequestId = "id" in rawMessage;

    if (!hasRequestId) {
      this.handleNotification(rawMessage as JsonRpcNotification);
      return null;
    }

    const request = rawMessage as JsonRpcRequest;

    if (
      request.method !== "initialize" &&
      request.method !== "ping" &&
      !this.initialized
    ) {
      return this.errorResponse(
        request.id,
        -32002,
        "Server not initialized. Call initialize first.",
      );
    }

    switch (request.method) {
      case "initialize":
        return this.successResponse(request.id, this.handleInitialize(request.params));
      case "notifications/initialized":
        logServerEvent("client_initialized");
        return this.successResponse(request.id, {});
      case "ping":
        return this.successResponse(request.id, {});
      case "tools/list":
        logServerEvent("tools_list", {
          tool_count: this.tools.size,
        });
        return this.successResponse(request.id, {
          tools: [...this.tools.values()].map((tool) => this.serializeTool(tool)),
        });
      case "tools/call":
        return this.handleToolCall(request);
      case "prompts/list":
        return this.successResponse(request.id, { prompts: [] });
      case "resources/list":
        return this.successResponse(request.id, { resources: [] });
      case "resources/templates/list":
        return this.successResponse(request.id, { resourceTemplates: [] });
      default:
        return this.errorResponse(request.id, -32601, `Method not found: ${request.method}`);
    }
  }

  private handleNotification(notification: JsonRpcNotification): void {
    if (notification.method === "notifications/initialized") {
      return;
    }
  }

  private handleInitialize(params?: Record<string, unknown>): Record<string, unknown> {
    const requestedVersion = typeof params?.protocolVersion === "string"
      ? params.protocolVersion
      : undefined;
    const negotiatedVersion = requestedVersion &&
        SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)
      ? requestedVersion
      : SUPPORTED_PROTOCOL_VERSIONS[0];

    this.initialized = true;
    logServerEvent("initialize", {
      requested_protocol_version: requestedVersion ?? "unknown",
      negotiated_protocol_version: negotiatedVersion,
      tool_count: this.tools.size,
    });

    return {
      protocolVersion: negotiatedVersion,
      capabilities: {
        tools: {
          listChanged: false,
        },
      },
      serverInfo: {
        name: this.name,
        version: this.version,
      },
      instructions: this.instructions,
    };
  }

  private async handleToolCall(
    request: JsonRpcRequest,
  ): Promise<JsonRpcSuccessResponse | JsonRpcErrorResponse> {
    const name = typeof request.params?.name === "string" ? request.params.name : undefined;

    if (!name) {
      return this.errorResponse(request.id, -32602, "Tool name is required.");
    }

    const tool = this.tools.get(name);

    if (!tool) {
      logServerEvent("tool_call_unknown", { tool_name: name });
      return this.errorResponse(request.id, -32601, `Unknown tool: ${name}`);
    }

    const argumentsObject = isRecord(request.params?.arguments)
      ? request.params.arguments
      : {};

    try {
      logServerEvent("tool_call_start", {
        tool_name: name,
        argument_keys: Object.keys(argumentsObject).sort(),
      });
      const result = await tool.handler(argumentsObject);
      logServerEvent("tool_call_finish", {
        tool_name: name,
        is_error: result.isError ?? false,
      });
      return this.successResponse(request.id, {
        content: result.content,
        structuredContent: result.structuredContent,
        isError: result.isError ?? false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tool execution failed.";
      logServerEvent("tool_call_exception", {
        tool_name: name,
        error_message: message,
      });
      return this.errorResponse(request.id, -32603, message);
    }
  }

  private serializeTool(tool: ToolDefinition): Record<string, unknown> {
    return {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    };
  }

  private successResponse(
    id: RequestId,
    result: Record<string, unknown>,
  ): JsonRpcSuccessResponse {
    return {
      jsonrpc: JSON_RPC_VERSION,
      id,
      result,
    };
  }

  private errorResponse(
    id: RequestId,
    code: number,
    message: string,
    data?: unknown,
  ): JsonRpcErrorResponse {
    return {
      jsonrpc: JSON_RPC_VERSION,
      id,
      error: {
        code,
        message,
        data,
      },
    };
  }
}

export async function runStdioServer(server: McpServer): Promise<void> {
  process.stdin.setEncoding("utf8");

  let buffer = "";

  for await (const chunk of process.stdin) {
    buffer += chunk;

    while (true) {
      const newlineIndex = buffer.indexOf("\n");

      if (newlineIndex === -1) {
        break;
      }

      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "").trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (!line) {
        continue;
      }

      let parsedMessage: unknown;

      try {
        parsedMessage = JSON.parse(line);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown parse error";
        process.stderr.write(`[ynab-mcp] Ignored invalid JSON input: ${message}\n`);
        continue;
      }

      const response = await server.handleMessage(parsedMessage);

      if (response === null) {
        continue;
      }

      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  }
}

export function textResult(
  text: string,
  structuredContent?: Record<string, any>,
): CallToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent,
    isError: false,
  };
}

export function errorResult(
  text: string,
  structuredContent?: Record<string, any>,
): CallToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent,
    isError: true,
  };
}

function logServerEvent(event: string, details: Record<string, unknown> = {}): void {
  const payload = {
    timestamp: new Date().toISOString(),
    event,
    ...details,
  };
  process.stderr.write(`[ynab-mcp] ${JSON.stringify(payload)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

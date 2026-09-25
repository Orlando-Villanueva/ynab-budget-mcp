import { McpServer, runStdioServer } from "./mcp.ts";
import { createYnabTools } from "./tools.ts";
import { YnabClient } from "./ynab/client.ts";

const client = new YnabClient();
const server = new McpServer({
  name: "ynab-mcp",
  version: "0.4.0-beta.4",
  instructions:
    "Curated YNAB budget reads plus experimental, opt-in assignment and category-creation workflows. Reads and previews do not change YNAB. Apply a write only after the user explicitly approves its exact, fresh preview and YNAB_ENABLE_WRITES=true. Identify the requested plan explicitly; do not assume the default plan is the right one.",
  tools: createYnabTools(client),
});

if (!process.env.YNAB_ACCESS_TOKEN) {
  process.stderr.write(
    "[ynab-mcp] YNAB_ACCESS_TOKEN is not configured yet. Tool calls will fail until it is set.\n",
  );
}

runStdioServer(server).catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[ynab-mcp] Fatal error: ${message}\n`);
  process.exitCode = 1;
});

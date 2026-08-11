# YNAB Budget MCP

A local [Model Context Protocol](https://modelcontextprotocol.io/) server that gives AI assistants a focused, guarded way to understand YNAB budget data.

## For AI-assistant users

Use this when you want an MCP-capable assistant to help you understand your YNAB budget without giving it unrestricted control. It can inspect plans, budget snapshots, accounts, categories, transactions, scheduled transactions, and payees. It is not financial advice and does not replace your own review of your budget.

Examples of useful requests include:

- “Which categories are overspent this month?”
- “Show my uncategorized transactions from the last two weeks.”
- “What scheduled transactions are due in the next 30 days?”
- “Preview assigning $100 to Groceries, but do not apply it.”

### You stay in control

All budget reads and assignment previews are read-only. The only write capability is an intentionally narrow, **experimental** category-assignment workflow:

1. Your assistant creates a preview containing the exact category changes and planning-availability checks.
2. You review and explicitly approve that exact preview.
3. Applying it additionally requires `YNAB_ENABLE_WRITES=true`, a fresh single-use token, and an unchanged YNAB state.

The server runs locally, sends requests directly to YNAB, and has no telemetry or persistent storage.

### Connect it to your assistant

You need Node.js 22.9+ and a YNAB Personal Access Token from [YNAB developer settings](https://app.ynab.com/settings/developer).

Install the package:

```bash
npm install -g ynab-budget-mcp
```

Then add this stdio server to your MCP-capable assistant. For example, in Codex:

```json
{
  "command": "ynab-mcp",
  "env": {
    "YNAB_ACCESS_TOKEN": "your-token"
  }
}
```

The same command works with any MCP client that supports stdio servers. If you prefer not to install globally, use `npx -y ynab-budget-mcp`, or install it in a project and set `command` to `./node_modules/.bin/ynab-mcp`.

Keep the token private. It grants access to the YNAB data available to it; never add it to a repository, issue, screenshot, or shared configuration file.

## For developers and maintainers

This section is for working on the MCP itself rather than simply using it with an assistant.

### Run from source

Clone the repository, install its development dependencies, and create a local token file:

```bash
git clone https://github.com/Orlando-Villanueva/ynab-budget-mcp.git
cd ynab-budget-mcp
npm ci
cp .env.example .env
```

Set `YNAB_ACCESS_TOKEN` in your uncommitted `.env`. To permit a real, explicitly approved assignment apply during a local session, also set `YNAB_ENABLE_WRITES=true`; leave it unset for normal development and testing.

Start the local stdio server with:

```bash
npm run start
```

For an MCP client to use your source checkout directly, configure it with a portable path and working directory:

```json
{
  "command": "node",
  "args": [
    "--env-file-if-exists=.env",
    "--experimental-transform-types",
    "src/index.ts"
  ],
  "cwd": "/absolute/path/to/ynab-budget-mcp"
}
```

This local-development configuration is separate from the published-package setup above. You can keep using an installed release while developing changes in another checkout.

### Verify changes

```bash
npm test
npm run check
```

`npm run check` builds the package and runs the test suite. The project intentionally has no runtime dependencies; TypeScript build tools are development-only.

## Security, privacy, and support

See [SECURITY.md](SECURITY.md) for security and privacy expectations, and [SUPPORT.md](SUPPORT.md) for support expectations.

This project is not affiliated with, endorsed by, or sponsored by YNAB. YNAB is a trademark of its respective owner.

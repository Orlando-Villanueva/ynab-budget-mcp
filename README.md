# YNAB Budget MCP

[![npm version](https://img.shields.io/npm/v/ynab-budget-mcp?label=npm)](https://www.npmjs.com/package/ynab-budget-mcp)

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

#### Ask your agent to install it

If your AI assistant supports local stdio MCP servers, copy and paste this prompt into it. The linked README is the source of truth; the agent should use the instructions for its own client.

```text
Please install YNAB Budget MCP for me, following the canonical instructions at https://github.com/Orlando-Villanueva/ynab-budget-mcp#connect-it-to-your-assistant.

Use the published npm package, not a repository clone or local source checkout. Follow the generic terminal setup unless this is Codex, in which case use the Codex CLI or Codex app instructions. When the MCP configuration requires my YNAB token, stop and tell me to enter it myself in this client's MCP server Environment variables or Secrets field, using the exact key `YNAB_ACCESS_TOKEN`. Do not ask me to paste the token into chat, a command, a project file, or any shared configuration. Leave `YNAB_ENABLE_WRITES` unset. When setup is complete, tell me how to verify the MCP connected successfully.
```

#### Generic terminal setup

Install the published package:

```bash
npm install -g ynab-budget-mcp@beta
```

Then add a local stdio MCP server in your assistant's settings with:

| Field | Value |
| --- | --- |
| Command | `ynab-mcp` |
| Environment variable or secret | `YNAB_ACCESS_TOKEN` = your YNAB Personal Access Token |
| Working directory | Leave blank |

Enter the token in the assistant's MCP **Environment variables** or **Secrets** field—not in a repository `.env` file, an issue, a screenshot, or a chat message. Every MCP client labels this screen differently, but the variable name is always `YNAB_ACCESS_TOKEN`.

If your MCP client uses JSON configuration, this is the generic server definition:

```json
{
  "command": "ynab-mcp",
  "env": {
    "YNAB_ACCESS_TOKEN": "your-token"
  }
}
```

#### Codex CLI

In Terminal, run the following. It uses a hidden token prompt, then saves a local Codex MCP configuration without requiring a repository checkout:

```zsh
read -s "YNAB_ACCESS_TOKEN?Paste your YNAB access token: "
echo
codex mcp add ynab \
  --env "YNAB_ACCESS_TOKEN=$YNAB_ACCESS_TOKEN" \
  -- npx -y ynab-budget-mcp@beta
unset YNAB_ACCESS_TOKEN
```

Restart Codex, then run `codex mcp get ynab` to confirm the server is configured.

#### Codex app

In Codex, open **Plugins**, choose **Add** → **MCP server**, and create a stdio server with these values:

| Field | Value |
| --- | --- |
| Command | `npx` |
| Arguments | `-y`, `ynab-budget-mcp@beta` |
| Environment variable | `YNAB_ACCESS_TOKEN` = your YNAB Personal Access Token |
| Working directory | Leave blank |

Save the server and restart Codex. This downloads the published package when needed; no repository clone, local `.env`, or global installation is required.

#### Other MCP clients

If you prefer not to install globally, configure your client to run `npx -y ynab-budget-mcp@beta` instead. The following JSON is one generic example; it is **not** a Codex configuration file:

```json
{
  "command": "npx",
  "args": ["-y", "ynab-budget-mcp@beta"],
  "env": {
    "YNAB_ACCESS_TOKEN": "your-token"
  }
}
```

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

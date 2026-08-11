# AGENTS.md

## Purpose

This repository contains a local MCP server for YNAB.
It lets MCP-capable agents query budgeting data through curated tools instead of raw shell commands.

## Project Shape

- Runtime: Node.js 22.9+
- Language: TypeScript executed directly with Node's `--experimental-transform-types`
- Package manager: npm
- Test runner: `node:test`
- Dependencies: intentionally minimal; prefer built-in Node features unless a dependency is clearly justified

## Core Files

- `README.md`: setup, usage, MCP client configuration, and smoke-test instructions
- `src/index.ts`: process entrypoint that constructs the client, registers tools, and starts the stdio server
- `src/mcp.ts`: lightweight MCP/JSON-RPC server implementation over stdio
- `src/tools.ts`: public `ynab_*` tool definitions, input validation, summaries, and error wrapping
- `src/ynab/client.ts`: YNAB API client, auth, query building, delta caching, and error mapping
- `src/ynab/normalize.ts`: milliunit-to-currency normalization helpers
- `test/*.test.ts`: protocol, client, and tool behavior tests

## Commands

- Start server: `npm run start`
- Run tests: `npm test`

## Environment

- Required env var: `YNAB_ACCESS_TOKEN`
- Keep secrets in `.env` or local environment variables
- Never hardcode tokens or include them in test fixtures, prompts, logs, or committed files

## Implementation Rules

- Keep the tool surface curated and read-only by default; guarded assignment preview/apply is the sole experimental opt-in write workflow
- Do not add generic raw endpoint passthrough tools unless explicitly requested
- Prefer `/v1/plans` endpoints over legacy `/budgets` paths
- Preserve raw milliunit values and add normalized `*_currency` fields where helpful
- Keep caching in-memory only unless persistent caching is explicitly requested
- Use clear structured errors for auth failures, rate limits, not founds, and upstream failures

## Editing Guidance

- Prefer small, focused changes
- Maintain the current layered structure: MCP transport, tool layer, YNAB client, normalization helpers
- Add or update tests with behavior changes
- Prefer built-in Node APIs over pulling in new packages
- Avoid writing to stdout outside MCP protocol responses; use stderr for diagnostics

## Notes For Agents

- This repo uses a user-supplied Personal Access Token, not multi-user OAuth flows
- If expanding functionality, default to adding new explicit read-only tools rather than widening existing tool behavior
- If write support is ever added, treat it as a separate safety boundary with explicit user approval

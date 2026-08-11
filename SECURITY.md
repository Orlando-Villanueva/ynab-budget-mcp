# Security and privacy

`YNAB_ACCESS_TOKEN` grants access to the YNAB data available to that token. Keep it in a local environment variable or uncommitted `.env` file; never commit, log, or share it.

This server runs locally and sends requests directly to YNAB's API. It does not include telemetry or persistent storage. The experimental assignment apply tool is disabled by default and requires both `YNAB_ENABLE_WRITES=true` and a fresh, explicitly approved preview token.

For a security issue, open a private report through the repository host if available. Do not include access tokens or private budget data in an issue.

# Maintainer releases

This is a maintainer workflow. Contributors are not responsible for choosing versions, creating tags, publishing packages, or changing npm dist-tags.

## When to prepare a release

Treat a merged change to `main` that changes package contents as a pending release candidate. Before its PR is merged, the maintainer should update the package version, package lock, MCP server version, and changelog.

Documentation or repository-only changes that are not shipped in the npm package do not require an npm release.

## Approval gate

After a qualifying merge, an agent must report the pending version and ask the upstream maintainer for explicit approval before any external release action. It must not silently create a tag, GitHub Release, npm publication, or dist-tag change.

The approval prompt must name the exact version and actions, including the intended npm dist-tags.

## Release steps

After explicit approval:

1. Confirm `main`, the merge commit, and required CI checks.
2. Run `npm run check`.
3. Build and pack the package, then install the tarball in a clean temporary consumer and verify MCP initialization and tool discovery.
4. Create and push tag `v<version>` on the release commit.
5. Create the matching GitHub pre-release.
6. Publish `ynab-budget-mcp@<version>` to npm with the approved dist-tag or tags.
7. Verify the published version and dist-tags with `npm view ynab-budget-mcp version dist-tags --json`.
8. Report the release, the commit/tag, validation evidence, and the exact update command for users.

Never request, print, or commit npm tokens. If npm requires interactive 2FA or WebAuthn, pause for the maintainer to complete it.

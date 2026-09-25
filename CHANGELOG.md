# Changelog

## 0.4.0-beta.4 - 2026-09-24

- Add a guarded category-creation preview/apply workflow with explicit plan and group validation, duplicate checks, stale-state protection, and post-write verification.
- Update MCP guidance to describe both experimental write workflows and require explicit plan selection.

## 0.4.0-beta.3 - 2026-08-22

- Allow guarded assignment previews for explicitly approved partial assignments and cross-month reallocations when uncovered spending or negative Ready to Assign remains.
- Report decision-grade target and guard month effects: before/after Ready to Assign, uncovered spending, every remaining uncovered category, warnings, and cross-month comparison details.
- Preserve exact, short-lived, single-use preview tokens and stale-state verification before mutation.

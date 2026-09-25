import { createHash, randomBytes } from "node:crypto";

import {
  errorResult,
  textResult,
  type CallToolResult,
  type ToolDefinition,
} from "./mcp.ts";
import {
  YnabApiError,
  YnabClient,
  YnabConfigurationError,
} from "./ynab/client.ts";

interface CategoryCreationPreview {
  token: string;
  expiresAt: number;
  used: boolean;
  requestedPlanId: string;
  planId: string;
  categoryGroupId: string;
  categoryGroupName: string;
  categoryName: string;
  fingerprint: string;
}

const PREVIEW_TTL_MS = 5 * 60_000;

export function createCategoryCreationTools(client: YnabClient): ToolDefinition[] {
  const previews = new Map<string, CategoryCreationPreview>();

  return [
    {
      name: "ynab_preview_category_creation",
      title: "Preview YNAB Category Creation",
      description:
        "Validate a new category name and category group, then create a short-lived preview token without changing YNAB.",
      inputSchema: {
        type: "object",
        required: ["category_group_id", "name"],
        properties: {
          plan_id: { type: "string", description: 'YNAB plan id. Defaults to "default".' },
          category_group_id: { type: "string", description: "Existing category group id." },
          name: { type: "string", description: "Name for the new category." },
        },
      },
      annotations: {
        title: "Preview YNAB Category Creation",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (args) => wrapCategoryCreationErrors(async () => {
        purgeExpiredPreviews(previews);
        const requestedPlanId = readOptionalString(args.plan_id) ?? "default";
        const categoryGroupId = readRequiredString(args.category_group_id, "category_group_id");
        const categoryName = readCategoryName(args.name);
        const planId = await client.resolvePlanId(requestedPlanId, true);
        const groups = await loadCategoryGroups(client, planId);
        const categoryGroup = requireWritableCategoryGroup(groups, categoryGroupId, categoryName);
        const fingerprint = fingerprintGroups(groups);
        const token = randomBytes(32).toString("base64url");
        const expiresAt = Date.now() + PREVIEW_TTL_MS;
        previews.set(token, {
          token,
          expiresAt,
          used: false,
          requestedPlanId,
          planId,
          categoryGroupId,
          categoryGroupName: readRecordString(categoryGroup, "name") ?? "",
          categoryName,
          fingerprint,
        });

        return textResult("Category creation preview is valid. Apply it only after explicit user approval.", {
          requested_plan_id: requestedPlanId,
          resolved_plan_id: planId,
          category_group_id: categoryGroupId,
          category_group_name: readRecordString(categoryGroup, "name"),
          category_group_hidden: categoryGroup.hidden === true,
          category_name: categoryName,
          preview_token: token,
          expires_at: new Date(expiresAt).toISOString(),
        });
      }),
    },
    {
      name: "ynab_apply_category_creation_preview",
      title: "Apply Approved YNAB Category Creation Preview",
      description:
        "Create a category only after explicit approval of its short-lived preview; requires YNAB_ENABLE_WRITES=true and verifies the result.",
      inputSchema: {
        type: "object",
        required: ["preview_token"],
        properties: {
          preview_token: { type: "string" },
        },
      },
      annotations: {
        title: "Apply Approved YNAB Category Creation Preview",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async (args) => wrapCategoryCreationErrors(async () => {
        if (process.env.YNAB_ENABLE_WRITES !== "true") {
          return errorResult("YNAB writes are disabled. Set YNAB_ENABLE_WRITES=true and restart the server.", {
            error_type: "writes_disabled",
          });
        }

        const token = readRequiredString(args.preview_token, "preview_token");
        const preview = previews.get(token);
        if (!preview) {
          return errorResult("The category creation preview token is unknown.", {
            error_type: "preview_not_found",
          });
        }
        if (preview.used) {
          return errorResult("The category creation preview token has already been used.", {
            error_type: "preview_used",
          });
        }
        if (preview.expiresAt <= Date.now()) {
          previews.delete(token);
          return errorResult("The category creation preview token has expired.", {
            error_type: "preview_expired",
          });
        }

        const freshGroups = await loadCategoryGroups(client, preview.planId);
        if (fingerprintGroups(freshGroups) !== preview.fingerprint) {
          return errorResult("YNAB categories changed after this preview. Create and approve a new preview.", {
            error_type: "stale_preview",
          });
        }
        requireWritableCategoryGroup(freshGroups, preview.categoryGroupId, preview.categoryName);

        // Category creation is not idempotent. Consume the token before sending the request so an
        // ambiguous network outcome cannot lead to a duplicate when the same preview is retried.
        preview.used = true;
        let creation: Awaited<ReturnType<typeof client.createCategory>>;
        try {
          creation = await client.createCategory(preview.planId, {
            category_group_id: preview.categoryGroupId,
            name: preview.categoryName,
          });
        } catch (error) {
          client.invalidatePlanCaches(preview.planId);
          if (!isAmbiguousCreateError(error)) {
            throw error;
          }
          return await verifyAmbiguousCreation(client, preview, error);
        }

        client.invalidatePlanCaches(preview.planId);
        let verifiedGroups: Record<string, unknown>[];
        try {
          verifiedGroups = await loadCategoryGroups(client, preview.planId);
        } catch (error) {
          return errorResult("YNAB accepted category creation, but the final state could not be verified.", {
            resolved_plan_id: preview.planId,
            category_group_id: preview.categoryGroupId,
            category_name: preview.categoryName,
            write_outcome: "accepted_unverified",
            verification_failed: true,
            verification_error: errorMessage(error),
          });
        }

        const created = asRecord(creation.data.category);
        const createdId = readRecordString(created, "id");
        const verifiedCategory = findCreatedCategory(
          verifiedGroups,
          preview,
          createdId,
        );
        if (!verifiedCategory) {
          return errorResult("YNAB accepted category creation, but the requested category was not found during verification.", {
            resolved_plan_id: preview.planId,
            category_group_id: preview.categoryGroupId,
            category_name: preview.categoryName,
            created_category_id: createdId ?? null,
            write_outcome: "accepted_unverified",
            verification_failed: true,
          });
        }

        return textResult("The new category was created and verified.", {
          requested_plan_id: preview.requestedPlanId,
          resolved_plan_id: preview.planId,
          category_group_id: preview.categoryGroupId,
          category_group_name: preview.categoryGroupName,
          write_outcome: "created_and_verified",
          category: verifiedCategory,
          meta: {
            create: creation.meta,
            verification: "fresh_category_list",
          },
        });
      }),
    },
  ];
}

async function verifyAmbiguousCreation(
  client: YnabClient,
  preview: CategoryCreationPreview,
  originalError: unknown,
): Promise<CallToolResult> {
  let groups: Record<string, unknown>[];
  try {
    groups = await loadCategoryGroups(client, preview.planId);
  } catch (verificationError) {
    return errorResult("The category create response was ambiguous, and YNAB could not be checked afterward.", {
      resolved_plan_id: preview.planId,
      category_group_id: preview.categoryGroupId,
      category_name: preview.categoryName,
      write_outcome: "ambiguous_unverified",
      write_error: errorMessage(originalError),
      verification_error: errorMessage(verificationError),
      retry_guidance: "Check the category list before attempting another creation.",
    });
  }

  const matches = findNamedCategories(groups, preview.categoryGroupId, preview.categoryName);
  if (matches.length === 1) {
    return textResult("The requested category is present after an ambiguous create response; no retry was made.", {
      requested_plan_id: preview.requestedPlanId,
      resolved_plan_id: preview.planId,
      category_group_id: preview.categoryGroupId,
      category_group_name: preview.categoryGroupName,
      write_outcome: "present_after_ambiguous_response",
      category: matches[0],
      write_error: errorMessage(originalError),
      verification: "fresh_category_list",
    });
  }

  return errorResult("The category create response was ambiguous, and verification did not find exactly one matching category.", {
    resolved_plan_id: preview.planId,
    category_group_id: preview.categoryGroupId,
    category_name: preview.categoryName,
    matching_category_count: matches.length,
    write_outcome: "ambiguous_unverified",
    write_error: errorMessage(originalError),
    retry_guidance: "Check the category list before attempting another creation.",
  });
}

async function loadCategoryGroups(
  client: YnabClient,
  planId: string,
): Promise<Record<string, unknown>[]> {
  const response = await client.listCategories(planId, true);
  return asArray(response.data.category_groups).map(asRecord);
}

function requireWritableCategoryGroup(
  groups: Record<string, unknown>[],
  categoryGroupId: string,
  categoryName: string,
): Record<string, unknown> {
  const matches = groups.filter((group) => readRecordString(group, "id") === categoryGroupId);
  if (matches.length !== 1) {
    throw new Error("category_group_id must identify one existing category group in the selected plan.");
  }

  const group = matches[0];
  if (!group || group.deleted === true) {
    throw new Error("category_group_id must identify an active category group.");
  }
  if (group.internal === true) {
    throw new Error("YNAB does not allow creating categories in an internal category group.");
  }

  const duplicate = asArray(group.categories)
    .map(asRecord)
    .find((category) => category.deleted !== true && sameName(readRecordString(category, "name"), categoryName));
  if (duplicate) {
    throw new Error("A category with this name already exists in the selected category group.");
  }

  return group;
}

function fingerprintGroups(groups: Record<string, unknown>[]): string {
  const structure = groups.map((group) => ({
    id: readRecordString(group, "id") ?? null,
    name: readRecordString(group, "name") ?? null,
    hidden: group.hidden === true,
    internal: group.internal === true,
    deleted: group.deleted === true,
    categories: asArray(group.categories)
      .map(asRecord)
      .map((category) => ({
        id: readRecordString(category, "id") ?? null,
        name: readRecordString(category, "name") ?? null,
        internal: category.internal === true,
        deleted: category.deleted === true,
      }))
      .sort((left, right) => String(left.id).localeCompare(String(right.id))),
  })).sort((left, right) => String(left.id).localeCompare(String(right.id)));

  return createHash("sha256").update(JSON.stringify(structure)).digest("hex");
}

function findCreatedCategory(
  groups: Record<string, unknown>[],
  preview: CategoryCreationPreview,
  createdId: string | undefined,
): Record<string, unknown> | undefined {
  const candidates = findNamedCategories(groups, preview.categoryGroupId, preview.categoryName);
  if (createdId) {
    return candidates.find((category) => readRecordString(category, "id") === createdId);
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

function findNamedCategories(
  groups: Record<string, unknown>[],
  categoryGroupId: string,
  categoryName: string,
): Record<string, unknown>[] {
  const group = groups.find((candidate) => readRecordString(candidate, "id") === categoryGroupId);
  return asArray(group?.categories)
    .map(asRecord)
    .filter((category) => category.deleted !== true)
    .filter((category) => sameName(readRecordString(category, "name"), categoryName));
}

function sameName(candidate: string | undefined, expected: string): boolean {
  return candidate !== undefined && candidate.trim().toLowerCase() === expected.toLowerCase();
}

function readCategoryName(value: unknown): string {
  const name = readRequiredString(value, "name").trim();
  if (!name) {
    throw new Error("name must contain at least one non-whitespace character.");
  }
  return name;
}

function readOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("Expected a string value.");
  }
  return value;
}

function readRequiredString(value: unknown, key: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} must be a non-empty string.`);
  }
  return value;
}

function readRecordString(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] as string : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function purgeExpiredPreviews(previews: Map<string, CategoryCreationPreview>): void {
  const now = Date.now();
  for (const [token, preview] of previews) {
    if (preview.expiresAt <= now) {
      previews.delete(token);
    }
  }
}

function isAmbiguousCreateError(error: unknown): boolean {
  return !(error instanceof YnabApiError) || error.status >= 500 || error.status === 429;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error.";
}

async function wrapCategoryCreationErrors(
  callback: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await callback();
  } catch (error) {
    if (error instanceof YnabConfigurationError) {
      return errorResult(error.message, { error_type: error.name });
    }
    if (error instanceof YnabApiError) {
      return errorResult(error.message, error.toStructured());
    }
    if (error instanceof Error) {
      return errorResult(error.message, { error_type: error.name });
    }
    return errorResult("Unknown category creation tool failure.");
  }
}

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

interface AssignmentInput {
  categoryId: string;
  deltaCurrency: string;
  delta: number;
}

interface PreviewAssignment extends AssignmentInput {
  categoryName: string | null;
  currentBudgeted: number;
  projectedBudgeted: number;
  currentBalance: number;
  projectedBalance: number;
  hidden: boolean;
}

interface PreviewRecord {
  token: string;
  expiresAt: number;
  used: boolean;
  planId: string;
  month: string;
  guardMonth: string;
  assignments: PreviewAssignment[];
  fingerprint: string;
}

interface LoadedAssignmentState {
  plan: Record<string, unknown>;
  targetMonth: Record<string, unknown>;
  guardMonth: Record<string, unknown>;
  categories: Record<string, unknown>[];
  fingerprint: string;
}

const PREVIEW_TTL_MS = 5 * 60_000;
const MAX_ASSIGNMENTS = 50;

export function createAssignmentTools(client: YnabClient): ToolDefinition[] {
  const previews = new Map<string, PreviewRecord>();

  return [
    {
      name: "ynab_preview_assignments",
      title: "Preview YNAB Assignments",
      description:
        "Freshly validate exact category assignment deltas and create a short-lived preview token without changing YNAB.",
      inputSchema: {
        type: "object",
        required: ["month", "assignments"],
        properties: {
          plan_id: { type: "string", description: 'YNAB plan id. Defaults to "default".' },
          month: { type: "string", pattern: "^\\d{4}-\\d{2}$" },
          guard_month: {
            type: "string",
            pattern: "^\\d{4}-\\d{2}$",
            description: "Required for future-month assignments; constrains usable funds.",
          },
          assignments: {
            type: "array",
            minItems: 1,
            maxItems: MAX_ASSIGNMENTS,
            items: {
              type: "object",
              required: ["category_id", "delta_currency"],
              properties: {
                category_id: { type: "string" },
                delta_currency: {
                  type: "string",
                  description: 'Canonical decimal string such as "1700.00" or "-25.50".',
                },
              },
            },
          },
        },
      },
      annotations: {
        title: "Preview YNAB Assignments",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (args) => wrapAssignmentErrors(async () => {
        purgeExpiredPreviews(previews);
        const requestedPlanId = readOptionalString(args.plan_id) ?? "default";
        const month = readMonth(args.month, "month");
        const current = currentMonth();

        if (month < current) {
          throw new Error("month must be the current month or a future month.");
        }

        const providedGuardMonth = args.guard_month === undefined
          ? undefined
          : readMonth(args.guard_month, "guard_month");
        if (month > current && !providedGuardMonth) {
          throw new Error("guard_month is required for future-month assignments.");
        }
        const guardMonth = providedGuardMonth ?? month;
        if (guardMonth < current || guardMonth > month) {
          throw new Error("guard_month must be between the current month and the target month.");
        }

        const planId = await client.resolvePlanId(requestedPlanId, true);
        const planResponse = await client.getPlan(planId, true);
        const plan = asRecord(planResponse.data.plan);
        const decimalDigits = readCurrencyDecimalDigits(plan);
        const assignments = parseAssignments(args.assignments, decimalDigits);
        const state = await loadState(
          client,
          planId,
          month,
          guardMonth,
          assignments.map((assignment) => assignment.categoryId),
          plan,
        );
        const previewAssignments = buildPreviewAssignments(assignments, state.categories);
        const netDelta = previewAssignments.reduce((total, item) => total + item.delta, 0);
        const targetReadyToAssign = readMoney(state.targetMonth, "to_be_budgeted");
        const guardReadyToAssign = readMoney(state.guardMonth, "to_be_budgeted");
        const guardUncovered = summarizeUncovered(state.guardMonth).uncovered;
        const projectedTargetReadyToAssign = targetReadyToAssign - netDelta;
        const guardPlanningAvailable = guardReadyToAssign - guardUncovered;
        const projectedGuardReadyToAssign = guardReadyToAssign - netDelta;
        const projectedGuardUncovered = month === guardMonth
          ? summarizeProjectedUncovered(state.guardMonth, previewAssignments)
          : guardUncovered;
        const projectedGuardPlanningAvailable =
          projectedGuardReadyToAssign - projectedGuardUncovered;

        if (projectedTargetReadyToAssign < 0) {
          throw new Error("The assignment batch would make target-month Ready to Assign negative.");
        }
        if (projectedGuardPlanningAvailable < 0) {
          throw new Error("The assignment batch exceeds guard-month planning availability after uncovered spending.");
        }

        const token = randomBytes(32).toString("base64url");
        const expiresAt = Date.now() + PREVIEW_TTL_MS;
        const record: PreviewRecord = {
          token,
          expiresAt,
          used: false,
          planId,
          month,
          guardMonth,
          assignments: previewAssignments,
          fingerprint: state.fingerprint,
        };
        previews.set(token, record);

        const warnings = previewAssignments
          .filter((assignment) => assignment.hidden)
          .map((assignment) => `Category ${assignment.categoryId} is hidden.`);

        return textResult("Assignment preview is valid. Apply it only after explicit user approval.", {
          requested_plan_id: requestedPlanId,
          resolved_plan_id: planId,
          month,
          guard_month: guardMonth,
          currency_decimal_digits: decimalDigits,
          assignments: previewAssignments.map(formatPreviewAssignment),
          net_delta: netDelta,
          net_delta_currency: netDelta / 1000,
          target_ready_to_assign: targetReadyToAssign,
          target_ready_to_assign_currency: targetReadyToAssign / 1000,
          projected_target_ready_to_assign: projectedTargetReadyToAssign,
          projected_target_ready_to_assign_currency: projectedTargetReadyToAssign / 1000,
          guard_ready_to_assign: guardReadyToAssign,
          guard_ready_to_assign_currency: guardReadyToAssign / 1000,
          guard_uncovered_spending: guardUncovered,
          guard_uncovered_spending_currency: guardUncovered / 1000,
          projected_guard_ready_to_assign: projectedGuardReadyToAssign,
          projected_guard_ready_to_assign_currency: projectedGuardReadyToAssign / 1000,
          projected_guard_uncovered_spending: projectedGuardUncovered,
          projected_guard_uncovered_spending_currency: projectedGuardUncovered / 1000,
          guard_planning_available_after_uncovered_spending: guardPlanningAvailable,
          guard_planning_available_after_uncovered_spending_currency: guardPlanningAvailable / 1000,
          projected_guard_planning_available_after_uncovered_spending: projectedGuardPlanningAvailable,
          projected_guard_planning_available_after_uncovered_spending_currency:
            projectedGuardPlanningAvailable / 1000,
          derivation: "Ready to Assign minus all active non-internal negative category balances.",
          warnings,
          preview_token: token,
          expires_at: new Date(expiresAt).toISOString(),
        });
      }),
    },
    {
      name: "ynab_apply_assignment_preview",
      title: "Apply Approved YNAB Assignment Preview",
      description:
        "Apply a short-lived assignment preview token only after the user explicitly approves the exact preview.",
      inputSchema: {
        type: "object",
        required: ["preview_token"],
        properties: {
          preview_token: { type: "string" },
        },
      },
      annotations: {
        title: "Apply Approved YNAB Assignment Preview",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async (args) => wrapAssignmentErrors(async () => {
        if (process.env.YNAB_ENABLE_WRITES !== "true") {
          return errorResult("YNAB writes are disabled. Set YNAB_ENABLE_WRITES=true and restart the server.", {
            error_type: "writes_disabled",
          });
        }

        const token = readRequiredString(args.preview_token, "preview_token");
        const preview = previews.get(token);
        if (!preview) {
          return errorResult("The assignment preview token is unknown.", { error_type: "preview_not_found" });
        }
        if (preview.used) {
          return errorResult("The assignment preview token has already been used.", { error_type: "preview_used" });
        }
        if (preview.expiresAt <= Date.now()) {
          previews.delete(token);
          return errorResult("The assignment preview token has expired.", { error_type: "preview_expired" });
        }

        const freshState = await loadState(
          client,
          preview.planId,
          preview.month,
          preview.guardMonth,
          preview.assignments.map((assignment) => assignment.categoryId),
        );
        if (freshState.fingerprint !== preview.fingerprint) {
          return errorResult("YNAB changed after this preview. Create and approve a new preview.", {
            error_type: "stale_preview",
          });
        }

        preview.used = true;
        const ordered = [...preview.assignments].sort((left, right) => left.delta - right.delta);
        const statuses = new Map<string, Record<string, unknown>>();
        let stopped = false;

        for (const assignment of ordered) {
          if (stopped) {
            statuses.set(assignment.categoryId, statusFor(assignment, "not_attempted"));
            continue;
          }

          try {
            await client.updateMonthCategory(
              preview.planId,
              preview.month,
              assignment.categoryId,
              assignment.projectedBudgeted,
            );
            statuses.set(assignment.categoryId, statusFor(assignment, "applied"));
          } catch (error) {
            client.invalidatePlanCaches(preview.planId);
            const ambiguous = isAmbiguousWriteError(error);
            if (ambiguous) {
              try {
                const verification = await client.getMonthCategory(
                  preview.planId,
                  preview.month,
                  assignment.categoryId,
                  true,
                );
                const actual = readMoney(asRecord(verification.data.category), "budgeted");
                if (actual === assignment.projectedBudgeted) {
                  statuses.set(assignment.categoryId, statusFor(assignment, "verified"));
                  continue;
                }
              } catch {
                // The original write outcome remains ambiguous and is reported below.
              }
            }

            statuses.set(assignment.categoryId, {
              ...statusFor(assignment, "failed"),
              error: error instanceof Error ? error.message : "Unknown write failure.",
              ambiguous,
            });
            stopped = true;
          }
        }

        client.invalidatePlanCaches(preview.planId);
        let finalState: LoadedAssignmentState;
        try {
          finalState = await loadState(
            client,
            preview.planId,
            preview.month,
            preview.guardMonth,
            preview.assignments.map((assignment) => assignment.categoryId),
          );
        } catch (error) {
          const verificationError = error instanceof Error
            ? error.message
            : "Unknown post-write verification failure.";
          const orderedStatuses = preview.assignments.map((assignment) => {
            const status = statuses.get(assignment.categoryId) ?? statusFor(assignment, "not_attempted");
            if (status.status === "applied") {
              status.status = "applied_unverified";
              status.ambiguous = true;
              status.error = verificationError;
            }
            return status;
          });

          return errorResult("The final YNAB state could not be verified after assignment writes.", {
            resolved_plan_id: preview.planId,
            month: preview.month,
            guard_month: preview.guardMonth,
            assignments: orderedStatuses,
            partial_failure: stopped,
            write_phase_completed: !stopped,
            verification_failed: true,
            verification_error: verificationError,
            final_state: null,
          });
        }

        for (const assignment of preview.assignments) {
          const status = statuses.get(assignment.categoryId);
          if (!status || status.status === "not_attempted") {
            continue;
          }
          const category = finalState.categories.find((item) => item.id === assignment.categoryId);
          if (category && readMoney(category, "budgeted") === assignment.projectedBudgeted) {
            status.status = "verified";
            delete status.error;
            delete status.ambiguous;
          } else {
            status.status = "failed";
            status.error = "Post-write verification did not match the previewed assigned amount.";
            stopped = true;
          }
        }

        const orderedStatuses = preview.assignments.map((assignment) =>
          statuses.get(assignment.categoryId) ?? statusFor(assignment, "not_attempted")
        );
        const partialFailure = orderedStatuses.some((status) => status.status !== "verified");
        const finalSummary = summarizeFinalState(finalState, preview);
        const structured = {
          resolved_plan_id: preview.planId,
          month: preview.month,
          guard_month: preview.guardMonth,
          assignments: orderedStatuses,
          partial_failure: partialFailure,
          final_state: finalSummary,
        };

        return partialFailure
          ? errorResult("Assignment apply stopped before every change could be verified.", structured)
          : textResult("Every assignment was applied and verified.", structured);
      }),
    },
  ];
}

async function loadState(
  client: YnabClient,
  planId: string,
  month: string,
  guardMonth: string,
  categoryIds: string[],
  providedPlan?: Record<string, unknown>,
): Promise<LoadedAssignmentState> {
  const plan = providedPlan ?? asRecord((await client.getPlan(planId, true)).data.plan);
  const [targetResponse, guardResponse, categoryResponses] = await Promise.all([
    client.getMonth(planId, month, true),
    guardMonth === month ? Promise.resolve(undefined) : client.getMonth(planId, guardMonth, true),
    Promise.all(
      categoryIds.map((categoryId) => client.getMonthCategory(planId, month, categoryId, true)),
    ),
  ]);
  const targetMonth = asRecord(targetResponse.data.month);
  const guard = guardMonth === month ? targetMonth : asRecord(guardResponse?.data.month);
  const categories = categoryResponses.map((response) => asRecord(response.data.category));
  return {
    plan,
    targetMonth,
    guardMonth: guard,
    categories,
    fingerprint: fingerprintState(plan, targetMonth, guard, categories),
  };
}

function fingerprintState(
  plan: Record<string, unknown>,
  targetMonth: Record<string, unknown>,
  guardMonth: Record<string, unknown>,
  categories: Record<string, unknown>[],
): string {
  const negativeCategories = monthCategories(guardMonth)
    .filter(isActiveCategory)
    .filter((category) => readMoney(category, "balance") < 0)
    .map((category) => ({ id: category.id, balance: readMoney(category, "balance") }))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const affected = categories
    .map((category) => ({
      id: category.id,
      budgeted: readMoney(category, "budgeted"),
      balance: readMoney(category, "balance"),
      deleted: category.deleted === true,
      internal: category.internal === true,
    }))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const value = JSON.stringify({
    currency_format: plan.currency_format ?? null,
    target_ready_to_assign: readMoney(targetMonth, "to_be_budgeted"),
    guard_ready_to_assign: readMoney(guardMonth, "to_be_budgeted"),
    negative_categories: negativeCategories,
    affected_categories: affected,
  });
  return createHash("sha256").update(value).digest("hex");
}

function parseAssignments(value: unknown, decimalDigits: number): AssignmentInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ASSIGNMENTS) {
    throw new Error(`assignments must contain between 1 and ${MAX_ASSIGNMENTS} entries.`);
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const record = asRecord(entry);
    const categoryId = readRequiredString(record.category_id, `assignments[${index}].category_id`);
    const deltaCurrency = readRequiredString(record.delta_currency, `assignments[${index}].delta_currency`);
    if (seen.has(categoryId)) {
      throw new Error(`Duplicate category_id: ${categoryId}.`);
    }
    seen.add(categoryId);
    const delta = decimalCurrencyToMilliunits(deltaCurrency, decimalDigits);
    if (delta === 0) {
      throw new Error(`assignments[${index}].delta_currency must not be zero.`);
    }
    return { categoryId, deltaCurrency, delta };
  });
}

function buildPreviewAssignments(
  assignments: AssignmentInput[],
  categories: Record<string, unknown>[],
): PreviewAssignment[] {
  return assignments.map((assignment) => {
    const category = categories.find((candidate) => candidate.id === assignment.categoryId);
    if (!category || typeof category.id !== "string") {
      throw new Error(`Category not found: ${assignment.categoryId}.`);
    }
    if (category.deleted === true || category.internal === true) {
      throw new Error(`Category ${assignment.categoryId} cannot be assigned because it is deleted or internal.`);
    }
    const currentBudgeted = readMoney(category, "budgeted");
    const currentBalance = readMoney(category, "balance");
    const projectedBalance = currentBalance + assignment.delta;
    if (assignment.delta < 0 && projectedBalance < 0) {
      throw new Error(`Reducing category ${assignment.categoryId} would make its available balance negative.`);
    }
    return {
      ...assignment,
      categoryName: typeof category.name === "string" ? category.name : null,
      currentBudgeted,
      projectedBudgeted: currentBudgeted + assignment.delta,
      currentBalance,
      projectedBalance,
      hidden: category.hidden === true,
    };
  });
}

function decimalCurrencyToMilliunits(value: string, decimalDigits: number): number {
  const match = /^-(?:0|[1-9]\d*)(?:\.(\d+))?$|^(?:0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
  if (!match) {
    throw new Error(`Invalid canonical currency amount: ${value}.`);
  }
  const fraction = match[1] ?? match[2] ?? "";
  if (fraction.length > decimalDigits) {
    throw new Error(`${value} exceeds the plan currency precision of ${decimalDigits} decimal digits.`);
  }
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "0", fractional = ""] = unsigned.split(".");
  const milliunits = BigInt(whole) * 1000n + BigInt(fractional.padEnd(3, "0"));
  const signed = negative ? -milliunits : milliunits;
  const result = Number(signed);
  if (!Number.isSafeInteger(result)) {
    throw new Error("Assignment amount is outside the supported safe integer range.");
  }
  return result;
}

function isAmbiguousWriteError(error: unknown): boolean {
  return !(error instanceof YnabApiError) || error.status >= 500 || error.status === 429;
}

function readCurrencyDecimalDigits(plan: Record<string, unknown>): number {
  const currencyFormat = asRecord(plan.currency_format);
  const decimalDigits = currencyFormat.decimal_digits;
  if (!Number.isInteger(decimalDigits) || decimalDigits < 0 || decimalDigits > 3) {
    throw new Error("The plan currency precision is unavailable or unsupported for safe writes.");
  }
  return decimalDigits;
}

function summarizeUncovered(month: Record<string, unknown>): { signed: number; uncovered: number } {
  const signed = monthCategories(month)
    .filter(isActiveCategory)
    .reduce((total, category) => {
      const balance = readMoney(category, "balance");
      return balance < 0 ? total + balance : total;
    }, 0);
  return { signed, uncovered: Math.abs(signed) };
}

function summarizeProjectedUncovered(
  month: Record<string, unknown>,
  assignments: PreviewAssignment[],
): number {
  const assignmentByCategory = new Map(
    assignments.map((assignment) => [assignment.categoryId, assignment]),
  );
  const signed = monthCategories(month)
    .filter(isActiveCategory)
    .reduce((total, category) => {
      const id = typeof category.id === "string" ? category.id : "";
      const assignment = assignmentByCategory.get(id);
      const balance = assignment?.projectedBalance ?? readMoney(category, "balance");
      return balance < 0 ? total + balance : total;
    }, 0);
  return Math.abs(signed);
}

function summarizeFinalState(state: LoadedAssignmentState, preview: PreviewRecord): Record<string, unknown> {
  const guardUncovered = summarizeUncovered(state.guardMonth).uncovered;
  const targetReady = readMoney(state.targetMonth, "to_be_budgeted");
  const guardReady = readMoney(state.guardMonth, "to_be_budgeted");
  return {
    target_ready_to_assign: targetReady,
    target_ready_to_assign_currency: targetReady / 1000,
    guard_ready_to_assign: guardReady,
    guard_ready_to_assign_currency: guardReady / 1000,
    guard_uncovered_spending: guardUncovered,
    guard_uncovered_spending_currency: guardUncovered / 1000,
    guard_planning_available_after_uncovered_spending: guardReady - guardUncovered,
    guard_planning_available_after_uncovered_spending_currency: (guardReady - guardUncovered) / 1000,
    categories: preview.assignments.map((assignment) => {
      const category = state.categories.find((candidate) => candidate.id === assignment.categoryId) ?? {};
      return {
        category_id: assignment.categoryId,
        budgeted: readMoney(category, "budgeted"),
        budgeted_currency: readMoney(category, "budgeted") / 1000,
        balance: readMoney(category, "balance"),
        balance_currency: readMoney(category, "balance") / 1000,
      };
    }),
  };
}

function formatPreviewAssignment(assignment: PreviewAssignment): Record<string, unknown> {
  return {
    category_id: assignment.categoryId,
    category_name: assignment.categoryName,
    delta_currency_input: assignment.deltaCurrency,
    delta: assignment.delta,
    delta_currency: assignment.delta / 1000,
    current_budgeted: assignment.currentBudgeted,
    current_budgeted_currency: assignment.currentBudgeted / 1000,
    projected_budgeted: assignment.projectedBudgeted,
    projected_budgeted_currency: assignment.projectedBudgeted / 1000,
    current_balance: assignment.currentBalance,
    current_balance_currency: assignment.currentBalance / 1000,
    projected_balance: assignment.projectedBalance,
    projected_balance_currency: assignment.projectedBalance / 1000,
    hidden: assignment.hidden,
  };
}

function statusFor(assignment: PreviewAssignment, status: string): Record<string, unknown> {
  return {
    category_id: assignment.categoryId,
    category_name: assignment.categoryName,
    delta: assignment.delta,
    delta_currency: assignment.delta / 1000,
    projected_budgeted: assignment.projectedBudgeted,
    projected_budgeted_currency: assignment.projectedBudgeted / 1000,
    status,
  };
}

function monthCategories(month: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(month.categories) ? month.categories.map(asRecord) : [];
}

function isActiveCategory(category: Record<string, unknown>): boolean {
  return category.deleted !== true && category.internal !== true;
}

function readMoney(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readMonth(value: unknown, key: string): string {
  const month = readRequiredString(value, key);
  if (!/^\d{4}-\d{2}$/.test(month) || Number(month.slice(5, 7)) < 1 || Number(month.slice(5, 7)) > 12) {
    throw new Error(`${key} must use YYYY-MM format.`);
  }
  return month;
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

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function purgeExpiredPreviews(previews: Map<string, PreviewRecord>): void {
  const now = Date.now();
  for (const [token, preview] of previews) {
    if (preview.expiresAt <= now) {
      previews.delete(token);
    }
  }
}

async function wrapAssignmentErrors(
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
    return errorResult("Unknown assignment tool failure.");
  }
}

function asRecord(value: unknown): Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

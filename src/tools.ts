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
import { createCategoryCreationTools } from "./category-creation.ts";
import { createAssignmentTools } from "./assignments.ts";
import {
  expandScheduledTransaction,
  inclusiveDaySpan,
  type ScheduledOccurrence,
} from "./scheduled.ts";

export function createYnabTools(client: YnabClient): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      name: "ynab_list_plans",
      title: "List YNAB Plans",
      description: "List the YNAB plans available to the configured token.",
      inputSchema: {
        type: "object",
        properties: {
          refresh: refreshProperty(),
        },
      },
      annotations: {
        title: "List YNAB Plans",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (args) => wrapToolErrors(async () => {
        const refresh = readBooleanArg(args, "refresh", false);
        const response = await client.listPlans(refresh);
        const plans = asArray(response.data.plans);

        return textResult(
          `${plans.length} YNAB plan(s) available.`,
          {
            plans,
            meta: response.meta,
          },
        );
      }),
    },
    {
      name: "ynab_get_budget_snapshot",
      title: "Get Budget Snapshot",
      description:
        "Get a high-level snapshot of a YNAB plan for a given month, including month details, account totals, and category highlights.",
      inputSchema: {
        type: "object",
        properties: {
          plan_id: {
            type: "string",
            description: 'YNAB plan id. Defaults to "default".',
          },
          month: {
            type: "string",
            description: "Budget month in YYYY-MM format. Defaults to the current month.",
            pattern: "^\\d{4}-\\d{2}$",
          },
          refresh: refreshProperty(),
        },
      },
      annotations: {
        title: "Get Budget Snapshot",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (args) => wrapToolErrors(async () => {
        const refresh = readBooleanArg(args, "refresh", false);
        const planSelection = await resolvePlanSelection(client, args, refresh);
        const month = readMonthArg(args, "month") ?? currentMonth();
        const [planResponse, monthResponse] = await Promise.all([
          client.getPlan(planSelection.resolved_plan_id, refresh),
          client.getMonth(planSelection.resolved_plan_id, month, refresh),
        ]);

        const plan = asRecord(planResponse.data.plan);
        const monthData = asRecord(monthResponse.data.month);
        const accounts = asArray(plan.accounts).map(asRecord).filter(Boolean);
        const categoryGroups = extractCategoryGroups(plan, monthData);
        const categorySummary = {
          ...summarizeCategories(categoryGroups),
          ...summarizePlanningAvailability(monthData, categoryGroups),
        };

        return textResult(
          `Budget snapshot ready for ${month}. ${accounts.length} account(s), ${categorySummary.total_categories} categor${categorySummary.total_categories === 1 ? "y" : "ies"}, ${categorySummary.overspent_categories.length} overspent.`,
          {
            ...planSelection,
            plan_id: planSelection.resolved_plan_id,
            selected_month: month,
            month: monthData,
            accounts_summary: summarizeAccounts(accounts),
            category_summary: categorySummary,
            meta: {
              plan: planResponse.meta,
              month: monthResponse.meta,
            },
          },
        );
      }),
    },
    {
      name: "ynab_list_accounts",
      title: "List Accounts",
      description: "List accounts for a YNAB plan.",
      inputSchema: {
        type: "object",
        properties: {
          plan_id: {
            type: "string",
            description: 'YNAB plan id. Defaults to "default".',
          },
          include_closed: {
            type: "boolean",
            description: "Include closed accounts. Defaults to false.",
          },
          refresh: refreshProperty(),
        },
      },
      annotations: {
        title: "List Accounts",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (args) => wrapToolErrors(async () => {
        const refresh = readBooleanArg(args, "refresh", false);
        const planSelection = await resolvePlanSelection(client, args, refresh);
        const includeClosed = readBooleanArg(args, "include_closed", false);
        const response = await client.listAccounts(planSelection.resolved_plan_id, refresh);
        const accounts = asArray(response.data.accounts)
          .map(asRecord)
          .filter(Boolean)
          .filter((account) => includeClosed || account.closed !== true);

        return textResult(
          `${accounts.length} account(s) returned.`,
          {
            ...planSelection,
            plan_id: planSelection.resolved_plan_id,
            include_closed: includeClosed,
            accounts,
            summary: summarizeAccounts(accounts),
            meta: response.meta,
          },
        );
      }),
    },
    {
      name: "ynab_list_categories",
      title: "List Categories",
      description:
        "List category groups and categories for a YNAB plan, with optional month context.",
      inputSchema: {
        type: "object",
        properties: {
          plan_id: {
            type: "string",
            description: 'YNAB plan id. Defaults to "default".',
          },
          month: {
            type: "string",
            description: "Optional budget month in YYYY-MM format.",
            pattern: "^\\d{4}-\\d{2}$",
          },
          refresh: refreshProperty(),
        },
      },
      annotations: {
        title: "List Categories",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (args) => wrapToolErrors(async () => {
        const refresh = readBooleanArg(args, "refresh", false);
        const planSelection = await resolvePlanSelection(client, args, refresh);
        const month = readMonthArg(args, "month");

        if (month) {
          const monthResponse = await client.getMonth(planSelection.resolved_plan_id, month, refresh);
          const monthData = asRecord(monthResponse.data.month);
          const monthCategories = extractCategoryGroups({}, monthData);

          if (monthCategories.length > 0) {
            return textResult(
              `${countCategories(monthCategories)} category entries returned from the ${month} month context.`,
              {
                ...planSelection,
                plan_id: planSelection.resolved_plan_id,
                month,
                source: "month",
                category_groups: monthCategories,
                categories: flattenCategoriesWithGroups(monthCategories),
                summary: summarizeCategories(monthCategories),
                meta: monthResponse.meta,
              },
            );
          }
        }

        const response = await client.listCategories(planSelection.resolved_plan_id, refresh);
        const categoryGroups = asArray(response.data.category_groups)
          .map(asRecord)
          .filter(Boolean);

        return textResult(
          `${countCategories(categoryGroups)} category entries returned.`,
          {
            ...planSelection,
            plan_id: planSelection.resolved_plan_id,
            month: month ?? null,
            source: "plan",
            category_groups: categoryGroups,
            categories: flattenCategoriesWithGroups(categoryGroups),
            summary: summarizeCategories(categoryGroups),
            meta: response.meta,
          },
        );
      }),
    },
    {
      name: "ynab_list_transactions",
      title: "List Transactions",
      description:
        "List transactions for a YNAB plan with optional date, month, account, category, payee, and limit filters.",
      inputSchema: {
        type: "object",
        properties: {
          plan_id: {
            type: "string",
            description: 'YNAB plan id. Defaults to "default".',
          },
          since_date: {
            type: "string",
            description: "Only return transactions on or after YYYY-MM-DD.",
            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          },
          until_date: {
            type: "string",
            description: "Only return transactions on or before YYYY-MM-DD.",
            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          },
          month: {
            type: "string",
            description: "Only keep transactions in the given YYYY-MM month.",
            pattern: "^\\d{4}-\\d{2}$",
          },
          account_id: {
            type: "string",
            description: "Optional account id filter.",
          },
          category_id: {
            type: "string",
            description: "Optional category id filter.",
          },
          payee_id: {
            type: "string",
            description: "Optional payee id filter.",
          },
          type: {
            type: "string",
            enum: ["uncategorized", "unapproved"],
            description: "YNAB-supported server-side cleanup filter.",
          },
          approved: {
            type: "boolean",
            description: "Optional local approved-status filter.",
          },
          cleared: {
            type: "string",
            enum: ["cleared", "uncleared", "reconciled"],
            description: "Optional local cleared-status filter.",
          },
          all_dates: {
            type: "boolean",
            description: "Query from the plan's first month. Mutually exclusive with since_date and month.",
          },
          offset: {
            type: "integer",
            description: "Number of matching transactions to skip. Defaults to 0.",
            minimum: 0,
          },
          limit: {
            type: "integer",
            description: "Maximum number of transactions to return. Defaults to 100.",
            minimum: 1,
            maximum: 1000,
          },
          refresh: refreshProperty(),
        },
      },
      annotations: {
        title: "List Transactions",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (args) => wrapToolErrors(async () => {
        const refresh = readBooleanArg(args, "refresh", false);
        const planSelection = await resolvePlanSelection(client, args, refresh);
        const month = readMonthArg(args, "month");
        const sinceDate = readDateArg(args, "since_date");
        const untilDate = readDateArg(args, "until_date");
        const accountId = readOptionalStringArg(args, "account_id");
        const categoryId = readOptionalStringArg(args, "category_id");
        const payeeId = readOptionalStringArg(args, "payee_id");
        const type = readTransactionTypeArg(args, "type");
        const approved = readOptionalBooleanArg(args, "approved");
        const cleared = readClearedArg(args, "cleared");
        const allDates = readBooleanArg(args, "all_dates", false);
        const offset = readIntegerArg(args, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
        const limit = readIntegerArg(args, "limit", 100, 1, 1000);
        if (allDates && (sinceDate || month)) {
          throw new Error("all_dates is mutually exclusive with since_date and month.");
        }
        let allDatesStart: string | undefined;
        if (allDates) {
          const planResponse = await client.getPlan(planSelection.resolved_plan_id, refresh);
          const plan = asRecord(planResponse.data.plan);
          allDatesStart = typeof plan.first_month === "string" ? plan.first_month : undefined;
          if (!allDatesStart) {
            throw new Error("YNAB did not provide the plan's first_month for all_dates.");
          }
        }
        const effectiveSinceDate = maxDate(
          allDatesStart ?? sinceDate,
          month ? `${month}-01` : undefined,
        );
        const effectiveUntilDate = minDate(untilDate, month ? lastDayOfMonth(month) : undefined);
        if (effectiveSinceDate && effectiveUntilDate && effectiveSinceDate > effectiveUntilDate) {
          throw new Error("The effective since_date must not be after until_date.");
        }
        const response = await client.listTransactions(planSelection.resolved_plan_id, {
          since_date: effectiveSinceDate,
          until_date: effectiveUntilDate,
          type,
        }, refresh);
        const transactions = asArray(response.data.transactions)
          .map(asRecord)
          .filter(Boolean)
          .filter((transaction) => transaction.deleted !== true)
          .filter((transaction) => !month || String(transaction.date ?? "").startsWith(month))
          .filter((transaction) => !accountId || transaction.account_id === accountId)
          .filter((transaction) => !categoryId || transaction.category_id === categoryId)
          .filter((transaction) => !payeeId || transaction.payee_id === payeeId)
          .filter((transaction) => approved === undefined || transaction.approved === approved)
          .filter((transaction) => !cleared || transaction.cleared === cleared);
        const limitedTransactions = transactions.slice(offset, offset + limit);

        return textResult(
          `${transactions.length} transaction(s) matched; returning ${limitedTransactions.length}.`,
          {
            ...planSelection,
            plan_id: planSelection.resolved_plan_id,
            filters: {
              since_date: effectiveSinceDate ?? null,
              until_date: effectiveUntilDate ?? null,
              month: month ?? null,
              account_id: accountId ?? null,
              category_id: categoryId ?? null,
              payee_id: payeeId ?? null,
              type: type ?? null,
              approved: approved ?? null,
              cleared: cleared ?? null,
              all_dates: allDates,
              offset,
              limit,
            },
            queried_coverage: {
              since_date: effectiveSinceDate ?? null,
              until_date: effectiveUntilDate ?? null,
              api_default_since_date_applies: effectiveSinceDate === undefined,
            },
            total_matching_transactions: transactions.length,
            returned_transactions: limitedTransactions.length,
            offset,
            truncated: offset > 0 || offset + limitedTransactions.length < transactions.length,
            totals: summarizeTransactions(limitedTransactions),
            matching_totals: summarizeTransactions(transactions),
            transactions: limitedTransactions,
            meta: response.meta,
          },
        );
      }),
    },
    {
      name: "ynab_get_month_category",
      title: "Get YNAB Month Category",
      description: "Get one exact category for one exact YNAB plan month.",
      inputSchema: {
        type: "object",
        required: ["month", "category_id"],
        properties: {
          plan_id: {
            type: "string",
            description: 'YNAB plan id. Defaults to "default".',
          },
          month: {
            type: "string",
            pattern: "^\\d{4}-\\d{2}$",
          },
          category_id: {
            type: "string",
          },
          refresh: refreshProperty(),
        },
      },
      annotations: {
        title: "Get YNAB Month Category",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (args) => wrapToolErrors(async () => {
        const refresh = readBooleanArg(args, "refresh", false);
        const planSelection = await resolvePlanSelection(client, args, refresh);
        const month = readRequiredMonthArg(args, "month");
        const categoryId = readRequiredStringArg(args, "category_id");
        const response = await client.getMonthCategory(
          planSelection.resolved_plan_id,
          month,
          categoryId,
          refresh,
        );
        return textResult(`Category ${categoryId} returned for ${month}.`, {
          ...planSelection,
          plan_id: planSelection.resolved_plan_id,
          month,
          category_id: categoryId,
          category: response.data.category,
          meta: response.meta,
        });
      }),
    },
    {
      name: "ynab_list_scheduled_transactions",
      title: "List Scheduled YNAB Transactions",
      description: "List and project scheduled YNAB transaction occurrences through a bounded date horizon.",
      inputSchema: {
        type: "object",
        required: ["from_date", "through_date"],
        properties: {
          plan_id: {
            type: "string",
            description: 'YNAB plan id. Defaults to "default".',
          },
          from_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          through_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          account_id: { type: "string" },
          category_id: { type: "string" },
          payee_id: { type: "string" },
          refresh: refreshProperty(),
        },
      },
      annotations: {
        title: "List Scheduled YNAB Transactions",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (args) => wrapToolErrors(async () => {
        const refresh = readBooleanArg(args, "refresh", false);
        const planSelection = await resolvePlanSelection(client, args, refresh);
        const fromDate = readRequiredDateArg(args, "from_date");
        const throughDate = readRequiredDateArg(args, "through_date");
        const span = inclusiveDaySpan(fromDate, throughDate);
        if (span < 1 || span > 366) {
          throw new Error("The scheduled transaction horizon must contain between 1 and 366 inclusive days.");
        }
        const accountId = readOptionalStringArg(args, "account_id");
        const categoryId = readOptionalStringArg(args, "category_id");
        const payeeId = readOptionalStringArg(args, "payee_id");
        const response = await client.listScheduledTransactions(planSelection.resolved_plan_id, refresh);
        const considered = asArray(response.data.scheduled_transactions)
          .map(asRecord)
          .filter(Boolean)
          .filter((schedule) => schedule.deleted !== true)
          .filter((schedule) => !accountId || schedule.account_id === accountId)
          .filter((schedule) => !payeeId || schedule.payee_id === payeeId)
          .filter((schedule) => !categoryId || scheduledMatchesCategory(schedule, categoryId));
        const expanded = considered.map((schedule) => ({
          schedule,
          occurrences: expandScheduledTransaction(schedule, fromDate, throughDate),
        }));
        const matching = expanded.filter((entry) => entry.occurrences.length > 0);
        const occurrences = matching.flatMap((entry) => entry.occurrences);

        return textResult(
          `${matching.length} scheduled transaction(s) have ${occurrences.length} occurrence(s) in the horizon.`,
          {
            ...planSelection,
            plan_id: planSelection.resolved_plan_id,
            from_date: fromDate,
            through_date: throughDate,
            horizon_days: span,
            filters: {
              account_id: accountId ?? null,
              category_id: categoryId ?? null,
              payee_id: payeeId ?? null,
            },
            total_schedules_considered: considered.length,
            matching_schedules: matching.length,
            total_occurrences: occurrences.length,
            scheduled_transactions: matching.map((entry) => entry.schedule),
            occurrences,
            summary: summarizeScheduledOccurrences(occurrences),
            meta: response.meta,
          },
        );
      }),
    },
    {
      name: "ynab_list_payees",
      title: "List Payees",
      description: "List payees for a YNAB plan.",
      inputSchema: {
        type: "object",
        properties: {
          plan_id: {
            type: "string",
            description: 'YNAB plan id. Defaults to "default".',
          },
          refresh: refreshProperty(),
        },
      },
      annotations: {
        title: "List Payees",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (args) => wrapToolErrors(async () => {
        const refresh = readBooleanArg(args, "refresh", false);
        const planSelection = await resolvePlanSelection(client, args, refresh);
        const response = await client.listPayees(planSelection.resolved_plan_id, refresh);
        const payees = asArray(response.data.payees)
          .map(asRecord)
          .filter(Boolean)
          .filter((payee) => payee.deleted !== true);

        return textResult(
          `${payees.length} payee(s) returned.`,
          {
            ...planSelection,
            plan_id: planSelection.resolved_plan_id,
            payees,
            meta: response.meta,
          },
        );
      }),
    },
  ];

  return [...tools, ...createAssignmentTools(client), ...createCategoryCreationTools(client)];
}

async function wrapToolErrors(
  callback: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await callback();
  } catch (error) {
    if (error instanceof YnabConfigurationError) {
      return errorResult(error.message, {
        error_type: error.name,
      });
    }

    if (error instanceof YnabApiError) {
      return errorResult(error.message, error.toStructured());
    }

    if (error instanceof Error) {
      return errorResult(error.message, {
        error_type: error.name,
      });
    }

    return errorResult("Unknown tool failure.");
  }
}

async function resolvePlanSelection(
  client: YnabClient,
  args: Record<string, unknown>,
  refresh = false,
): Promise<{ requested_plan_id: string; resolved_plan_id: string; used_default_plan_resolution: boolean }> {
  const requestedPlanId = readOptionalStringArg(args, "plan_id") ?? "default";
  const resolvedPlanId = await client.resolvePlanId(requestedPlanId, refresh);

  return {
    requested_plan_id: requestedPlanId,
    resolved_plan_id: resolvedPlanId,
    used_default_plan_resolution: requestedPlanId === "default",
  };
}

function readOptionalStringArg(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];

  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`${key} must be a string.`);
  }

  return value;
}

function readBooleanArg(
  args: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = args[key];

  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean.`);
  }

  return value;
}

function readMonthArg(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = readOptionalStringArg(args, key);

  if (!value) {
    return undefined;
  }

  if (!/^\d{4}-\d{2}$/.test(value) || Number(value.slice(5, 7)) < 1 || Number(value.slice(5, 7)) > 12) {
    throw new Error(`${key} must use YYYY-MM format.`);
  }

  return value;
}

function readDateArg(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = readOptionalStringArg(args, key);

  if (!value) {
    return undefined;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${key} must use YYYY-MM-DD format.`);
  }

  return value;
}

function readIntegerArg(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = args[key];

  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${key} must be an integer.`);
  }

  if (value < min || value > max) {
    throw new Error(`${key} must be between ${min} and ${max}.`);
  }

  return value;
}

function currentMonth(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function maxDate(left?: string, right?: string): string | undefined {
  if (!left) {
    return right;
  }

  if (!right) {
    return left;
  }

  return left > right ? left : right;
}

function minDate(left?: string, right?: string): string | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return left < right ? left : right;
}

function lastDayOfMonth(month: string): string {
  const [yearString, monthString] = month.split("-");
  const year = Number(yearString);
  const monthIndex = Number(monthString);
  const day = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, "0")}`;
}

function summarizeAccounts(accounts: Record<string, unknown>[]): Record<string, any> {
  const openAccounts = accounts.filter((account) => account.closed !== true);
  const onBudgetAccounts = openAccounts.filter((account) => account.on_budget === true);
  const offBudgetAccounts = openAccounts.filter((account) => account.on_budget !== true);
  const liquidAccounts = openAccounts.filter((account) =>
    ["checking", "savings", "cash"].includes(String(account.type ?? ""))
  );
  const liquidOnBudget = liquidAccounts.filter((account) => account.on_budget === true);
  const liquidOffBudget = liquidAccounts.filter((account) => account.on_budget !== true);
  const nonLiquidAccounts = openAccounts.filter((account) => !liquidAccounts.includes(account));

  return {
    total_accounts: accounts.length,
    open_accounts: openAccounts.length,
    closed_accounts: accounts.length - openAccounts.length,
    on_budget_accounts: onBudgetAccounts.length,
    off_budget_accounts: offBudgetAccounts.length,
    total_balance_currency: sumCurrency(openAccounts, "balance_currency", "balance"),
    on_budget_balance_currency: sumCurrency(onBudgetAccounts, "balance_currency", "balance"),
    off_budget_balance_currency: sumCurrency(offBudgetAccounts, "balance_currency", "balance"),
    liquid_accounts: liquidAccounts.length,
    liquid_on_budget_accounts: liquidOnBudget.length,
    liquid_off_budget_accounts: liquidOffBudget.length,
    liquid_on_budget_balance: sumMilliunits(liquidOnBudget, "balance"),
    liquid_on_budget_balance_currency: sumCurrency(liquidOnBudget, "balance_currency", "balance"),
    liquid_on_budget_cleared_balance: sumMilliunits(liquidOnBudget, "cleared_balance"),
    liquid_on_budget_cleared_balance_currency:
      sumCurrency(liquidOnBudget, "cleared_balance_currency", "cleared_balance"),
    liquid_on_budget_uncleared_balance: sumMilliunits(liquidOnBudget, "uncleared_balance"),
    liquid_on_budget_uncleared_balance_currency:
      sumCurrency(liquidOnBudget, "uncleared_balance_currency", "uncleared_balance"),
    liquid_off_budget_balance: sumMilliunits(liquidOffBudget, "balance"),
    liquid_off_budget_balance_currency: sumCurrency(liquidOffBudget, "balance_currency", "balance"),
    liquid_off_budget_cleared_balance: sumMilliunits(liquidOffBudget, "cleared_balance"),
    liquid_off_budget_cleared_balance_currency:
      sumCurrency(liquidOffBudget, "cleared_balance_currency", "cleared_balance"),
    liquid_off_budget_uncleared_balance: sumMilliunits(liquidOffBudget, "uncleared_balance"),
    liquid_off_budget_uncleared_balance_currency:
      sumCurrency(liquidOffBudget, "uncleared_balance_currency", "uncleared_balance"),
    non_liquid_accounts: nonLiquidAccounts.length,
    non_liquid_balance: sumMilliunits(nonLiquidAccounts, "balance"),
    non_liquid_balance_currency: sumCurrency(nonLiquidAccounts, "balance_currency", "balance"),
    cash_safety_note:
      "Liquid balances are factual account balances; they do not by themselves confirm that a withdrawal is safe.",
  };
}

function summarizeCategories(
  categoryGroups: Record<string, unknown>[],
): Record<string, any> {
  const categories = flattenCategories(categoryGroups);
  const activeCategories = categories.filter(
    (category) => category.deleted !== true && category.internal !== true,
  );

  const overspentCategories = activeCategories
    .filter((category) => getCategoryAvailableCurrency(category) < 0)
    .sort(
      (left, right) =>
        getCategoryAvailableCurrency(left) - getCategoryAvailableCurrency(right),
    );

  const underfundedCategories = activeCategories
    .filter((category) => getCurrency(category, "goal_under_funded") > 0)
    .sort(
      (left, right) =>
        getCurrency(right, "goal_under_funded") - getCurrency(left, "goal_under_funded"),
    );

  const topAvailableCategories = activeCategories
    .filter((category) => getCategoryAvailableCurrency(category) > 0)
    .sort(
      (left, right) =>
        getCategoryAvailableCurrency(right) - getCategoryAvailableCurrency(left),
    )
    .slice(0, 10);
  const negativeBalanceTotal = overspentCategories.reduce(
    (total, category) => total + getCategoryBalanceMilliunits(category),
    0,
  );
  const targetUnderfundedTotal = underfundedCategories.reduce(
    (total, category) => total + getMoneyMilliunits(category, "goal_under_funded"),
    0,
  );

  return {
    total_category_groups: categoryGroups.length,
    total_categories: activeCategories.length,
    hidden_categories: activeCategories.filter((category) => category.hidden === true).length,
    overspent_categories: overspentCategories,
    overspent_highlights: overspentCategories.slice(0, 10),
    overspent_category_count: overspentCategories.length,
    negative_balance_total: negativeBalanceTotal,
    negative_balance_total_currency: negativeBalanceTotal / 1000,
    uncovered_spending_total: Math.abs(negativeBalanceTotal),
    uncovered_spending_total_currency: Math.abs(negativeBalanceTotal) / 1000,
    underfunded_categories: underfundedCategories,
    underfunded_highlights: underfundedCategories.slice(0, 10),
    underfunded_category_count: underfundedCategories.length,
    target_underfunded_total: targetUnderfundedTotal,
    target_underfunded_total_currency: targetUnderfundedTotal / 1000,
    top_available_categories: topAvailableCategories,
  };
}

function summarizePlanningAvailability(
  month: Record<string, unknown>,
  categoryGroups: Record<string, unknown>[],
): Record<string, any> {
  const readyToAssign = getMoneyMilliunits(month, "to_be_budgeted");
  const negativeBalanceTotal = flattenCategories(categoryGroups)
    .filter((category) => category.deleted !== true && category.internal !== true)
    .reduce((total, category) => {
      const balance = getCategoryBalanceMilliunits(category);
      return balance < 0 ? total + balance : total;
    }, 0);
  const uncoveredSpending = Math.abs(negativeBalanceTotal);
  const planningAvailable = readyToAssign - uncoveredSpending;
  return {
    ready_to_assign: readyToAssign,
    ready_to_assign_currency: readyToAssign / 1000,
    planning_available_after_uncovered_spending: planningAvailable,
    planning_available_after_uncovered_spending_currency: planningAvailable / 1000,
    planning_available_derivation:
      "Ready to Assign minus all active non-internal negative category balances; this is derived, not a canonical YNAB field.",
  };
}

function summarizeTransactions(
  transactions: Record<string, unknown>[],
): Record<string, unknown> {
  let inflow = 0;
  let outflow = 0;

  for (const transaction of transactions) {
    const amount = getMoneyMilliunits(transaction, "amount");

    if (amount >= 0) {
      inflow += amount;
    } else {
      outflow += Math.abs(amount);
    }
  }

  return {
    total_transactions: transactions.length,
    inflow,
    inflow_currency: inflow / 1000,
    outflow,
    outflow_currency: outflow / 1000,
    net: inflow - outflow,
    net_currency: (inflow - outflow) / 1000,
  };
}

function sumCurrency(
  items: Record<string, unknown>[],
  currencyKey: string,
  fallbackKey: string,
): number {
  return items.reduce((total, item) => total + getCurrency(item, fallbackKey, currencyKey), 0);
}

function sumMilliunits(items: Record<string, unknown>[], key: string): number {
  return items.reduce((total, item) => total + getMoneyMilliunits(item, key), 0);
}

function getCurrency(
  item: Record<string, unknown>,
  baseKey: string,
  explicitCurrencyKey = `${baseKey}_currency`,
): number {
  const explicitValue = item[explicitCurrencyKey];

  if (typeof explicitValue === "number") {
    return explicitValue;
  }

  const baseValue = item[baseKey];
  return typeof baseValue === "number" ? baseValue / 1000 : 0;
}

function getMoneyMilliunits(item: Record<string, unknown>, baseKey: string): number {
  const baseValue = item[baseKey];
  if (typeof baseValue === "number" && Number.isFinite(baseValue)) {
    return baseValue;
  }
  const currencyValue = item[`${baseKey}_currency`];
  return typeof currencyValue === "number" && Number.isFinite(currencyValue)
    ? Math.round(currencyValue * 1000)
    : 0;
}

function getCategoryAvailableCurrency(category: Record<string, unknown>): number {
  if (typeof category.balance_currency === "number" || typeof category.balance === "number") {
    return getCurrency(category, "balance");
  }

  return getCurrency(category, "available");
}

function getCategoryBalanceMilliunits(category: Record<string, unknown>): number {
  if (typeof category.balance === "number" || typeof category.balance_currency === "number") {
    return getMoneyMilliunits(category, "balance");
  }
  return getMoneyMilliunits(category, "available");
}

function extractCategoryGroups(
  plan: Record<string, unknown>,
  monthData: Record<string, unknown>,
): Record<string, unknown>[] {
  const fromMonth = monthData.category_groups;

  if (Array.isArray(fromMonth)) {
    return fromMonth.map(asRecord).filter(Boolean);
  }

  if (Array.isArray(monthData.categories)) {
    return [
      {
        id: `${String(monthData.month ?? "month")}-categories`,
        name: `${String(monthData.month ?? "Month")} Categories`,
        categories: monthData.categories,
      },
    ];
  }

  const fromPlan = plan.category_groups;
  return Array.isArray(fromPlan) ? fromPlan.map(asRecord).filter(Boolean) : [];
}

function flattenCategories(
  categoryGroups: Record<string, unknown>[],
): Record<string, unknown>[] {
  return categoryGroups.flatMap((group) => {
    const categories = Array.isArray(group.categories) ? group.categories : [];
    return categories.map(asRecord).filter(Boolean);
  });
}

function flattenCategoriesWithGroups(
  categoryGroups: Record<string, unknown>[],
): Record<string, unknown>[] {
  return categoryGroups.flatMap((group) => {
    const categories = Array.isArray(group.categories) ? group.categories : [];
    return categories.map(asRecord).filter(Boolean).map((category) => ({
      ...category,
      category_group_id: category.category_group_id ?? group.id ?? null,
      category_group_name: category.category_group_name ?? group.name ?? null,
    }));
  });
}

function scheduledMatchesCategory(schedule: Record<string, unknown>, categoryId: string): boolean {
  if (schedule.category_id === categoryId) {
    return true;
  }
  return asArray(schedule.subtransactions)
    .map(asRecord)
    .some((subtransaction) => subtransaction.category_id === categoryId);
}

function summarizeScheduledOccurrences(
  occurrences: ScheduledOccurrence[],
): Record<string, unknown> {
  let inflow = 0;
  let outflow = 0;
  let transferNet = 0;
  const accounts = new Map<string, { account_id: unknown; account_name: unknown; net: number; inflow: number; outflow: number }>();
  const categories = new Map<string, { category_id: unknown; category_name: unknown; net: number; inflow: number; outflow: number }>();

  for (const occurrence of occurrences) {
    const accountKey = String(occurrence.account_id ?? "uncategorized-account");
    const account = accounts.get(accountKey) ?? {
      account_id: occurrence.account_id,
      account_name: occurrence.account_name,
      net: 0,
      inflow: 0,
      outflow: 0,
    };
    addSignedAmount(account, occurrence.amount);
    accounts.set(accountKey, account);

    if (occurrence.is_transfer) {
      transferNet += occurrence.amount;
      continue;
    }
    if (occurrence.amount >= 0) {
      inflow += occurrence.amount;
    } else {
      outflow += Math.abs(occurrence.amount);
    }

    const allocations = occurrence.subtransactions.length > 0
      ? occurrence.subtransactions.map(asRecord).map((subtransaction) => ({
        category_id: subtransaction.category_id ?? null,
        category_name: subtransaction.category_name ?? null,
        amount: getMoneyMilliunits(subtransaction, "amount"),
      }))
      : [{
        category_id: occurrence.category_id,
        category_name: occurrence.category_name,
        amount: occurrence.amount,
      }];

    for (const allocation of allocations) {
      const categoryKey = String(allocation.category_id ?? "uncategorized");
      const category = categories.get(categoryKey) ?? {
        category_id: allocation.category_id,
        category_name: allocation.category_name,
        net: 0,
        inflow: 0,
        outflow: 0,
      };
      addSignedAmount(category, allocation.amount);
      categories.set(categoryKey, category);
    }
  }

  return {
    total_occurrences: occurrences.length,
    spending_inflow: inflow,
    spending_inflow_currency: inflow / 1000,
    spending_outflow: outflow,
    spending_outflow_currency: outflow / 1000,
    spending_net: inflow - outflow,
    spending_net_currency: (inflow - outflow) / 1000,
    transfer_net: transferNet,
    transfer_net_currency: transferNet / 1000,
    by_account: [...accounts.values()].map(formatSignedSummary),
    by_category: [...categories.values()].map(formatSignedSummary),
  };
}

function addSignedAmount(
  summary: { net: number; inflow: number; outflow: number },
  amount: number,
): void {
  summary.net += amount;
  if (amount >= 0) {
    summary.inflow += amount;
  } else {
    summary.outflow += Math.abs(amount);
  }
}

function formatSignedSummary<T extends { net: number; inflow: number; outflow: number }>(
  summary: T,
): T & Record<string, number> {
  return {
    ...summary,
    net_currency: summary.net / 1000,
    inflow_currency: summary.inflow / 1000,
    outflow_currency: summary.outflow / 1000,
  };
}

function countCategories(categoryGroups: Record<string, unknown>[]): number {
  return flattenCategories(categoryGroups).length;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function refreshProperty(): Record<string, unknown> {
  return {
    type: "boolean",
    description: "Bypass TTL and delta baselines and fetch a complete response. Defaults to false.",
  };
}

function readRequiredStringArg(args: Record<string, unknown>, key: string): string {
  const value = readOptionalStringArg(args, key);
  if (!value) {
    throw new Error(`${key} is required.`);
  }
  return value;
}

function readRequiredMonthArg(args: Record<string, unknown>, key: string): string {
  const value = readMonthArg(args, key);
  if (!value) {
    throw new Error(`${key} is required.`);
  }
  return value;
}

function readRequiredDateArg(args: Record<string, unknown>, key: string): string {
  const value = readDateArg(args, key);
  if (!value) {
    throw new Error(`${key} is required.`);
  }
  return value;
}

function readOptionalBooleanArg(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  if (args[key] === undefined) {
    return undefined;
  }
  return readBooleanArg(args, key, false);
}

function readTransactionTypeArg(
  args: Record<string, unknown>,
  key: string,
): "uncategorized" | "unapproved" | undefined {
  const value = readOptionalStringArg(args, key);
  if (value === undefined) {
    return undefined;
  }
  if (value !== "uncategorized" && value !== "unapproved") {
    throw new Error(`${key} must be uncategorized or unapproved.`);
  }
  return value;
}

function readClearedArg(
  args: Record<string, unknown>,
  key: string,
): "cleared" | "uncleared" | "reconciled" | undefined {
  const value = readOptionalStringArg(args, key);
  if (value === undefined) {
    return undefined;
  }
  if (value !== "cleared" && value !== "uncleared" && value !== "reconciled") {
    throw new Error(`${key} must be cleared, uncleared, or reconciled.`);
  }
  return value;
}

const KNOWN_MONEY_FIELDS = new Set([
  "amount",
  "balance",
  "cleared_balance",
  "uncleared_balance",
  "transfer_balance",
  "working_balance",
  "activity",
  "budgeted",
  "available",
  "goal_target",
  "goal_overall_funded",
  "goal_overall_left",
  "goal_under_funded",
  "cash_left_over",
  "credit_left_over",
  "starting_balance",
  "current_balance",
  "cleared",
  "uncleared",
  "payment",
  "inflow",
  "outflow",
  "to_be_budgeted",
]);

export function milliunitsToCurrency(value: number): number {
  return value / 1000;
}

export function normalizeYnabPayload<T>(value: T): T {
  return normalizeValue(value) as T;
}

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item));
  }

  if (!isRecord(value)) {
    return value;
  }

  const normalized: Record<string, unknown> = {};

  for (const [key, nestedValue] of Object.entries(value)) {
    normalized[key] = normalizeValue(nestedValue);
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (
      typeof nestedValue !== "number" ||
      !Number.isFinite(nestedValue) ||
      !shouldNormalizeMoneyField(key, value)
    ) {
      continue;
    }

    const currencyKey = `${key}_currency`;

    if (!(currencyKey in normalized)) {
      normalized[currencyKey] = milliunitsToCurrency(nestedValue);
    }
  }

  return normalized;
}

function shouldNormalizeMoneyField(
  key: string,
  source: Record<string, unknown>,
): boolean {
  if (key.endsWith("_currency") || key.endsWith("_formatted")) {
    return false;
  }

  if (`${key}_currency` in source) {
    return false;
  }

  if (KNOWN_MONEY_FIELDS.has(key)) {
    return true;
  }

  return (
    key.endsWith("_amount") ||
    key.endsWith("_balance") ||
    key.endsWith("_budgeted") ||
    key.endsWith("_activity") ||
    key.endsWith("_available") ||
    key.endsWith("_funded") ||
    key.endsWith("_left") ||
    key.endsWith("_target") ||
    key.endsWith("_payment") ||
    key.endsWith("_inflow") ||
    key.endsWith("_outflow")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

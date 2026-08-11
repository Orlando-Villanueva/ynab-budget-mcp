export interface ScheduledOccurrence {
  scheduled_transaction_id: string;
  occurrence_date: string;
  amount: number;
  amount_currency: number;
  account_id: unknown;
  account_name: unknown;
  payee_id: unknown;
  payee_name: unknown;
  category_id: unknown;
  category_name: unknown;
  transfer_account_id: unknown;
  is_transfer: boolean;
  subtransactions: unknown[];
}

const DAY_MS = 86_400_000;

export function inclusiveDaySpan(fromDate: string, throughDate: string): number {
  return Math.floor((parseIsoDate(throughDate).getTime() - parseIsoDate(fromDate).getTime()) / DAY_MS) + 1;
}

export function expandScheduledTransaction(
  schedule: Record<string, unknown>,
  fromDate: string,
  throughDate: string,
): ScheduledOccurrence[] {
  const id = typeof schedule.id === "string" ? schedule.id : "";
  const dateNext = typeof schedule.date_next === "string" ? schedule.date_next : "";
  const dateFirst = typeof schedule.date_first === "string" ? schedule.date_first : dateNext;
  const frequency = typeof schedule.frequency === "string" ? schedule.frequency : "never";

  if (!id || !isIsoDate(dateNext)) {
    return [];
  }

  const dates = frequency === "twiceAMonth"
    ? expandTwiceMonthly(dateFirst, dateNext, fromDate, throughDate)
    : expandRegular(dateFirst, dateNext, frequency, fromDate, throughDate);

  return dates
    .filter((date) => date >= fromDate && date <= throughDate)
    .map((occurrenceDate) => toOccurrence(schedule, id, occurrenceDate));
}

function expandRegular(
  dateFirst: string,
  dateNext: string,
  frequency: string,
  fromDate: string,
  throughDate: string,
): string[] {
  const dates: string[] = [];
  let current = advanceRegularToDate(dateNext, dateFirst, frequency, fromDate);

  while (current <= throughDate) {
    dates.push(current);

    const next = nextOccurrence(current, dateFirst, frequency);
    if (!next || next <= current) {
      break;
    }
    current = next;
  }

  return dates;
}

function advanceRegularToDate(
  dateNext: string,
  dateFirst: string,
  frequency: string,
  fromDate: string,
): string {
  if (dateNext >= fromDate) {
    return dateNext;
  }

  const dayInterval = dayIntervalFor(frequency);
  if (dayInterval) {
    const elapsedDays = Math.floor(
      (parseIsoDate(fromDate).getTime() - parseIsoDate(dateNext).getTime()) / DAY_MS,
    );
    const intervals = Math.floor(elapsedDays / dayInterval);
    const candidate = addDays(dateNext, intervals * dayInterval);
    return candidate < fromDate ? addDays(candidate, dayInterval) : candidate;
  }

  const monthInterval = monthIntervalFor(frequency);
  if (monthInterval) {
    const next = parseIsoDate(dateNext);
    const from = parseIsoDate(fromDate);
    const elapsedMonths =
      (from.getUTCFullYear() - next.getUTCFullYear()) * 12 +
      from.getUTCMonth() - next.getUTCMonth();
    const intervals = Math.floor(elapsedMonths / monthInterval);
    const candidate = addMonthsAnchored(dateNext, dateFirst, intervals * monthInterval);
    return candidate < fromDate
      ? addMonthsAnchored(candidate, dateFirst, monthInterval)
      : candidate;
  }

  return dateNext;
}

function dayIntervalFor(frequency: string): number | undefined {
  switch (frequency) {
    case "daily":
      return 1;
    case "weekly":
      return 7;
    case "everyOtherWeek":
      return 14;
    case "every4Weeks":
      return 28;
    default:
      return undefined;
  }
}

function monthIntervalFor(frequency: string): number | undefined {
  switch (frequency) {
    case "monthly":
      return 1;
    case "everyOtherMonth":
      return 2;
    case "every3Months":
      return 3;
    case "every4Months":
      return 4;
    case "twiceAYear":
      return 6;
    case "yearly":
      return 12;
    case "everyOtherYear":
      return 24;
    default:
      return undefined;
  }
}

function nextOccurrence(current: string, dateFirst: string, frequency: string): string | undefined {
  switch (frequency) {
    case "never":
      return undefined;
    case "daily":
      return addDays(current, 1);
    case "weekly":
      return addDays(current, 7);
    case "everyOtherWeek":
      return addDays(current, 14);
    case "every4Weeks":
      return addDays(current, 28);
    case "monthly":
      return addMonthsAnchored(current, dateFirst, 1);
    case "everyOtherMonth":
      return addMonthsAnchored(current, dateFirst, 2);
    case "every3Months":
      return addMonthsAnchored(current, dateFirst, 3);
    case "every4Months":
      return addMonthsAnchored(current, dateFirst, 4);
    case "twiceAYear":
      return addMonthsAnchored(current, dateFirst, 6);
    case "yearly":
      return addMonthsAnchored(current, dateFirst, 12);
    case "everyOtherYear":
      return addMonthsAnchored(current, dateFirst, 24);
    default:
      return undefined;
  }
}

function expandTwiceMonthly(
  dateFirst: string,
  dateNext: string,
  fromDate: string,
  throughDate: string,
): string[] {
  const anchor = parseIsoDate(isIsoDate(dateFirst) ? dateFirst : dateNext);
  const anchorDay = anchor.getUTCDate();
  const start = parseIsoDate(dateNext > fromDate ? dateNext : fromDate);
  const end = parseIsoDate(throughDate);
  const dates: string[] = [];
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth() - 1;

  while (month < 0) {
    year -= 1;
    month += 12;
  }

  while (Date.UTC(year, month, 1) <= end.getTime()) {
    const first = makeClampedDate(year, month, anchorDay);
    const second = new Date(first.getTime() + 15 * DAY_MS);

    for (const candidate of [first, second]) {
      const value = formatIsoDate(candidate);
      if (value >= dateNext && value <= throughDate) {
        dates.push(value);
      }
    }

    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }

  return [...new Set(dates)].sort();
}

function addDays(value: string, days: number): string {
  return formatIsoDate(new Date(parseIsoDate(value).getTime() + days * DAY_MS));
}

function addMonthsAnchored(current: string, dateFirst: string, months: number): string {
  const currentDate = parseIsoDate(current);
  const anchorDate = parseIsoDate(isIsoDate(dateFirst) ? dateFirst : current);
  const totalMonths = currentDate.getUTCFullYear() * 12 + currentDate.getUTCMonth() + months;
  const year = Math.floor(totalMonths / 12);
  const month = totalMonths % 12;
  return formatIsoDate(makeClampedDate(year, month, anchorDate.getUTCDate()));
}

function makeClampedDate(year: number, month: number, day: number): Date {
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDay)));
}

function toOccurrence(
  schedule: Record<string, unknown>,
  id: string,
  occurrenceDate: string,
): ScheduledOccurrence {
  const amount = typeof schedule.amount === "number" ? schedule.amount : 0;
  return {
    scheduled_transaction_id: id,
    occurrence_date: occurrenceDate,
    amount,
    amount_currency: typeof schedule.amount_currency === "number"
      ? schedule.amount_currency
      : amount / 1000,
    account_id: schedule.account_id ?? null,
    account_name: schedule.account_name ?? null,
    payee_id: schedule.payee_id ?? null,
    payee_name: schedule.payee_name ?? null,
    category_id: schedule.category_id ?? null,
    category_name: schedule.category_name ?? null,
    transfer_account_id: schedule.transfer_account_id ?? null,
    is_transfer: typeof schedule.transfer_account_id === "string",
    subtransactions: Array.isArray(schedule.subtransactions) ? schedule.subtransactions : [],
  };
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = parseIsoDate(value);
  return !Number.isNaN(parsed.getTime()) && formatIsoDate(parsed) === value;
}

function parseIsoDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function formatIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

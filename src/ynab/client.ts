import { normalizeYnabPayload } from "./normalize.ts";

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface RequestMeta {
  cache_key: string;
  request_url: string;
  delta_supported: boolean;
  delta_request: boolean;
  memory_cache_hit: boolean;
  refresh_requested: boolean;
  response_mode: "full" | "delta" | "ttl";
}

export interface ClientResult<T extends Record<string, unknown>> {
  data: T;
  meta: RequestMeta;
}

interface DeltaCacheEntry {
  data: Record<string, unknown>;
  serverKnowledge: number;
}

interface MemoryCacheEntry {
  data: Record<string, unknown>;
  expiresAt: number;
}

interface ResolvedPlanCacheEntry {
  planId: string;
  expiresAt: number;
}

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  useTtlCache?: boolean;
  refresh?: boolean;
}

export interface YnabClientOptions {
  accessToken?: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  ttlMs?: number;
}

export class YnabConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YnabConfigurationError";
  }
}

export class YnabApiError extends Error {
  status: number;
  errorId?: string;
  errorName?: string;
  detail?: string;
  kind: string;

  constructor(args: {
    status: number;
    message: string;
    errorId?: string;
    errorName?: string;
    detail?: string;
    kind: string;
  }) {
    super(args.message);
    this.name = "YnabApiError";
    this.status = args.status;
    this.errorId = args.errorId;
    this.errorName = args.errorName;
    this.detail = args.detail;
    this.kind = args.kind;
  }

  toStructured(): Record<string, unknown> {
    return {
      status: this.status,
      kind: this.kind,
      error_id: this.errorId ?? null,
      error_name: this.errorName ?? null,
      detail: this.detail ?? null,
      message: this.message,
    };
  }
}

export class YnabClient {
  private readonly accessToken?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly deltaCache = new Map<string, DeltaCacheEntry>();
  private readonly memoryCache = new Map<string, MemoryCacheEntry>();
  private defaultPlanCache?: ResolvedPlanCacheEntry;

  constructor(options: YnabClientOptions = {}) {
    this.accessToken = options.accessToken;
    this.baseUrl = options.baseUrl ?? "https://api.ynab.com/v1/";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 30_000;
  }

  async listPlans(refresh = false): Promise<ClientResult<{ plans: unknown[] }>> {
    if (refresh) {
      this.defaultPlanCache = undefined;
    }
    return this.getJson<{ plans: unknown[] }>("/plans", { refresh });
  }

  async resolvePlanId(planId = "default", refresh = false): Promise<string> {
    if (planId !== "default") {
      return planId;
    }

    if (!refresh && this.defaultPlanCache && this.defaultPlanCache.expiresAt > this.now()) {
      return this.defaultPlanCache.planId;
    }

    const response = await this.listPlans(refresh);
    const plans = Array.isArray(response.data.plans) ? response.data.plans : [];
    const resolvedPlanId = selectDefaultPlanId(plans);

    this.defaultPlanCache = {
      planId: resolvedPlanId,
      expiresAt: this.now() + this.ttlMs,
    };

    return resolvedPlanId;
  }

  async getPlan(
    planId: string,
    refresh = false,
  ): Promise<ClientResult<{ plan: Record<string, unknown>; server_knowledge?: number }>> {
    return this.getJson<{ plan: Record<string, unknown>; server_knowledge?: number }>(
      `/plans/${encodeURIComponent(planId)}`,
      { refresh },
    );
  }

  async getMonth(
    planId: string,
    month: string,
    refresh = false,
  ): Promise<ClientResult<{ month: Record<string, unknown> }>> {
    const normalizedMonth = normalizeMonthPathSegment(month);

    return this.getJson<{ month: Record<string, unknown> }>(
      `/plans/${encodeURIComponent(planId)}/months/${normalizedMonth}`,
      { refresh },
    );
  }

  async listAccounts(
    planId: string,
    refresh = false,
  ): Promise<ClientResult<{ accounts: unknown[]; server_knowledge?: number }>> {
    return this.getJson<{ accounts: unknown[]; server_knowledge?: number }>(
      `/plans/${encodeURIComponent(planId)}/accounts`,
      { refresh },
    );
  }

  async listCategories(
    planId: string,
    refresh = false,
  ): Promise<ClientResult<{ category_groups: unknown[]; server_knowledge?: number }>> {
    return this.getJson<{ category_groups: unknown[]; server_knowledge?: number }>(
      `/plans/${encodeURIComponent(planId)}/categories`,
      { refresh },
    );
  }

  async listTransactions(
    planId: string,
    query: {
      since_date?: string;
      until_date?: string;
      type?: "uncategorized" | "unapproved";
    } = {},
    refresh = false,
  ): Promise<ClientResult<{ transactions: unknown[]; server_knowledge?: number }>> {
    return this.getJson<{ transactions: unknown[]; server_knowledge?: number }>(
      `/plans/${encodeURIComponent(planId)}/transactions`,
      { query, refresh },
    );
  }

  async listPayees(
    planId: string,
    refresh = false,
  ): Promise<ClientResult<{ payees: unknown[]; server_knowledge?: number }>> {
    return this.getJson<{ payees: unknown[]; server_knowledge?: number }>(
      `/plans/${encodeURIComponent(planId)}/payees`,
      { refresh },
    );
  }

  async getMonthCategory(
    planId: string,
    month: string,
    categoryId: string,
    refresh = false,
  ): Promise<ClientResult<{ category: Record<string, unknown> }>> {
    const normalizedMonth = normalizeMonthPathSegment(month);

    return this.getJson<{ category: Record<string, unknown> }>(
      `/plans/${encodeURIComponent(planId)}/months/${normalizedMonth}/categories/${encodeURIComponent(categoryId)}`,
      { refresh },
    );
  }

  async listScheduledTransactions(
    planId: string,
    refresh = false,
  ): Promise<ClientResult<{ scheduled_transactions: unknown[]; server_knowledge?: number }>> {
    return this.getJson<{ scheduled_transactions: unknown[]; server_knowledge?: number }>(
      `/plans/${encodeURIComponent(planId)}/scheduled_transactions`,
      { refresh },
    );
  }

  async updateMonthCategory(
    planId: string,
    month: string,
    categoryId: string,
    budgeted: number,
  ): Promise<ClientResult<{ category: Record<string, unknown>; server_knowledge?: number }>> {
    const normalizedMonth = normalizeMonthPathSegment(month);
    const path = `/plans/${encodeURIComponent(planId)}/months/${normalizedMonth}/categories/${encodeURIComponent(categoryId)}`;

    return this.sendJson<{ category: Record<string, unknown>; server_knowledge?: number }>(
      "PATCH",
      path,
      { category: { budgeted } },
    );
  }

  invalidatePlanCaches(planId: string): void {
    const encodedPlanId = encodeURIComponent(planId);
    const prefix = `/plans/${encodedPlanId}`;

    for (const key of this.deltaCache.keys()) {
      if (key === prefix || key.startsWith(`${prefix}/`) || key.startsWith(`${prefix}?`)) {
        this.deltaCache.delete(key);
      }
    }

    for (const key of this.memoryCache.keys()) {
      if (key === prefix || key.startsWith(`${prefix}/`) || key.startsWith(`${prefix}?`)) {
        this.memoryCache.delete(key);
      }
    }
  }

  private async getJson<T extends Record<string, unknown>>(
    path: string,
    options: RequestOptions = {},
  ): Promise<ClientResult<T>> {
    const query = options.query ?? {};
    const useTtlCache = options.useTtlCache ?? true;
    const refresh = options.refresh ?? false;
    const cacheKey = createCacheKey(path, query);
    const deltaSupported = supportsDelta(path);
    const memoryEntry = !refresh && !deltaSupported && useTtlCache
      ? this.memoryCache.get(cacheKey)
      : undefined;

    if (memoryEntry && memoryEntry.expiresAt > this.now()) {
      return {
        data: memoryEntry.data as T,
        meta: {
          cache_key: cacheKey,
          request_url: this.buildUrl(path, query).toString(),
          delta_supported: false,
          delta_request: false,
          memory_cache_hit: true,
          refresh_requested: false,
          response_mode: "ttl",
        },
      };
    }

    const requestQuery = { ...query };
    const deltaEntry = !refresh && deltaSupported ? this.deltaCache.get(cacheKey) : undefined;

    if (deltaEntry) {
      requestQuery.last_knowledge_of_server = String(deltaEntry.serverKnowledge);
    }

    const url = this.buildUrl(path, requestQuery);
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: this.createHeaders(),
    });

    const bodyText = await response.text();
    const parsedBody = parseJsonSafely(bodyText);

    if (!response.ok) {
      throw mapYnabError(response.status, parsedBody, bodyText);
    }

    const data = extractDataObject(parsedBody);
    const mergedData = deltaEntry ? mergeDeltaPayload(deltaEntry.data, data) : data;
    const normalizedData = normalizeYnabPayload(mergedData) as T;

    if (deltaSupported) {
      const serverKnowledge = readServerKnowledge(mergedData);

      if (typeof serverKnowledge === "number") {
        this.deltaCache.set(cacheKey, {
          data: mergedData,
          serverKnowledge,
        });
      }
    } else if (useTtlCache) {
      this.memoryCache.set(cacheKey, {
        data: normalizedData,
        expiresAt: this.now() + this.ttlMs,
      });
    }

    return {
      data: normalizedData,
      meta: {
        cache_key: cacheKey,
        request_url: url.toString(),
        delta_supported: deltaSupported,
        delta_request: deltaEntry !== undefined,
        memory_cache_hit: false,
        refresh_requested: refresh,
        response_mode: deltaEntry ? "delta" : "full",
      },
    };
  }

  private async sendJson<T extends Record<string, unknown>>(
    method: "PATCH",
    path: string,
    body: Record<string, unknown>,
  ): Promise<ClientResult<T>> {
    const url = this.buildUrl(path, {});
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        ...this.createHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const bodyText = await response.text();
    const parsedBody = parseJsonSafely(bodyText);

    if (!response.ok) {
      throw mapYnabError(response.status, parsedBody, bodyText);
    }

    const data = normalizeYnabPayload(extractDataObject(parsedBody)) as T;
    return {
      data,
      meta: {
        cache_key: path,
        request_url: url.toString(),
        delta_supported: false,
        delta_request: false,
        memory_cache_hit: false,
        refresh_requested: false,
        response_mode: "full",
      },
    };
  }

  private createHeaders(): Record<string, string> {
    return {
      Accept: "application/json",
      Authorization: `Bearer ${this.getAccessToken()}`,
    };
  }

  private getAccessToken(): string {
    const accessToken = this.accessToken ?? process.env.YNAB_ACCESS_TOKEN;

    if (!accessToken) {
      throw new YnabConfigurationError(
        "YNAB_ACCESS_TOKEN is not configured. Set it in your environment or .env file.",
      );
    }

    return accessToken;
  }

  private buildUrl(
    path: string,
    query: Record<string, string | number | boolean | undefined>,
  ): URL {
    const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
    const url = new URL(normalizedPath, this.baseUrl);
    const queryString = buildQueryString(query);

    if (queryString) {
      url.search = queryString;
    }

    return url;
  }
}

export function buildQueryString(
  query: Record<string, string | number | boolean | undefined>,
): string {
  const params = new URLSearchParams();

  for (const key of Object.keys(query).sort()) {
    const value = query[key];

    if (value === undefined) {
      continue;
    }

    params.set(key, String(value));
  }

  return params.toString();
}

export function createCacheKey(
  path: string,
  query: Record<string, string | number | boolean | undefined>,
): string {
  const queryString = buildQueryString(query);
  return queryString ? `${path}?${queryString}` : path;
}

export function supportsDelta(path: string): boolean {
  return [
    /^\/plans\/[^/]+$/,
    /^\/plans\/[^/]+\/accounts$/,
    /^\/plans\/[^/]+\/categories$/,
    /^\/plans\/[^/]+\/money_movements$/,
    /^\/plans\/[^/]+\/money_movement_groups$/,
    /^\/plans\/[^/]+\/months$/,
    /^\/plans\/[^/]+\/payees$/,
    /^\/plans\/[^/]+\/scheduled_transactions$/,
    /^\/plans\/[^/]+\/transactions$/,
  ].some((pattern) => pattern.test(path));
}

export function selectDefaultPlanId(plans: unknown[]): string {
  const planRecords = plans.filter(isRecord);

  if (planRecords.length === 0) {
    throw new YnabApiError({
      status: 404,
      kind: "not_found",
      message: "No YNAB plans are available for the configured token.",
    });
  }

  const preferredPlan = [...planRecords]
    .sort(comparePlansForDefaultSelection)[0];

  const planId = typeof preferredPlan?.id === "string" ? preferredPlan.id : undefined;

  if (!planId) {
    throw new YnabApiError({
      status: 500,
      kind: "api_error",
      message: "YNAB returned a plan list without a usable id.",
    });
  }

  return planId;
}

export function mergeDeltaPayload(
  base: Record<string, unknown>,
  delta: Record<string, unknown>,
): Record<string, unknown> {
  return mergeValues(base, delta) as Record<string, unknown>;
}

function mergeValues(base: unknown, delta: unknown): unknown {
  if (delta === undefined) {
    return base;
  }

  if (Array.isArray(base) && Array.isArray(delta)) {
    return mergeArrays(base, delta);
  }

  if (isRecord(base) && isRecord(delta)) {
    const merged: Record<string, unknown> = { ...base };

    for (const [key, value] of Object.entries(delta)) {
      merged[key] = mergeValues(base[key], value);
    }

    return merged;
  }

  return delta;
}

function mergeArrays(base: unknown[], delta: unknown[]): unknown[] {
  if (!hasIdentifiableObjects(base) || !hasIdentifiableObjects(delta)) {
    return delta;
  }

  const merged = new Map<string, Record<string, unknown>>();
  const order: string[] = [];

  for (const item of base) {
    const objectItem = item as Record<string, unknown>;
    const id = String(objectItem.id);
    merged.set(id, objectItem);
    order.push(id);
  }

  for (const item of delta) {
    const objectItem = item as Record<string, unknown>;
    const id = String(objectItem.id);

    if (objectItem.deleted === true) {
      merged.delete(id);
      continue;
    }

    if (merged.has(id)) {
      merged.set(id, mergeValues(merged.get(id), objectItem) as Record<string, unknown>);
      continue;
    }

    merged.set(id, objectItem);
    order.push(id);
  }

  const dedupedOrder = [...new Set(order)];
  return dedupedOrder.flatMap((id) => {
    const value = merged.get(id);
    return value ? [value] : [];
  });
}

function hasIdentifiableObjects(values: unknown[]): boolean {
  return values.every(
    (value) => isRecord(value) && typeof value.id !== "undefined",
  );
}

function parseJsonSafely(text: string): unknown {
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw_text: text };
  }
}

function extractDataObject(value: unknown): Record<string, unknown> {
  if (isRecord(value) && isRecord(value.data)) {
    return value.data;
  }

  if (isRecord(value)) {
    return value;
  }

  return {};
}

function readServerKnowledge(value: Record<string, unknown>): number | undefined {
  const candidate = value.server_knowledge;
  return typeof candidate === "number" ? candidate : undefined;
}

function comparePlansForDefaultSelection(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): number {
  const archiveWeight = Number(isArchivedPlanName(left.name)) - Number(isArchivedPlanName(right.name));

  if (archiveWeight !== 0) {
    return archiveWeight;
  }

  const leftModified = normalizeTimestamp(left.last_modified_on);
  const rightModified = normalizeTimestamp(right.last_modified_on);

  if (leftModified !== rightModified) {
    return rightModified - leftModified;
  }

  const leftName = typeof left.name === "string" ? left.name : "";
  const rightName = typeof right.name === "string" ? right.name : "";
  return leftName.localeCompare(rightName);
}

function isArchivedPlanName(value: unknown): boolean {
  return typeof value === "string" && /\(Archived on \d{4}-\d{2}-\d{2}\)/.test(value);
}

function normalizeTimestamp(value: unknown): number {
  if (typeof value !== "string") {
    return 0;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function normalizeMonthPathSegment(month: string): string {
  return /^\d{4}-\d{2}$/.test(month) ? `${month}-01` : month;
}

export function mapYnabError(
  status: number,
  parsedBody: unknown,
  rawBody: string,
): YnabApiError {
  const errorObject = isRecord(parsedBody) && isRecord(parsedBody.error)
    ? parsedBody.error
    : {};
  const errorId = typeof errorObject.id === "string" ? errorObject.id : undefined;
  const errorName = typeof errorObject.name === "string" ? errorObject.name : undefined;
  const detail = typeof errorObject.detail === "string"
    ? errorObject.detail
    : rawBody || undefined;

  const kind = status >= 500
    ? "upstream_server_error"
    : status === 429
    ? "rate_limit"
    : status === 404
    ? "not_found"
    : status === 403
    ? "forbidden"
    : status === 401
    ? "unauthorized"
    : "api_error";

  const message = status === 401
    ? "YNAB rejected the access token. Check YNAB_ACCESS_TOKEN."
    : status === 403
    ? "YNAB denied this request."
    : status === 404
    ? "The requested YNAB resource was not found."
    : status === 429
    ? "YNAB API rate limit exceeded. Try again shortly."
    : status >= 500
    ? "YNAB API is currently unavailable."
    : `YNAB API request failed with status ${status}.`;

  return new YnabApiError({
    status,
    errorId,
    errorName,
    detail,
    kind,
    message,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

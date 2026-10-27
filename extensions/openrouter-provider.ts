import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { getAgentDir } from "@earendil-works/pi-coding-agent"
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"

interface OpenRouterProviderResponse {
  provider_name?: string
  status?: number
}

interface OpenRouterGenerationData {
  provider_name?: string
  /** Providers OpenRouter tried, in order, ending with the one that served the request. */
  provider_responses?: OpenRouterProviderResponse[]
  total_cost?: number | null
  /** Number of tokens in the completion. */
  tokens_completion?: number | null
  /** Time taken for generation in milliseconds. */
  generation_time?: number | null
  /** Prompt tokens served from the provider's cache, or null when unsupported. */
  native_tokens_cached?: number | undefined
  /** Provider-native prompt tokens, the denominator for the cache hit rate. */
  native_tokens_prompt?: number | undefined
}

interface OpenRouterEndpoint {
  provider_name?: string
  tag?: string
  status?: number
  latency_last_30m?: { p50?: number }
  throughput_last_30m?: { p50?: number }
  uptime_last_30m?: number
}

/** The fields of a public `GET /models` entry used to order models by release. */
interface OpenRouterModel {
  id: string
  created?: number
}

interface RecentModelEntry {
  provider: string
  id: string
  name: string
  lastUsedAt: number
}

function readRetryDelayScale(value: string | undefined): number {
  const scale = Number(value)
  return value !== undefined && Number.isFinite(scale) && scale >= 0 ? scale : 1
}

/** API base, overridable so end-to-end tests can point at a local stub server. */
const OPENROUTER_API_URL =
  process.env.PI_OPENROUTER_API_URL ?? "https://openrouter.ai/api/v1"
/** Multiplier for generation retry delays; tests shrink it to keep runs fast. */
const RETRY_DELAY_SCALE = readRetryDelayScale(
  process.env.PI_OPENROUTER_RETRY_DELAY_SCALE
)
const RETRY_DELAYS_MS = [0, 250, 750, 1500, 3000, 5000] as const
/** Background retries after RETRY_DELAYS_MS while OpenRouter still has not indexed a generation. */
const LATE_RETRY_DELAYS_MS = [
  10_000, 20_000, 30_000, 60_000, 120_000, 300_000,
] as const
/** Footer entry counting generations still being retried in the background. */
const RETRY_STATUS_KEY = "openrouter-retries"
const CONFIG_PATH = join(getAgentDir(), "openrouter-provider.json")
const OPENROUTER_MODELS_URL = `${OPENROUTER_API_URL}/models`
const NEWEST_MODELS_LIMIT = 10
const LAST_MODELS_PATH = join(getAgentDir(), "last-models.json")
const LAST_MODELS_LIMIT = 5
const SORT_CONFIG_PATH = join(getAgentDir(), "openrouter-sort.json")

type SortBy = "throughput" | "price" | "latency"

interface SortOption {
  label: string
  by: SortBy | undefined
}

const DEFAULT_SORT_BY: SortBy = "throughput"
const SORT_OPTIONS: SortOption[] = [
  { label: "Throughput — fastest output", by: "throughput" },
  { label: "Price — cheapest provider", by: "price" },
  { label: "Latency — fastest time to first token", by: "latency" },
  { label: "OpenRouter default — no sort override", by: undefined },
]

interface LookupFailure {
  message: string
  /** Not indexed yet, rate limited, or a server/network error: a later retry may succeed. */
  retryable: boolean
}

type LookupResult =
  | { data: OpenRouterGenerationData }
  | { failure: LookupFailure }

interface GenerationState {
  /** Actual USD cost per resolved generation, keyed by OpenRouter generation id. */
  costs: Map<string, number>
  /** Shared lookups so message_end and agent_settled reuse one request. */
  requests: Map<string, Promise<OpenRouterGenerationData | undefined>>
  /** Resolved generation data, kept so repeated lookups do not re-request. */
  resolved: Map<string, OpenRouterGenerationData>
  /** Background lookups that must settle before the final status is rendered. */
  pendingRefreshes: Set<Promise<void>>
  /** Generations whose lookup failed and is still being retried, quickly or in the background. */
  retrying: Set<string>
  /** Generations handed to the slower background poll, so only one poll runs per id. */
  lateRetries: Set<string>
  /** HTTP lookups made so far per generation id, shown while waiting. */
  lookupAttempts: Map<string, number>
  /** Why each unresolved generation lookup failed, keyed by generation id. */
  lookupFailures: Map<string, LookupFailure>
  /** Most recent generation; only it may set the per-turn speed and provider. */
  latestGenerationId: string | undefined
  costTotal: number
  lastTurnTps: number | undefined
  lastProviderName: string | undefined
  lastFallbackProviders: string[]
  /** Cumulative cached prompt tokens across resolved generations. */
  cacheReadTokens: number
  /** Cumulative provider-native prompt tokens across resolved generations. */
  promptTokens: number
}

function createGenerationState(): GenerationState {
  return {
    costs: new Map(),
    requests: new Map(),
    resolved: new Map(),
    pendingRefreshes: new Set(),
    retrying: new Set(),
    lateRetries: new Set(),
    lookupAttempts: new Map(),
    lookupFailures: new Map(),
    latestGenerationId: undefined,
    costTotal: 0,
    lastTurnTps: undefined,
    lastProviderName: undefined,
    lastFallbackProviders: [],
    cacheReadTokens: 0,
    promptTokens: 0,
  }
}

/** Replaced, rather than reset, whenever Pi starts a new session. */
const generationState = { current: createGenerationState() }
/** Sort applied to auto-routed OpenRouter requests. Undefined means OpenRouter's default. */
let selectedSortBy: SortBy | undefined = DEFAULT_SORT_BY

function normalizeModelId(modelId: string): string {
  return modelId.replace(/:(?:nitro|floor|exacto)$/u, "")
}

async function getOpenRouterHeaders(ctx: ExtensionContext): Promise<Headers> {
  const auth = await ctx.modelRegistry.getProviderAuth("openrouter")
  if (auth === undefined) {
    throw new Error("OpenRouter authentication is unavailable")
  }

  const headers = new Headers()
  for (const [name, value] of Object.entries(auth.auth.headers ?? {})) {
    if (value !== null) {
      headers.set(name, value)
    }
  }
  if (auth.auth.apiKey !== undefined && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${auth.auth.apiKey}`)
  }
  return headers
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function toProviderResponse(
  value: unknown
): OpenRouterProviderResponse | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  return {
    provider_name: readString(value.provider_name),
    status: readFiniteNumber(value.status),
  }
}

function toGenerationData(
  value: unknown
): OpenRouterGenerationData | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const responses = Array.isArray(value.provider_responses)
    ? value.provider_responses
        .map((item) => toProviderResponse(item))
        .filter(
          (item): item is OpenRouterProviderResponse => item !== undefined
        )
    : undefined
  return {
    provider_name: readString(value.provider_name),
    provider_responses: responses,
    total_cost: readFiniteNumber(value.total_cost),
    tokens_completion: readFiniteNumber(value.tokens_completion),
    generation_time: readFiniteNumber(value.generation_time),
    native_tokens_cached: readFiniteNumber(value.native_tokens_cached),
    native_tokens_prompt: readFiniteNumber(value.native_tokens_prompt),
  }
}

function toP50(value: unknown): { p50?: number } | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  return { p50: readFiniteNumber(value.p50) }
}

function toEndpoint(value: unknown): OpenRouterEndpoint | undefined {
  if (!isRecord(value) || typeof value.tag !== "string") {
    return undefined
  }
  return {
    provider_name: readString(value.provider_name),
    tag: value.tag,
    status: readFiniteNumber(value.status),
    latency_last_30m: toP50(value.latency_last_30m),
    throughput_last_30m: toP50(value.throughput_last_30m),
    uptime_last_30m: readFiniteNumber(value.uptime_last_30m),
  }
}

/** Summarize a failed OpenRouter response, preferring its JSON error message. */
async function describeHttpError(response: Response): Promise<string> {
  const prefix = `HTTP ${response.status}`
  const body = await response.text().catch(() => "")
  try {
    const parsed: unknown = JSON.parse(body)
    const message =
      isRecord(parsed) && isRecord(parsed.error)
        ? readString(parsed.error.message)
        : undefined
    if (message !== undefined) {
      return `${prefix}: ${message}`
    }
  } catch {
    // Not JSON; fall back to the raw body.
  }
  return body.trim() === "" ? prefix : `${prefix}: ${body.trim()}`
}

/** Status shown when no provider could be resolved, with a compact reason. */
function providerUnavailableStatus(reason: string | undefined): string {
  const base = "provider unavailable"
  if (reason === undefined || reason.trim() === "") {
    return base
  }
  const compact = reason.replaceAll(/\s+/gu, " ").trim()
  const clipped = compact.length > 160 ? `${compact.slice(0, 159)}…` : compact
  return `${base} (${clipped})`
}

function fallbackProviders(
  data: OpenRouterGenerationData | undefined
): string[] {
  const winner = data?.provider_name
  const responses = data?.provider_responses
  if (winner === undefined || responses === undefined) {
    return []
  }

  const names: string[] = []
  for (const response of responses) {
    const name = response.provider_name
    if (name === undefined || name === winner || names.includes(name)) {
      continue
    }
    names.push(name)
  }
  return names
}

/**
 * Accumulate prompt-cache totals. Cached tokens are only counted when the
 * provider also reported a prompt total, so a hit rate can never exceed 100%.
 */
function accumulateCacheStats(
  state: GenerationState,
  data: OpenRouterGenerationData
): void {
  const promptTokens = data.native_tokens_prompt
  if (promptTokens !== undefined && promptTokens > 0) {
    state.promptTokens += promptTokens
    state.cacheReadTokens += data.native_tokens_cached ?? 0
  }
}

/**
 * Fold one resolved generation into the session. Every generation counts
 * toward cost and cache totals exactly once, regardless of resolution order;
 * only the latest one sets the per-turn speed and provider.
 */
function recordGeneration(
  state: GenerationState,
  generationId: string,
  data: OpenRouterGenerationData
): void {
  if (!state.costs.has(generationId)) {
    const cost = data.total_cost ?? 0
    state.costs.set(generationId, cost)
    state.costTotal += cost
    accumulateCacheStats(state, data)
  }
  if (generationId !== state.latestGenerationId) {
    return
  }

  const tokens = data.tokens_completion ?? 0
  const generationTimeMs = data.generation_time ?? 0
  state.lastTurnTps =
    tokens > 0 && generationTimeMs > 0
      ? tokens / (generationTimeMs / 1000)
      : undefined
  if (data.provider_name !== undefined) {
    state.lastProviderName = data.provider_name
  }
  state.lastFallbackProviders = fallbackProviders(data)
}

/** Status before any generation in the session has resolved. */
function unresolvedStatus(state: GenerationState): string | undefined {
  const latest = state.latestGenerationId
  if (latest === undefined) {
    return undefined
  }
  if (state.retrying.has(latest)) {
    const attempts = state.lookupAttempts.get(latest) ?? 0
    return `waiting for generation stats… (attempt ${attempts})`
  }
  const failure = state.lookupFailures.get(latest)
  return failure === undefined
    ? undefined
    : providerUnavailableStatus(failure.message)
}

/**
 * When some generation costs are missing from the total, show how many are
 * priced alongside how many gave up. Ones still retrying have their own entry.
 */
function unpricedSuffix(state: GenerationState): string | undefined {
  const unpriced = [...state.lookupFailures.keys()].filter(
    (id) => !state.retrying.has(id)
  ).length
  if (unpriced === 0 && state.retrying.size === 0) {
    return undefined
  }
  const priced = `${state.costs.size} priced`
  return unpriced > 0 ? `${priced}, ${unpriced} unpriced` : priced
}

/** Keep the background retry count visible in its own footer entry. */
function renderRetryStatus(
  state: GenerationState,
  ctx: ExtensionContext
): void {
  if (generationState.current !== state) {
    return
  }
  const count = state.retrying.size
  ctx.ui.setStatus(
    RETRY_STATUS_KEY,
    count > 0 ? `↻ ${count} retrying` : undefined
  )
}

/** Count a generation as still being retried. */
function markRetrying(
  state: GenerationState,
  generationId: string,
  ctx: ExtensionContext
): void {
  if (!state.retrying.has(generationId)) {
    state.retrying.add(generationId)
    renderRetryStatus(state, ctx)
  }
}

/** Stop counting a generation as retrying once it resolved or gave up. */
function clearRetrying(
  state: GenerationState,
  generationId: string,
  ctx: ExtensionContext
): void {
  if (state.retrying.delete(generationId)) {
    renderRetryStatus(state, ctx)
  }
}

function renderOpenRouterStatus(
  state: GenerationState,
  ctx: ExtensionContext
): void {
  if (state.costs.size === 0) {
    const status = unresolvedStatus(state)
    if (status !== undefined) {
      ctx.ui.setStatus("openrouter-provider", status)
    }
    return
  }
  const parts = [`$${state.costTotal.toFixed(4)}`]
  if (state.lastTurnTps !== undefined) {
    parts.push(`${state.lastTurnTps.toFixed(1)} t/s`)
  }
  if (state.promptTokens > 0) {
    const hitRate = (state.cacheReadTokens / state.promptTokens) * 100
    parts.push(`cache ${Math.round(hitRate)}%`)
  }
  if (state.lastProviderName !== undefined) {
    const fallback =
      state.lastFallbackProviders.length > 0
        ? ` (fb: ${state.lastFallbackProviders.join(", ")})`
        : ""
    parts.push(`${state.lastProviderName}${fallback}`)
  }
  const suffix = unpricedSuffix(state)
  if (suffix !== undefined) {
    parts.push(suffix)
  }
  ctx.ui.setStatus("openrouter-provider", parts.join(", "))
}

/** Count one lookup, refreshing the waiting status while it is polled late. */
function noteLookupAttempt(
  state: GenerationState,
  generationId: string,
  ctx: ExtensionContext
): void {
  state.lookupAttempts.set(
    generationId,
    (state.lookupAttempts.get(generationId) ?? 0) + 1
  )
  if (state.retrying.has(generationId) && generationState.current === state) {
    renderOpenRouterStatus(state, ctx)
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 404 || status === 408 || status === 429 || status >= 500
}

/** One generation lookup; failures say whether retrying could still help. */
async function lookupGenerationOnce(
  url: URL,
  headers: Headers
): Promise<LookupResult> {
  let response: Response
  try {
    response = await fetch(url, { headers })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { failure: { message, retryable: true } }
  }
  if (!response.ok) {
    return {
      failure: {
        message: await describeHttpError(response),
        retryable: isRetryableStatus(response.status),
      },
    }
  }
  const result: unknown = await response.json().catch((): unknown => null)
  const data =
    isRecord(result) && isRecord(result.data)
      ? toGenerationData(result.data)
      : undefined
  if (data === undefined) {
    return {
      failure: {
        message: "generation lookup returned no data",
        retryable: false,
      },
    }
  }
  return { data }
}

async function fetchGeneration(
  state: GenerationState,
  generationId: string,
  ctx: ExtensionContext
): Promise<OpenRouterGenerationData | undefined> {
  const resolved = state.resolved.get(generationId)
  if (resolved !== undefined) {
    return resolved
  }

  const existing = state.requests.get(generationId)
  if (existing !== undefined) {
    return await existing
  }

  const request = (async (): Promise<OpenRouterGenerationData | undefined> => {
    try {
      const url = new URL(`${OPENROUTER_API_URL}/generation`)
      url.searchParams.set("id", generationId)
      const headers = await getOpenRouterHeaders(ctx)

      for (const delayMs of RETRY_DELAYS_MS) {
        if (delayMs > 0) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, delayMs * RETRY_DELAY_SCALE)
          })
        }

        noteLookupAttempt(state, generationId, ctx)
        const result = await lookupGenerationOnce(url, headers)
        if ("data" in result) {
          state.lookupFailures.delete(generationId)
          return result.data
        }
        state.lookupFailures.set(generationId, result.failure)
        if (!result.failure.retryable) {
          break
        }
        markRetrying(state, generationId, ctx)
      }
    } catch (error) {
      // Let the caller treat this generation as unresolved, but keep the reason.
      state.lookupFailures.set(generationId, {
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      })
    }
    return undefined
  })()

  state.requests.set(generationId, request)
  try {
    const data = await request
    if (data !== undefined) {
      state.resolved.set(generationId, data)
    }
    return data
  } finally {
    state.requests.delete(generationId)
  }
}

/** Replace a JSON file atomically, creating it with owner-only permissions. */
function writeJsonFile(path: string, value: unknown): void {
  const temporaryPath = `${path}.${process.pid}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  })
  renameSync(temporaryPath, path)
}

function loadSelectedRoutes(): Map<string, string[]> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"))
    if (!isRecord(parsed)) {
      return new Map()
    }

    const routes = new Map<string, string[]>()
    for (const [modelId, value] of Object.entries(parsed)) {
      if (
        !Array.isArray(value) ||
        !value.every((tag) => typeof tag === "string")
      ) {
        continue
      }
      routes.set(modelId, value)
    }
    return routes
  } catch {
    return new Map()
  }
}

function saveSelectedRoutes(routes: Map<string, string[]>): void {
  writeJsonFile(CONFIG_PATH, Object.fromEntries(routes))
}

function loadSelectedSort(): SortBy | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(SORT_CONFIG_PATH, "utf-8"))
    if (!isRecord(parsed)) {
      return DEFAULT_SORT_BY
    }
    const { by } = parsed
    if (by === null) {
      return undefined
    }
    if (by === "throughput" || by === "price" || by === "latency") {
      return by
    }
    return DEFAULT_SORT_BY
  } catch {
    return DEFAULT_SORT_BY
  }
}

function saveSelectedSort(by: SortBy | undefined): void {
  writeJsonFile(SORT_CONFIG_PATH, { by: by ?? null })
}

function autoRouteStatus(): string {
  return selectedSortBy === undefined
    ? "auto-routing (OpenRouter default)"
    : `auto-routing by ${selectedSortBy}`
}

function updateStatusForModel(
  ctx: ExtensionContext,
  selectedRoutes: Map<string, string[]>,
  model: { provider: string; id: string }
): void {
  if (model.provider !== "openrouter") {
    ctx.ui.setStatus("openrouter-provider", undefined)
    return
  }

  const preferredProvider = selectedRoutes.get(normalizeModelId(model.id))?.[0]
  ctx.ui.setStatus(
    "openrouter-provider",
    preferredProvider === undefined
      ? autoRouteStatus()
      : `preferring ${preferredProvider}`
  )
}

function isOpenRouterModel(value: unknown): value is OpenRouterModel {
  return isRecord(value) && typeof value.id === "string"
}

function isRecentModelEntry(value: unknown): value is RecentModelEntry {
  return (
    isRecord(value) &&
    typeof value.provider === "string" &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.lastUsedAt === "number"
  )
}

function findRegisteredModel(
  ctx: ExtensionContext,
  provider: string,
  id: string
) {
  return ctx.modelRegistry
    .getAll()
    .find((model) => model.provider === provider && model.id === id)
}

function loadRecentModels(): RecentModelEntry[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(LAST_MODELS_PATH, "utf-8"))
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.filter(isRecentModelEntry).slice(0, LAST_MODELS_LIMIT)
  } catch {
    return []
  }
}

function saveRecentModels(models: RecentModelEntry[]): void {
  try {
    writeJsonFile(LAST_MODELS_PATH, models)
  } catch {
    // Recent-model persistence is best effort.
  }
}

/** Move a model to the front of the recency list, keeping only the last five. */
function recordModelUse(provider: string, id: string, name: string): void {
  const others = loadRecentModels().filter(
    (entry) => entry.provider !== provider || entry.id !== id
  )
  saveRecentModels(
    [{ provider, id, name, lastUsedAt: Date.now() }, ...others].slice(
      0,
      LAST_MODELS_LIMIT
    )
  )
}

/** Release timestamps from OpenRouter's public catalog, keyed by model id. */
async function fetchReleaseDates(): Promise<Map<string, number>> {
  const response = await fetch(OPENROUTER_MODELS_URL)
  if (!response.ok) {
    throw new Error(`OpenRouter returned HTTP ${response.status}`)
  }
  const result: unknown = await response.json()
  const data = isRecord(result) && Array.isArray(result.data) ? result.data : []
  return new Map(
    data
      .filter(isOpenRouterModel)
      .map((model): [string, number] => [model.id, model.created ?? 0])
  )
}

/**
 * Keep polling a generation OpenRouter has not indexed yet, then refresh the
 * status so its cost is reflected even after the turn has settled.
 */
async function retryLateGeneration(
  state: GenerationState,
  generationId: string,
  ctx: ExtensionContext
): Promise<void> {
  try {
    for (const delayMs of LATE_RETRY_DELAYS_MS) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs * RETRY_DELAY_SCALE)
      })
      if (generationState.current !== state) {
        return
      }
      const data = await fetchGeneration(state, generationId, ctx)
      if (data !== undefined) {
        recordGeneration(state, generationId, data)
        return
      }
      if (state.lookupFailures.get(generationId)?.retryable !== true) {
        return
      }
    }
  } catch (error) {
    // Background polling outlives the turn, so a failure here (including a
    // stale ctx after the session ended) must never crash the process: the
    // generation simply stays unresolved.
    state.lookupFailures.set(generationId, {
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    })
  } finally {
    state.lateRetries.delete(generationId)
    // Late polling can outlive the session, when UI updates throw.
    try {
      clearRetrying(state, generationId, ctx)
      // A replaced session's late work must never update the new session's UI.
      if (generationState.current === state) {
        renderOpenRouterStatus(state, ctx)
      }
    } catch {
      // A stale context has no UI left to update, and must not crash the agent.
    }
  }
}

/** Resolve one generation, handing it to a background poll if it is not indexed yet. */
async function refreshGeneration(
  state: GenerationState,
  generationId: string,
  ctx: ExtensionContext
): Promise<void> {
  if (state.lateRetries.has(generationId)) {
    return
  }
  const data = await fetchGeneration(state, generationId, ctx)
  if (data !== undefined) {
    recordGeneration(state, generationId, data)
    clearRetrying(state, generationId, ctx)
    return
  }
  if (state.lateRetries.has(generationId)) {
    return
  }
  if (state.lookupFailures.get(generationId)?.retryable === true) {
    state.lateRetries.add(generationId)
    void retryLateGeneration(state, generationId, ctx)
    return
  }
  clearRetrying(state, generationId, ctx)
}

function queueGenerationRefresh(
  state: GenerationState,
  generationId: string,
  ctx: ExtensionContext
): void {
  const refresh = refreshGeneration(state, generationId, ctx)
  state.pendingRefreshes.add(refresh)
}

function formatEndpointOption(
  endpoint: OpenRouterEndpoint,
  index: number
): string {
  const throughput = endpoint.throughput_last_30m?.p50 ?? 0
  const latency = endpoint.latency_last_30m?.p50
  const uptime = endpoint.uptime_last_30m
  const latencyText =
    latency === undefined ? "n/a" : `${(latency / 1000).toFixed(2)} s`
  const uptimeText = uptime === undefined ? "n/a" : `${uptime.toFixed(2)}%`
  return `${index + 1}. ${endpoint.provider_name ?? "Unknown"} — ${throughput} t/s · ${latencyText} latency · ${uptimeText} uptime`
}

async function fetchEndpoints(
  ctx: ExtensionContext,
  modelId: string
): Promise<OpenRouterEndpoint[]> {
  const response = await fetch(
    `${OPENROUTER_API_URL}/models/${modelId}/endpoints`,
    { headers: await getOpenRouterHeaders(ctx) }
  )
  if (!response.ok) {
    throw new Error(`OpenRouter returned HTTP ${response.status}`)
  }
  const result: unknown = await response.json()
  if (
    !isRecord(result) ||
    !isRecord(result.data) ||
    !Array.isArray(result.data.endpoints)
  ) {
    return []
  }
  return result.data.endpoints
    .map((value) => toEndpoint(value))
    .filter(
      (endpoint): endpoint is OpenRouterEndpoint => endpoint !== undefined
    )
}

function isHealthyEndpoint(endpoint: OpenRouterEndpoint): boolean {
  return (
    endpoint.status === 0 &&
    endpoint.tag !== undefined &&
    endpoint.throughput_last_30m?.p50 !== undefined
  )
}

function sortByThroughput(
  endpoints: OpenRouterEndpoint[]
): OpenRouterEndpoint[] {
  return endpoints.toSorted(
    (left, right) =>
      (right.throughput_last_30m?.p50 ?? 0) -
      (left.throughput_last_30m?.p50 ?? 0)
  )
}

function endpointProviderName(
  endpoint: OpenRouterEndpoint
): string | undefined {
  return endpoint.tag?.split("/")[0]
}

/**
 * Prefer the selected provider, then keep the remaining healthy providers in
 * throughput order as a fallback list for later routing decisions.
 */
function buildRouteOrder(
  selectedProvider: string,
  healthyEndpoints: OpenRouterEndpoint[]
): string[] {
  const others = sortByThroughput(healthyEndpoints)
    .map((endpoint) => endpointProviderName(endpoint))
    .filter(
      (name, index, names): name is string =>
        name !== undefined &&
        name !== selectedProvider &&
        names.indexOf(name) === index
    )
  return [selectedProvider, ...others]
}

type ProviderChoice =
  | { kind: "auto" }
  | { kind: "provider"; endpoint: OpenRouterEndpoint }

async function chooseProvider(
  ctx: ExtensionContext,
  modelId: string,
  top: OpenRouterEndpoint[]
): Promise<ProviderChoice | undefined> {
  const providerOptions = top.map(formatEndpointOption)
  const autoOption = "Auto-route by throughput"
  const selection = await ctx.ui.select(
    `OpenRouter providers for ${modelId} (30m p50)`,
    [autoOption, ...providerOptions]
  )
  if (selection === undefined) {
    return undefined
  }
  if (selection === autoOption) {
    return { kind: "auto" }
  }
  const endpoint = top[providerOptions.indexOf(selection)]
  return endpoint === undefined ? undefined : { kind: "provider", endpoint }
}

function registerProviderSelectionCommand(
  pi: ExtensionAPI,
  selectedRoutes: Map<string, string[]>
): void {
  pi.registerCommand("openrouter-providers", {
    description:
      "Choose among the five highest-throughput providers or use automatic routing",
    handler: async (_args, ctx) => {
      if (ctx.model?.provider !== "openrouter") {
        ctx.ui.notify("The current model is not using OpenRouter", "warning")
        return
      }

      try {
        const modelId = normalizeModelId(ctx.model.id)
        const endpoints = await fetchEndpoints(ctx, modelId)
        const healthyEndpoints = endpoints.filter(isHealthyEndpoint)
        const top = sortByThroughput(healthyEndpoints).slice(0, 5)
        if (top.length === 0) {
          throw new Error(
            "OpenRouter returned no healthy endpoints with throughput data"
          )
        }

        const choice = await chooseProvider(ctx, modelId, top)
        if (choice === undefined) {
          return
        }

        if (choice.kind === "auto") {
          selectedRoutes.delete(modelId)
          saveSelectedRoutes(selectedRoutes)
          ctx.ui.setStatus("openrouter-provider", autoRouteStatus())
          return
        }

        const { endpoint } = choice
        const selectedProvider = endpointProviderName(endpoint)
        if (selectedProvider === undefined) {
          throw new Error("Selected provider is unavailable")
        }

        selectedRoutes.set(
          modelId,
          buildRouteOrder(selectedProvider, healthyEndpoints)
        )
        saveSelectedRoutes(selectedRoutes)
        ctx.ui.setStatus(
          "openrouter-provider",
          `preferring ${endpoint.provider_name ?? endpoint.tag}`
        )
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error"
        )
      }
    },
  })
}

function registerSortCommand(pi: ExtensionAPI): void {
  pi.registerCommand("openrouter-sort", {
    description:
      "Choose how auto-routed OpenRouter requests are sorted (throughput, price, or latency)",
    handler: async (_args, ctx) => {
      const options = SORT_OPTIONS.map((option) => option.label)
      const selection = await ctx.ui.select(
        "OpenRouter sort for auto-routed requests",
        options
      )
      if (selection === undefined) {
        return
      }
      const option = SORT_OPTIONS[options.indexOf(selection)]
      if (option === undefined) {
        return
      }
      selectedSortBy = option.by
      saveSelectedSort(selectedSortBy)
      ctx.ui.notify(`OpenRouter sort: ${option.label}`, "info")
    },
  })
}

/**
 * Pi's OpenRouter models, newest release first. Pi already narrows them to the
 * models the configured key may use, so only release dates come from OpenRouter.
 */
async function newestOpenRouterModels(ctx: ExtensionContext) {
  const released = await fetchReleaseDates()
  return ctx.modelRegistry
    .getAll()
    .filter((model) => model.provider === "openrouter")
    .toSorted(
      (left, right) =>
        (released.get(normalizeModelId(right.id)) ?? 0) -
        (released.get(normalizeModelId(left.id)) ?? 0)
    )
    .slice(0, NEWEST_MODELS_LIMIT)
}

function registerModelsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("openrouter-models", {
    description: "Select one of the newest OpenRouter models",
    handler: async (_args, ctx) => {
      try {
        const newest = await newestOpenRouterModels(ctx)
        if (newest.length === 0) {
          ctx.ui.notify("No OpenRouter models are available", "warning")
          return
        }

        const options = newest.map((model) => `${model.name} — ${model.id}`)
        const selection = await ctx.ui.select(
          "Newest OpenRouter models",
          options
        )
        if (selection === undefined) {
          return
        }

        const model = newest[options.indexOf(selection)]
        if (model === undefined) {
          return
        }

        const selected = await pi.setModel(model)
        if (!selected) {
          ctx.ui.notify(
            "OpenRouter authentication is not configured",
            "warning"
          )
          return
        }
        ctx.ui.notify(`Using ${model.name}`, "info")
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error"
        )
      }
    },
  })
}

function registerRecentModelsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("last-models", {
    description: "Switch to one of the five most recently used models",
    handler: async (_args, ctx) => {
      const recent = loadRecentModels()
      if (recent.length === 0) {
        ctx.ui.notify("No models used yet", "info")
        return
      }

      const options = recent.map(
        (entry) => `${entry.name} — ${entry.provider}/${entry.id}`
      )
      const selection = await ctx.ui.select("Recently used models", options)
      if (selection === undefined) {
        return
      }

      const chosen = recent[options.indexOf(selection)]
      if (chosen === undefined) {
        return
      }

      const model = findRegisteredModel(ctx, chosen.provider, chosen.id)
      if (model === undefined) {
        ctx.ui.notify(
          `Could not resolve ${chosen.provider}/${chosen.id}`,
          "error"
        )
        return
      }

      const selected = await pi.setModel(model)
      if (!selected) {
        ctx.ui.notify(
          "Authentication is not configured for this model",
          "warning"
        )
        return
      }
      ctx.ui.notify(`Using ${model.name}`, "info")
    },
  })
}

function registerSessionStatusHandlers(
  pi: ExtensionAPI,
  selectedRoutes: Map<string, string[]>
): void {
  pi.on("session_start", (_event, ctx) => {
    // A replacement state prevents late work from the prior session from
    // changing the new session's totals, even if its network request finishes.
    generationState.current = createGenerationState()
    ctx.ui.setStatus(RETRY_STATUS_KEY, undefined)

    if (ctx.model === undefined) {
      ctx.ui.setStatus("openrouter-provider", undefined)
      return
    }
    updateStatusForModel(ctx, selectedRoutes, ctx.model)
  })

  pi.on("model_select", (event, ctx) => {
    updateStatusForModel(ctx, selectedRoutes, event.model)
  })

  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== "openrouter" || !isRecord(event.payload)) {
      return
    }

    const routeOrder = selectedRoutes.get(normalizeModelId(ctx.model.id))
    const provider = isRecord(event.payload.provider)
      ? { ...event.payload.provider }
      : {}

    const preferredProvider = routeOrder?.at(0)
    if (preferredProvider !== undefined) {
      // Never sort by price and never fall back to another provider: pin the
      // selected endpoint as the only allowed one so OpenRouter cannot rerank.
      delete provider.sort
      delete provider.order
      provider.only = [preferredProvider]
      provider.allow_fallbacks = false
    } else if (selectedSortBy === undefined) {
      // "OpenRouter default" explicitly clears any configured sort so the
      // choice is authoritative even when models.json sets its own.
      delete provider.sort
    } else {
      provider.sort = { by: selectedSortBy }
    }

    return {
      ...event.payload,
      provider,
    }
  })

  pi.on("before_provider_headers", (event, ctx) => {
    if (
      ctx.model?.provider === "openrouter" &&
      selectedRoutes.has(normalizeModelId(ctx.model.id))
    ) {
      event.headers["x-session-id"] = null
    }
  })
}

function registerModelTrackingHandlers(pi: ExtensionAPI): void {
  pi.on("model_select", (event) => {
    recordModelUse(event.model.provider, event.model.id, event.model.name)
  })

  pi.on("message_end", (event, ctx) => {
    const { message } = event
    if (message.role !== "assistant") {
      return
    }
    const name =
      findRegisteredModel(ctx, message.provider, message.model)?.name ??
      message.model
    recordModelUse(message.provider, message.model, name)
  })

  pi.on("message_end", (event, ctx) => {
    const { message } = event
    if (message.role !== "assistant" || message.provider !== "openrouter") {
      return
    }
    const generationId = message.responseId
    if (generationId === undefined) {
      return
    }
    // Prefetch every generation so tool-call responses count toward the total.
    generationState.current.latestGenerationId = generationId
    queueGenerationRefresh(generationState.current, generationId, ctx)
  })
}

/** Explain why an assistant message carries no OpenRouter generation id. */
function missingGenerationReason(message: {
  stopReason: string
  errorMessage?: string
}): string {
  if (message.errorMessage !== undefined) {
    return message.errorMessage
  }
  return message.stopReason === "aborted"
    ? "request aborted"
    : `no generation id (stop reason: ${message.stopReason})`
}

async function settleGenerationStatus(ctx: ExtensionContext): Promise<void> {
  const state = generationState.current
  const entry = ctx.sessionManager
    .getBranch()
    .findLast(
      (candidate) =>
        candidate.type === "message" && candidate.message.role === "assistant"
    )
  if (
    !entry ||
    entry.type !== "message" ||
    entry.message.role !== "assistant"
  ) {
    return
  }

  if (entry.message.provider !== "openrouter") {
    ctx.ui.setStatus("openrouter-provider", undefined)
    return
  }

  const generationId = entry.message.responseId
  if (generationId === undefined) {
    ctx.ui.setStatus(
      "openrouter-provider",
      providerUnavailableStatus(missingGenerationReason(entry.message))
    )
    return
  }

  if (state.costs.size === 0) {
    ctx.ui.setStatus("openrouter-provider", "resolving provider…")
  }

  state.latestGenerationId = generationId
  queueGenerationRefresh(state, generationId, ctx)
  await Promise.all(state.pendingRefreshes)
  state.pendingRefreshes.clear()

  // A session replacement can occur while OpenRouter is being queried. The
  // old state may finish, but its old context must never update the new UI.
  if (generationState.current !== state) {
    return
  }

  renderOpenRouterStatus(state, ctx)
}

export default function openRouterProvider(pi: ExtensionAPI) {
  const selectedRoutes = loadSelectedRoutes()
  selectedSortBy = loadSelectedSort()

  registerProviderSelectionCommand(pi, selectedRoutes)
  registerSortCommand(pi)
  registerModelsCommand(pi)
  registerRecentModelsCommand(pi)
  registerModelTrackingHandlers(pi)
  registerSessionStatusHandlers(pi, selectedRoutes)

  pi.on("agent_settled", async (_event, ctx) => {
    await settleGenerationStatus(ctx)
  })
}

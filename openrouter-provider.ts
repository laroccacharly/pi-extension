import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderModelConfig,
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
  /** USD discount OpenRouter applied because prompt tokens were cached. */
  cache_discount?: number | undefined
}

interface OpenRouterEndpoint {
  provider_name?: string
  tag?: string
  status?: number
  latency_last_30m?: { p50?: number }
  throughput_last_30m?: { p50?: number }
  uptime_last_30m?: number
}

interface OpenRouterModelArchitecture {
  input_modalities?: string[]
  output_modalities?: string[]
}

interface OpenRouterModelPricing {
  prompt?: string
  completion?: string
  input_cache_read?: string
  input_cache_write?: string
}

interface OpenRouterModelTopProvider {
  context_length?: number
  max_completion_tokens?: number
}

interface OpenRouterModel {
  id: string
  name?: string
  created?: number
  context_length?: number
  architecture?: OpenRouterModelArchitecture
  pricing?: OpenRouterModelPricing
  top_provider?: OpenRouterModelTopProvider
  supported_parameters?: string[]
}

interface OpenRouterModelsCache {
  checkedAt: number
  models: OpenRouterModel[]
}

interface RecentModelEntry {
  provider: string
  id: string
  name: string
  lastUsedAt: number
}

const RETRY_DELAYS_MS = [0, 250, 750, 1500, 3000, 5000] as const
const CONFIG_PATH = join(homedir(), ".pi", "agent", "openrouter-provider.json")
const MODELS_CACHE_PATH = join(
  homedir(),
  ".pi",
  "agent",
  "openrouter-models-cache.json"
)
const MODELS_CACHE_TTL_MS = 30 * 60 * 1000
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"
const RECENT_MODELS_LIMIT = 10
const LAST_MODELS_PATH = join(homedir(), ".pi", "agent", "last-models.json")
const LAST_MODELS_LIMIT = 5
const SORT_CONFIG_PATH = join(homedir(), ".pi", "agent", "openrouter-sort.json")

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

interface GenerationState {
  /** Actual USD cost per resolved generation, keyed by OpenRouter generation id. */
  costs: Map<string, number>
  /** Shared lookups so message_end and agent_settled reuse one request. */
  requests: Map<string, Promise<OpenRouterGenerationData | undefined>>
  /** Resolved generation data, kept so repeated lookups do not re-request. */
  resolved: Map<string, OpenRouterGenerationData>
  /** Background lookups that must settle before the final status is rendered. */
  pendingRefreshes: Set<Promise<void>>
  costTotal: number
  lastTurnCost: number | undefined
  lastTurnTps: number | undefined
  lastProviderName: string | undefined
  lastFallbackProviders: string[]
  /** Cumulative cached prompt tokens across resolved generations. */
  cacheReadTokens: number
  /** Cumulative provider-native prompt tokens across resolved generations. */
  promptTokens: number
  /** Cumulative USD discount from prompt caching. */
  cacheDiscountTotal: number
}

function createGenerationState(): GenerationState {
  return {
    costs: new Map(),
    requests: new Map(),
    resolved: new Map(),
    pendingRefreshes: new Set(),
    costTotal: 0,
    lastTurnCost: undefined,
    lastTurnTps: undefined,
    lastProviderName: undefined,
    lastFallbackProviders: [],
    cacheReadTokens: 0,
    promptTokens: 0,
    cacheDiscountTotal: 0,
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
    cache_discount: readFiniteNumber(value.cache_discount),
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
      const url = new URL("https://openrouter.ai/api/v1/generation")
      url.searchParams.set("id", generationId)
      const headers = await getOpenRouterHeaders(ctx)

      for (const [index, delayMs] of RETRY_DELAYS_MS.entries()) {
        if (delayMs > 0) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, delayMs)
          })
        }

        const response = await fetch(url, { headers })
        if (response.status === 404 && index < RETRY_DELAYS_MS.length - 1) {
          continue
        }
        if (!response.ok) {
          throw new Error(`OpenRouter returned HTTP ${response.status}`)
        }

        const result: unknown = await response.json()
        return isRecord(result) ? toGenerationData(result.data) : undefined
      }
    } catch {
      // Fall through and let the caller treat this generation as unresolved.
    }
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

function renderOpenRouterStatus(
  state: GenerationState,
  ctx: ExtensionContext
): void {
  if (state.lastTurnCost === undefined) {
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
  if (state.cacheDiscountTotal > 0) {
    parts.push(`saved $${state.cacheDiscountTotal.toFixed(4)}`)
  }
  if (state.lastProviderName !== undefined) {
    const fallback =
      state.lastFallbackProviders.length > 0
        ? ` (fb: ${state.lastFallbackProviders.join(", ")})`
        : ""
    parts.push(`${state.lastProviderName}${fallback}`)
  }
  ctx.ui.setStatus("openrouter-provider", parts.join(", "))
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
  state.cacheDiscountTotal += data.cache_discount ?? 0
}

/** Fold one newly resolved generation into the session cost, speed, and cache totals. */
function accumulateGeneration(
  state: GenerationState,
  generationId: string,
  data: OpenRouterGenerationData
): void {
  const cost = data.total_cost ?? 0
  state.costs.set(generationId, cost)
  state.costTotal += cost
  state.lastTurnCost = cost

  const tokens = data.tokens_completion ?? 0
  const generationTimeMs = data.generation_time ?? 0
  state.lastTurnTps =
    tokens > 0 && generationTimeMs > 0
      ? tokens / (generationTimeMs / 1000)
      : undefined

  accumulateCacheStats(state, data)
}

function recordGenerationCost(
  state: GenerationState,
  generationId: string,
  data: OpenRouterGenerationData | undefined
): void {
  if (data !== undefined && !state.costs.has(generationId)) {
    accumulateGeneration(state, generationId, data)
  }
  if (data?.provider_name !== undefined) {
    state.lastProviderName = data.provider_name
  }
  state.lastFallbackProviders = fallbackProviders(data)
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
    ? "OpenRouter: auto-routing (OpenRouter default)"
    : `OpenRouter: auto-routing by ${selectedSortBy}`
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
      : `OpenRouter: preferring ${preferredProvider}`
  )
}

function isOpenRouterModel(value: unknown): value is OpenRouterModel {
  return isRecord(value) && typeof value.id === "string"
}

function isChatModel(model: OpenRouterModel): boolean {
  const outputs = model.architecture?.output_modalities
  return outputs === undefined || outputs.includes("text")
}

function priceToPerMillion(value: string | undefined): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed * 1_000_000 : 0
}

/** Map a live OpenRouter catalog entry to a Pi model definition. */
function toInputModalities(model: OpenRouterModel): ("text" | "image")[] {
  const modalities = model.architecture?.input_modalities ?? []
  const input = modalities.filter(
    (modality): modality is "text" | "image" =>
      modality === "text" || modality === "image"
  )
  return input.length > 0 ? input : ["text"]
}

function toModelCost(
  pricing: OpenRouterModelPricing | undefined
): ProviderModelConfig["cost"] {
  return {
    input: priceToPerMillion(pricing?.prompt),
    output: priceToPerMillion(pricing?.completion),
    cacheRead: priceToPerMillion(pricing?.input_cache_read),
    cacheWrite: priceToPerMillion(pricing?.input_cache_write),
  }
}

function supportsReasoning(model: OpenRouterModel): boolean {
  const parameters = model.supported_parameters ?? []
  return (
    parameters.includes("reasoning") || parameters.includes("include_reasoning")
  )
}

function toProviderModel(model: OpenRouterModel): ProviderModelConfig {
  const reasoning = supportsReasoning(model)
  const contextWindow =
    model.context_length ?? model.top_provider?.context_length ?? 128_000
  const maxTokens =
    model.top_provider?.max_completion_tokens ?? Math.min(contextWindow, 16_384)

  return {
    id: model.id,
    name: model.name ?? model.id,
    api: "openai-completions",
    reasoning,
    input: toInputModalities(model),
    cost: toModelCost(model.pricing),
    contextWindow,
    maxTokens,
    compat: {
      supportsDeveloperRole: false,
      ...(reasoning ? { thinkingFormat: "openrouter" as const } : {}),
    },
  }
}

function loadModelsCache(): OpenRouterModelsCache | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(MODELS_CACHE_PATH, "utf-8"))
    if (!isRecord(parsed) || !Array.isArray(parsed.models)) {
      return undefined
    }
    const models = parsed.models.filter(isOpenRouterModel)
    if (models.length === 0) {
      return undefined
    }
    return {
      checkedAt: typeof parsed.checkedAt === "number" ? parsed.checkedAt : 0,
      models,
    }
  } catch {
    return undefined
  }
}

function saveModelsCache(models: OpenRouterModel[]): void {
  try {
    writeJsonFile(MODELS_CACHE_PATH, { checkedAt: Date.now(), models })
  } catch {
    // Cache persistence is best effort.
  }
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

async function fetchOpenRouterModels(
  ctx: ExtensionContext
): Promise<OpenRouterModel[]> {
  let headers: Headers | undefined
  try {
    headers = await getOpenRouterHeaders(ctx)
  } catch {
    // The models catalog is public; proceed without auth headers.
  }
  const response = await fetch(OPENROUTER_MODELS_URL, { headers })
  if (!response.ok) {
    throw new Error(`OpenRouter returned HTTP ${response.status}`)
  }
  const result: unknown = await response.json()
  const data = isRecord(result) && Array.isArray(result.data) ? result.data : []
  return data.filter(isOpenRouterModel).filter(isChatModel)
}

/**
 * Re-register the OpenRouter provider with its built-in models plus any live
 * models Pi's static catalog does not know about yet (for example stealth
 * releases such as `stealth/union-alpha`). Returns how many were new.
 */
function registerOpenRouterModels(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  liveModels: OpenRouterModel[]
): number {
  const merged = new Map<string, ProviderModelConfig>()
  for (const model of ctx.modelRegistry.getAll()) {
    if (model.provider === "openrouter") {
      merged.set(model.id, model)
    }
  }

  let added = 0
  for (const model of liveModels) {
    if (!merged.has(model.id)) {
      merged.set(model.id, toProviderModel(model))
      added += 1
    }
  }

  pi.registerProvider("openrouter", { models: [...merged.values()] })
  return added
}

async function refreshModelsInBackground(
  pi: ExtensionAPI,
  ctx: ExtensionContext
): Promise<void> {
  try {
    const liveModels = await fetchOpenRouterModels(ctx)
    if (liveModels.length === 0) {
      return
    }
    saveModelsCache(liveModels)
    registerOpenRouterModels(pi, ctx, liveModels)
  } catch {
    // Keep the cached catalog when OpenRouter is unreachable.
  }
}

async function refreshGeneration(
  state: GenerationState,
  generationId: string,
  ctx: ExtensionContext
): Promise<void> {
  const data = await fetchGeneration(state, generationId, ctx)
  recordGenerationCost(state, generationId, data)
}

function queueGenerationRefresh(
  state: GenerationState,
  generationId: string,
  ctx: ExtensionContext
): void {
  const refresh = refreshGeneration(state, generationId, ctx)
  state.pendingRefreshes.add(refresh)
}

function formatModelOption(
  model: OpenRouterModel,
  knownIds: Set<string>
): string {
  const badge = knownIds.has(model.id) ? "" : " [new]"
  return `${model.name ?? model.id}${badge} — ${model.id}`
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
    `https://openrouter.ai/api/v1/models/${modelId}/endpoints`,
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
          `OpenRouter: preferring ${endpoint.provider_name ?? endpoint.tag}`
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

function registerModelsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("openrouter-models", {
    description: "Fetch the latest OpenRouter models and select one",
    handler: async (_args, ctx) => {
      try {
        const liveModels = await fetchOpenRouterModels(ctx)
        if (liveModels.length === 0) {
          ctx.ui.notify("OpenRouter returned no chat models", "warning")
          return
        }

        saveModelsCache(liveModels)
        const priorIds = new Set(
          ctx.modelRegistry
            .getAll()
            .filter((model) => model.provider === "openrouter")
            .map((model) => model.id)
        )
        const added = registerOpenRouterModels(pi, ctx, liveModels)
        const recent = liveModels
          .toSorted((left, right) => (right.created ?? 0) - (left.created ?? 0))
          .slice(0, RECENT_MODELS_LIMIT)
        const options = recent.map((model) =>
          formatModelOption(model, priorIds)
        )

        const selection = await ctx.ui.select(
          `OpenRouter models (${added} new of ${liveModels.length})`,
          options
        )
        if (selection === undefined) {
          return
        }

        const chosen = recent[options.indexOf(selection)]
        if (chosen === undefined) {
          return
        }

        const model = ctx.modelRegistry.find("openrouter", chosen.id)
        if (model === undefined) {
          ctx.ui.notify(`Could not resolve ${chosen.id}`, "error")
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
        ctx.ui.notify(`Using ${chosen.name ?? chosen.id}`, "info")
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
    // This task mutates only its captured session state and never touches UI.
    queueGenerationRefresh(generationState.current, generationId, ctx)
  })
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
    ctx.ui.setStatus("openrouter-provider", "OpenRouter: provider unavailable")
    return
  }

  if (state.lastTurnCost === undefined) {
    ctx.ui.setStatus("openrouter-provider", "OpenRouter: resolving provider…")
  }

  queueGenerationRefresh(state, generationId, ctx)
  await Promise.all(state.pendingRefreshes)
  state.pendingRefreshes.clear()

  // A session replacement can occur while OpenRouter is being queried. The
  // old state may finish, but its old context must never update the new UI.
  if (generationState.current !== state) {
    return
  }

  if (
    state.lastProviderName === undefined &&
    state.lastTurnCost === undefined
  ) {
    ctx.ui.setStatus("openrouter-provider", "OpenRouter: provider unavailable")
    return
  }

  renderOpenRouterStatus(state, ctx)
}

function registerCatalogHandlers(
  pi: ExtensionAPI,
  selectedRoutes: Map<string, string[]>
): void {
  registerSessionStatusHandlers(pi, selectedRoutes)

  pi.on("session_start", (_event, ctx) => {
    const cache = loadModelsCache()
    if (cache !== undefined) {
      registerOpenRouterModels(pi, ctx, cache.models)
    }

    const cacheIsFresh =
      cache !== undefined && Date.now() - cache.checkedAt < MODELS_CACHE_TTL_MS
    if (!cacheIsFresh) {
      void refreshModelsInBackground(pi, ctx)
    }
  })

  pi.on("agent_settled", async (_event, ctx) => {
    await settleGenerationStatus(ctx)
  })
}

export default function openRouterProvider(pi: ExtensionAPI) {
  const selectedRoutes = loadSelectedRoutes()
  selectedSortBy = loadSelectedSort()

  registerProviderSelectionCommand(pi, selectedRoutes)
  registerSortCommand(pi)
  registerModelsCommand(pi)
  registerRecentModelsCommand(pi)
  registerModelTrackingHandlers(pi)
  registerCatalogHandlers(pi, selectedRoutes)
}

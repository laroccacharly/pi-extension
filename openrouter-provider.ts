import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent"

interface OpenRouterGenerationData {
  provider_name?: string
  total_cost?: number | null
  /** Number of tokens in the completion. */
  tokens_completion?: number | null
  /** Time taken for generation in milliseconds. */
  generation_time?: number | null
}

interface OpenRouterGenerationResponse {
  data?: OpenRouterGenerationData
}

interface OpenRouterEndpoint {
  provider_name?: string
  tag?: string
  status?: number
  latency_last_30m?: { p50?: number }
  throughput_last_30m?: { p50?: number }
  uptime_last_30m?: number
}

interface OpenRouterEndpointsResponse {
  data?: {
    endpoints?: OpenRouterEndpoint[]
  }
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

interface OpenRouterModelsResponse {
  data?: OpenRouterModel[]
}

interface OpenRouterModelsCache {
  checkedAt: number
  models: OpenRouterModel[]
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

/** Actual USD cost per resolved generation, keyed by OpenRouter generation id. */
const generationCosts = new Map<string, number>()
/** Shared in-flight generation lookups so message_end and agent_settled reuse one request. */
const generationRequests = new Map<
  string,
  Promise<OpenRouterGenerationData | undefined>
>()
let generationCostTotal = 0
let lastTurnCost: number | undefined
let lastTurnTps: number | undefined
let lastProviderName: string | undefined

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

async function fetchGeneration(
  generationId: string,
  ctx: ExtensionContext
): Promise<OpenRouterGenerationData | undefined> {
  const existing = generationRequests.get(generationId)
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

        const result = (await response.json()) as OpenRouterGenerationResponse
        return result.data
      }
    } catch {
      // Fall through and let the caller treat this generation as unresolved.
    }
  })()

  generationRequests.set(generationId, request)
  return await request
}

function renderOpenRouterStatus(ctx: ExtensionContext): void {
  if (lastTurnCost === undefined) {
    return
  }
  const parts = [
    `($${lastTurnCost.toFixed(4)})`,
    `$${generationCostTotal.toFixed(4)}`,
  ]
  if (lastTurnTps !== undefined) {
    parts.push(`${lastTurnTps.toFixed(1)} t/s`)
  }
  if (lastProviderName !== undefined) {
    parts.push(lastProviderName)
  }
  ctx.ui.setStatus("openrouter-provider", `OpenRouter: ${parts.join(", ")}`)
}

function recordGenerationCost(
  generationId: string,
  data: OpenRouterGenerationData | undefined,
  ctx: ExtensionContext
): void {
  if (data !== undefined && !generationCosts.has(generationId)) {
    const cost = data.total_cost ?? 0
    generationCosts.set(generationId, cost)
    generationCostTotal += cost
    lastTurnCost = cost

    const tokens = data.tokens_completion ?? 0
    const generationTimeMs = data.generation_time ?? 0
    lastTurnTps =
      tokens > 0 && generationTimeMs > 0
        ? tokens / (generationTimeMs / 1000)
        : undefined
  }
  if (data?.provider_name !== undefined) {
    lastProviderName = data.provider_name
  }
  renderOpenRouterStatus(ctx)
}

function loadSelectedRoutes(): Map<string, string[]> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"))
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
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
  const temporaryPath = `${CONFIG_PATH}.${process.pid}.tmp`
  writeFileSync(
    temporaryPath,
    `${JSON.stringify(Object.fromEntries(routes), null, 2)}\n`,
    { mode: 0o600 }
  )
  renameSync(temporaryPath, CONFIG_PATH)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
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
    const temporaryPath = `${MODELS_CACHE_PATH}.${process.pid}.tmp`
    writeFileSync(
      temporaryPath,
      `${JSON.stringify({ checkedAt: Date.now(), models }, null, 2)}\n`,
      { mode: 0o600 }
    )
    renameSync(temporaryPath, MODELS_CACHE_PATH)
  } catch {
    // Cache persistence is best effort.
  }
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
  const result = (await response.json()) as OpenRouterModelsResponse
  return (result.data ?? []).filter(isChatModel)
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
    if (merged.has(model.id)) {
      continue
    }
    merged.set(model.id, toProviderModel(model))
    added += 1
  }

  pi.registerProvider("openrouter", { models: [...merged.values()] })
  return added
}

export default function openRouterProvider(pi: ExtensionAPI) {
  const selectedRoutes = loadSelectedRoutes()

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
        const response = await fetch(
          `https://openrouter.ai/api/v1/models/${modelId}/endpoints`,
          {
            headers: await getOpenRouterHeaders(ctx),
          }
        )
        if (!response.ok) {
          throw new Error(`OpenRouter returned HTTP ${response.status}`)
        }

        const result = (await response.json()) as OpenRouterEndpointsResponse
        const endpoints = result.data?.endpoints ?? []
        const healthyEndpoints = endpoints.filter(
          (endpoint) =>
            endpoint.status === 0 &&
            endpoint.tag !== undefined &&
            endpoint.throughput_last_30m?.p50 !== undefined
        )
        const top = healthyEndpoints
          .toSorted(
            (left, right) =>
              (right.throughput_last_30m?.p50 ?? 0) -
              (left.throughput_last_30m?.p50 ?? 0)
          )
          .slice(0, 5)

        if (top.length === 0) {
          throw new Error(
            "OpenRouter returned no healthy endpoints with throughput data"
          )
        }

        const providerOptions = top.map((endpoint, index) => {
          const throughput = endpoint.throughput_last_30m?.p50 ?? 0
          const latency = endpoint.latency_last_30m?.p50
          const uptime = endpoint.uptime_last_30m
          return `${index + 1}. ${endpoint.provider_name ?? "Unknown"} — ${throughput} t/s · ${latency === undefined ? "n/a" : `${(latency / 1000).toFixed(2)} s`} latency · ${uptime === undefined ? "n/a" : `${uptime.toFixed(2)}%`} uptime`
        })
        const autoOption = "Auto-route by throughput"
        const selection = await ctx.ui.select(
          `OpenRouter providers for ${modelId} (30m p50)`,
          [autoOption, ...providerOptions]
        )
        if (selection === undefined) {
          return
        }

        if (selection === autoOption) {
          selectedRoutes.delete(modelId)
          saveSelectedRoutes(selectedRoutes)
          ctx.ui.setStatus(
            "openrouter-provider",
            "OpenRouter: auto-routing by throughput"
          )
          return
        }

        const selectedIndex = providerOptions.indexOf(selection)
        const endpoint = top[selectedIndex]
        if (endpoint?.tag === undefined) {
          throw new Error("Selected provider is unavailable")
        }

        const [selectedProvider] = endpoint.tag.split("/")
        if (selectedProvider === undefined) {
          throw new Error("Selected provider is unavailable")
        }
        const routeOrder = [
          selectedProvider,
          ...healthyEndpoints
            .toSorted(
              (left, right) =>
                (right.throughput_last_30m?.p50 ?? 0) -
                (left.throughput_last_30m?.p50 ?? 0)
            )
            .map((candidate) => candidate.tag?.split("/")[0])
            .filter(
              (tag, index, tags): tag is string =>
                tag !== undefined &&
                tag !== selectedProvider &&
                tags.indexOf(tag) === index
            ),
        ]
        selectedRoutes.set(modelId, routeOrder)
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

  pi.on("session_start", (_event, ctx) => {
    generationCosts.clear()
    generationRequests.clear()
    generationCostTotal = 0
    lastTurnCost = undefined
    lastTurnTps = undefined
    lastProviderName = undefined

    const routeOrder =
      ctx.model?.provider === "openrouter"
        ? selectedRoutes.get(normalizeModelId(ctx.model.id))
        : undefined
    const preferredProvider = routeOrder?.[0]
    ctx.ui.setStatus(
      "openrouter-provider",
      preferredProvider === undefined
        ? undefined
        : `OpenRouter: preferring ${preferredProvider}`
    )
  })

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
        const options = recent.map((model) => {
          const badge = priorIds.has(model.id) ? "" : " [new]"
          return `${model.name ?? model.id}${badge} — ${model.id}`
        })

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

  pi.on("session_start", (_event, ctx) => {
    const cache = loadModelsCache()
    if (cache !== undefined) {
      registerOpenRouterModels(pi, ctx, cache.models)
    }

    const cacheIsFresh =
      cache !== undefined && Date.now() - cache.checkedAt < MODELS_CACHE_TTL_MS
    if (cacheIsFresh) {
      return
    }

    void (async () => {
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
    })()
  })

  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== "openrouter") {
      return
    }
    const routeOrder = selectedRoutes.get(normalizeModelId(ctx.model.id))
    if (
      routeOrder === undefined ||
      event.payload === null ||
      event.payload === undefined ||
      typeof event.payload !== "object" ||
      Array.isArray(event.payload)
    ) {
      return
    }

    const payload = event.payload as Record<string, unknown>
    const provider =
      payload.provider !== null &&
      payload.provider !== undefined &&
      typeof payload.provider === "object" &&
      !Array.isArray(payload.provider)
        ? { ...(payload.provider as Record<string, unknown>) }
        : {}
    delete provider.only
    provider.sort = "price"
    provider.order = routeOrder
    provider.allow_fallbacks = true
    return {
      ...payload,
      model: `${normalizeModelId(ctx.model.id)}:floor`,
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

  pi.on("message_end", (event, ctx) => {
    const { message } = event
    if (message.role !== "assistant" || message.provider !== "openrouter") {
      return
    }
    const generationId = message.responseId
    if (generationId === undefined) {
      return
    }
    void (async () => {
      const data = await fetchGeneration(generationId, ctx)
      recordGenerationCost(generationId, data, ctx)
    })()
  })

  pi.on("agent_settled", async (_event, ctx) => {
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
        "OpenRouter: provider unavailable"
      )
      return
    }

    if (lastTurnCost === undefined) {
      ctx.ui.setStatus("openrouter-provider", "OpenRouter: resolving provider…")
    }

    const data = await fetchGeneration(generationId, ctx)
    recordGenerationCost(generationId, data, ctx)

    if (data?.provider_name === undefined && lastTurnCost === undefined) {
      ctx.ui.setStatus(
        "openrouter-provider",
        "OpenRouter: provider unavailable"
      )
    }
  })
}

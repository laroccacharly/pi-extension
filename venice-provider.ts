import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { getAgentDir } from "@earendil-works/pi-coding-agent"
import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent"

const PROVIDER = "venice"
const VENICE_API_URL =
  process.env.PI_VENICE_API_URL ?? "https://api.venice.ai/api/v1"
const AUTH_PATH = join(getAgentDir(), "venice.json")
const MODELS_CACHE_PATH = join(getAgentDir(), "venice-models-cache.json")
const FETCH_TIMEOUT_MS = 10_000

interface VenicePrice {
  usd?: number
}

interface VeniceModel {
  id: string
  model_spec: {
    name?: string
    offline?: boolean
    availableContextTokens?: number
    maxCompletionTokens?: number
    capabilities?: {
      supportsFunctionCalling?: boolean
      supportsReasoning?: boolean
      supportsReasoningEffort?: boolean
      supportsVision?: boolean
    }
    pricing?: {
      input?: VenicePrice
      output?: VenicePrice
      cache_input?: VenicePrice
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isVeniceModel(value: unknown): value is VeniceModel {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isRecord(value.model_spec)
  )
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"))
  } catch {
    return undefined
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function loadApiKey(): string | undefined {
  const saved = readJson(AUTH_PATH)
  return isRecord(saved) &&
    typeof saved.apiKey === "string" &&
    saved.apiKey !== ""
    ? saved.apiKey
    : undefined
}

/** Pi treats `$NAME` and leading `!` in apiKey as interpolation; escape literal keys. */
function toApiKeyConfig(key: string | undefined): string {
  if (key === undefined) {
    return "$VENICE_API_KEY"
  }
  const escaped = key.replaceAll("$", "$$$$")
  return escaped.startsWith("!") ? `$${escaped}` : escaped
}

/** Venice can only drive Pi's agent loop with models that support tool calls. */
function isUsableModel(model: VeniceModel): boolean {
  return (
    model.model_spec.offline !== true &&
    model.model_spec.capabilities?.supportsFunctionCalling === true
  )
}

function toModelCost(
  pricing: VeniceModel["model_spec"]["pricing"]
): ProviderModelConfig["cost"] {
  return {
    input: pricing?.input?.usd ?? 0,
    output: pricing?.output?.usd ?? 0,
    cacheRead: pricing?.cache_input?.usd ?? 0,
    cacheWrite: 0,
  }
}

function toProviderModel(model: VeniceModel): ProviderModelConfig {
  const spec = model.model_spec
  const capabilities = spec.capabilities ?? {}
  const contextWindow = spec.availableContextTokens ?? 128_000
  return {
    id: model.id,
    name: spec.name ?? model.id,
    reasoning: capabilities.supportsReasoning === true,
    input: capabilities.supportsVision === true ? ["text", "image"] : ["text"],
    cost: toModelCost(spec.pricing),
    contextWindow,
    maxTokens: spec.maxCompletionTokens ?? Math.min(contextWindow, 16_384),
    compat: {
      supportsDeveloperRole: false,
      supportsStore: false,
      supportsReasoningEffort: capabilities.supportsReasoningEffort === true,
    },
  }
}

function loadCachedModels(): VeniceModel[] {
  const cached = readJson(MODELS_CACHE_PATH)
  return Array.isArray(cached) ? cached.filter(isVeniceModel) : []
}

async function fetchModels(signal?: AbortSignal): Promise<VeniceModel[]> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const response = await fetch(`${VENICE_API_URL}/models?type=text`, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  if (!response.ok) {
    throw new Error(`Venice returned HTTP ${response.status}`)
  }
  const result: unknown = await response.json()
  const data = isRecord(result) && Array.isArray(result.data) ? result.data : []
  const models = data.filter(isVeniceModel).filter(isUsableModel)
  if (models.length > 0) {
    try {
      writeJson(MODELS_CACHE_PATH, models)
    } catch {
      // Cache persistence is best effort.
    }
  }
  return models
}

async function loadModels(): Promise<VeniceModel[]> {
  const cached = loadCachedModels()
  if (cached.length > 0) {
    return cached
  }
  try {
    return await fetchModels()
  } catch {
    return []
  }
}

function registerVenice(
  pi: ExtensionAPI,
  models: VeniceModel[],
  apiKey: string | undefined
): void {
  pi.registerProvider(PROVIDER, {
    name: "Venice",
    baseUrl: VENICE_API_URL,
    api: "openai-completions",
    apiKey: toApiKeyConfig(apiKey),
    models: models.map(toProviderModel),
    refreshModels: async (context) => {
      if (!context.allowNetwork) {
        return loadCachedModels().map(toProviderModel)
      }
      try {
        const live = await fetchModels(context.signal)
        return live.map(toProviderModel)
      } catch {
        return loadCachedModels().map(toProviderModel)
      }
    },
  })
}

async function promptForKey(ctx: ExtensionContext): Promise<void> {
  const input = await ctx.ui.input(
    "Venice API key",
    "Paste a key from https://venice.ai/settings/api"
  )
  const key = input?.trim()
  if (key === undefined || key === "") {
    ctx.ui.notify("Venice login cancelled", "info")
    return
  }
  try {
    writeJson(AUTH_PATH, { apiKey: key })
  } catch {
    ctx.ui.notify(`Could not save ${AUTH_PATH}`, "error")
    return
  }
  ctx.ui.notify("Venice API key saved. Pick a model with /model", "info")
}

export default async function veniceProvider(pi: ExtensionAPI): Promise<void> {
  let models = await loadModels()
  registerVenice(pi, models, loadApiKey())

  pi.registerCommand("login-venice", {
    description: "Save a Venice API key and enable Venice models",
    handler: async (_args, ctx) => {
      await promptForKey(ctx)
      const apiKey = loadApiKey()
      if (apiKey === undefined) {
        return
      }
      if (models.length === 0) {
        models = await loadModels()
      }
      registerVenice(pi, models, apiKey)
    },
  })

  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER || !isRecord(event.payload)) {
      return
    }
    // Venice prepends its own system prompt unless told not to.
    const veniceParameters = isRecord(event.payload.venice_parameters)
      ? event.payload.venice_parameters
      : {}
    return {
      ...event.payload,
      venice_parameters: {
        ...veniceParameters,
        include_venice_system_prompt: false,
      },
    }
  })
}

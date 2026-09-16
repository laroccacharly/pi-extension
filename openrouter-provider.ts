import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"

interface OpenRouterGenerationData {
  provider_name?: string
  total_cost?: number | null
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

const RETRY_DELAYS_MS = [0, 250, 750, 1500, 3000, 5000] as const
const CONFIG_PATH = join(homedir(), ".pi", "agent", "openrouter-provider.json")

/** Actual USD cost per resolved generation, keyed by OpenRouter generation id. */
const generationCosts = new Map<string, number>()
/** Shared in-flight generation lookups so message_end and agent_settled reuse one request. */
const generationRequests = new Map<
  string,
  Promise<OpenRouterGenerationData | undefined>
>()
let generationCostTotal = 0
let lastTurnCost: number | undefined
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

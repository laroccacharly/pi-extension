import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { getAgentDir } from "@earendil-works/pi-coding-agent"
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"

function updateStatus(
  ctx: ExtensionContext,
  provider: string | undefined,
  enabled: boolean
): void {
  ctx.ui.setStatus(
    "fast-codex",
    enabled && provider === "openai-codex" ? "Codex fast: on" : undefined
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function loadSettings(configPath: string): Record<string, unknown> {
  let contents: string
  try {
    contents = readFileSync(configPath, "utf-8")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {}
    }
    throw error
  }
  const saved: unknown = JSON.parse(contents)
  if (!isRecord(saved)) {
    throw new Error("Settings must be a JSON object")
  }
  return saved
}

function loadEnabled(configPath: string): boolean {
  try {
    return loadSettings(configPath).fastCodex === true
  } catch {
    return false
  }
}

function saveEnabled(
  agentDir: string,
  configPath: string,
  enabled: boolean
): void {
  mkdirSync(agentDir, { recursive: true })
  const settings = { ...loadSettings(configPath), fastCodex: enabled }
  const temporaryPath = `${configPath}.${process.pid}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600,
  })
  renameSync(temporaryPath, configPath)
}

export default function fastCodex(pi: ExtensionAPI): void {
  const agentDir = getAgentDir()
  const configPath = join(agentDir, "settings.json")
  let enabled = loadEnabled(configPath)

  pi.registerCommand("fast-codex", {
    description: "Toggle Codex priority service (on/off; higher usage charges)",
    handler: async (args, ctx) => {
      const mode = args.trim().toLowerCase()
      if (mode !== "" && mode !== "on" && mode !== "off") {
        ctx.ui.notify("Usage: /fast-codex [on|off]", "warning")
        return
      }
      if (ctx.model?.provider !== "openai-codex") {
        ctx.ui.notify("/fast-codex requires an OpenAI Codex model", "warning")
        return
      }

      await ctx.waitForIdle()
      const nextEnabled = mode === "" ? !enabled : mode === "on"
      try {
        saveEnabled(agentDir, configPath, nextEnabled)
      } catch {
        ctx.ui.notify("Could not save Codex fast mode", "error")
        return
      }
      enabled = nextEnabled
      updateStatus(ctx, ctx.model.provider, enabled)
      ctx.ui.notify(
        enabled
          ? "Codex fast mode on (priority service; higher usage charges)"
          : "Codex fast mode off",
        "info"
      )
    },
  })

  pi.on("session_start", (_event, ctx) => {
    enabled = loadEnabled(configPath)
    updateStatus(ctx, ctx.model?.provider, enabled)
  })

  pi.on("model_select", (event, ctx) => {
    updateStatus(ctx, event.model.provider, enabled)
  })

  pi.on("before_provider_request", (event, ctx) => {
    if (
      !enabled ||
      ctx.model?.provider !== "openai-codex" ||
      typeof event.payload !== "object" ||
      event.payload === null ||
      Array.isArray(event.payload)
    ) {
      return
    }
    return { ...event.payload, service_tier: "priority" }
  })
}

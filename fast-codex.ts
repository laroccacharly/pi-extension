import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { getAgentDir } from "@earendil-works/pi-coding-agent"
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"

interface FastMode {
  command: string
  provider: string
  settingKey: string
  label: string
  // Footer status while fast mode is on and the provider is selected.
  status: string
  // Shown after "fast mode on"; explains what turning it on costs or risks.
  onNote: string
}

interface FastModeState {
  mode: FastMode
  configPath: string
  enabled: boolean
}

const MODES: FastMode[] = [
  {
    command: "fast-codex",
    provider: "openai-codex",
    settingKey: "fastCodex",
    label: "Codex",
    status: "Codex fast: on",
    onNote: "priority service; higher usage charges",
  },
  {
    command: "fast-openrouter",
    provider: "openrouter",
    settingKey: "fastOpenRouter",
    label: "OpenRouter",
    status: "Fast",
    onNote:
      "priority tier; higher price; models or pinned providers without a priority endpoint run at the standard tier",
  },
]

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

function loadEnabled(configPath: string, settingKey: string): boolean {
  try {
    return loadSettings(configPath)[settingKey] === true
  } catch {
    return false
  }
}

function saveEnabled(
  configPath: string,
  settingKey: string,
  enabled: boolean
): void {
  mkdirSync(dirname(configPath), { recursive: true })
  const settings = { ...loadSettings(configPath), [settingKey]: enabled }
  // Write through settings symlinks rather than replacing the link itself.
  writeFileSync(configPath, `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600,
  })
}

function updateStatus(
  ctx: ExtensionContext,
  state: FastModeState,
  provider: string | undefined
): void {
  const { mode } = state
  ctx.ui.setStatus(
    mode.command,
    state.enabled && provider === mode.provider ? mode.status : undefined
  )
}

async function toggle(
  args: string,
  ctx: ExtensionCommandContext,
  state: FastModeState
): Promise<void> {
  const { mode } = state
  const arg = args.trim().toLowerCase()
  if (arg !== "" && arg !== "on" && arg !== "off") {
    ctx.ui.notify(`Usage: /${mode.command} [on|off]`, "warning")
    return
  }
  if (ctx.model?.provider !== mode.provider) {
    ctx.ui.notify(`/${mode.command} requires a ${mode.label} model`, "warning")
    return
  }

  await ctx.waitForIdle()
  const nextEnabled = arg === "" ? !state.enabled : arg === "on"
  try {
    saveEnabled(state.configPath, mode.settingKey, nextEnabled)
  } catch {
    ctx.ui.notify(`Could not save ${mode.label} fast mode`, "error")
    return
  }
  state.enabled = nextEnabled
  updateStatus(ctx, state, ctx.model.provider)
  ctx.ui.notify(
    state.enabled
      ? `${mode.label} fast mode on (${mode.onNote})`
      : `${mode.label} fast mode off`,
    "info"
  )
}

function registerFastMode(
  pi: ExtensionAPI,
  configPath: string,
  mode: FastMode
): void {
  const state: FastModeState = {
    mode,
    configPath,
    enabled: loadEnabled(configPath, mode.settingKey),
  }

  pi.registerCommand(mode.command, {
    description: `Toggle ${mode.label} priority service tier (on/off; higher charges)`,
    handler: async (args, ctx) => {
      await toggle(args, ctx, state)
    },
  })

  pi.on("session_start", (_event, ctx) => {
    state.enabled = loadEnabled(configPath, mode.settingKey)
    updateStatus(ctx, state, ctx.model?.provider)
  })

  pi.on("model_select", (event, ctx) => {
    updateStatus(ctx, state, event.model.provider)
  })

  pi.on("before_provider_request", (event, ctx) => {
    if (
      !state.enabled ||
      ctx.model?.provider !== mode.provider ||
      !isRecord(event.payload)
    ) {
      return
    }
    return { ...event.payload, service_tier: "priority" }
  })
}

export default function fastCodex(pi: ExtensionAPI): void {
  const configPath = join(getAgentDir(), "settings.json")
  for (const mode of MODES) {
    registerFastMode(pi, configPath, mode)
  }
}

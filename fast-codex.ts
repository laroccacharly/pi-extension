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

export default function fastCodex(pi: ExtensionAPI): void {
  let enabled = false

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
      enabled = mode === "" ? !enabled : mode === "on"
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
    enabled = false
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

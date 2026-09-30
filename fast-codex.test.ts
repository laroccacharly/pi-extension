import assert from "node:assert/strict"
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"

import fastCodex from "./fast-codex.ts"

let agentDir: string
let previousAgentDir: string | undefined

beforeEach(() => {
  previousAgentDir = process.env.PI_CODING_AGENT_DIR
  agentDir = mkdtempSync(join(tmpdir(), "fast-codex-test-"))
  process.env.PI_CODING_AGENT_DIR = agentDir
})

afterEach(() => {
  if (previousAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR
  } else {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir
  }
  rmSync(agentDir, { recursive: true, force: true })
})

interface MockContext {
  model: { provider: string }
  waitForIdle: () => Promise<void>
  ui: {
    notify: (message: string, level: string) => void
    setStatus: (key: string, value: string | undefined) => void
  }
}

interface MockEvent {
  payload?: unknown
  model?: { provider: string }
}

interface MockAPI {
  on: (
    name: string,
    handler: (event: MockEvent, ctx: MockContext) => unknown
  ) => void
  registerCommand: (
    name: string,
    command: { handler: (args: string, ctx: MockContext) => Promise<void> }
  ) => void
}

function setup(provider = "openai-codex") {
  const events = new Map<
    string,
    (event: MockEvent, ctx: MockContext) => unknown
  >()
  const commands = new Map<
    string,
    { handler: (args: string, ctx: MockContext) => Promise<void> }
  >()
  const notifications: { message: string; level: string }[] = []
  const statuses = new Map<string, string | undefined>()
  const ctx: MockContext = {
    model: { provider },
    waitForIdle: async () => {
      await Promise.resolve()
    },
    ui: {
      notify: (message, level) => {
        notifications.push({ message, level })
      },
      setStatus: (key, value) => {
        statuses.set(key, value)
      },
    },
  }
  // The fixture supplies only the API and context members used by this extension.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const register = fastCodex as unknown as (pi: MockAPI) => void
  register({
    on: (name, handler) => {
      events.set(name, handler)
    },
    registerCommand: (name, command) => {
      commands.set(name, command)
    },
  })
  const command = commands.get("fast-codex")
  const request = events.get("before_provider_request")
  const start = events.get("session_start")
  const select = events.get("model_select")
  assert.ok(command && request && start && select)
  return {
    notifications,
    statuses,
    command: async (args = "") => {
      await command.handler(args, ctx)
    },
    request: (payload: unknown) => request({ payload }, ctx),
    start: () => start({}, ctx),
    select: (nextProvider: string) => {
      ctx.model = { provider: nextProvider }
      select({ model: ctx.model }, ctx)
    },
  }
}

await test("defaults off and toggles priority without mutating the payload", async () => {
  const app = setup()
  const payload = { model: "gpt-5.5", input: [], service_tier: "default" }
  assert.equal(app.request(payload), undefined)
  await app.command()
  assert.deepEqual(app.request(payload), {
    ...payload,
    service_tier: "priority",
  })
  assert.equal(payload.service_tier, "default")
  assert.equal(app.statuses.get("fast-codex"), "Codex fast: on")
  await app.command()
  assert.equal(app.request(payload), undefined)
  assert.equal(app.statuses.get("fast-codex"), undefined)
})

await test("explicit on and off are idempotent", async () => {
  const app = setup()
  await app.command("on")
  await app.command(" ON ")
  assert.deepEqual(app.request({}), { service_tier: "priority" })
  await app.command("off")
  await app.command("off")
  assert.equal(app.request({}), undefined)
})

await test("invalid arguments do not change the mode", async () => {
  const app = setup()
  await app.command("on")
  await app.command("invalid")
  assert.equal(app.notifications.at(-1)?.level, "warning")
  assert.deepEqual(app.request({}), { service_tier: "priority" })
})

await test("only affects Codex, including after switching models", async () => {
  const app = setup()
  await app.command("on")
  for (const provider of ["openai", "openrouter", "anthropic"]) {
    app.select(provider)
    assert.equal(app.request({}), undefined)
    assert.equal(app.statuses.get("fast-codex"), undefined)
    await app.command("off")
    assert.equal(app.notifications.at(-1)?.level, "warning")
  }
  app.select("openai-codex")
  assert.deepEqual(app.request({}), { service_tier: "priority" })
  assert.equal(app.statuses.get("fast-codex"), "Codex fast: on")
})

await test("fast mode persists across new sessions and extension reloads", async () => {
  const app = setup()
  await app.command("on")
  app.start()
  assert.deepEqual(app.request({}), { service_tier: "priority" })
  assert.equal(app.statuses.get("fast-codex"), "Codex fast: on")

  const reloaded = setup()
  reloaded.start()
  assert.deepEqual(reloaded.request({}), { service_tier: "priority" })
  assert.equal(reloaded.statuses.get("fast-codex"), "Codex fast: on")
  await reloaded.command("off")

  const restarted = setup()
  restarted.start()
  assert.equal(restarted.request({}), undefined)
  assert.equal(restarted.statuses.get("fast-codex"), undefined)
})

await test("preserves other settings, including changes since startup", async () => {
  const path = join(agentDir, "settings.json")
  writeFileSync(path, JSON.stringify({ theme: "dark", fastCodex: true }))
  const app = setup()
  app.start()
  assert.deepEqual(app.request({}), { service_tier: "priority" })
  const settings = { theme: "light", compaction: { enabled: false } }
  writeFileSync(path, JSON.stringify(settings))
  await app.command("off")
  assert.deepEqual(JSON.parse(readFileSync(path, "utf-8")), {
    ...settings,
    fastCodex: false,
  })
})

await test("writes through symlinked settings without replacing the link", async () => {
  const target = join(agentDir, "managed-settings.json")
  const path = join(agentDir, "settings.json")
  const settings = { theme: "dark", packages: ["../../Work/pi-cursor-sdk"] }
  writeFileSync(target, JSON.stringify(settings))
  symlinkSync(target, path)
  const app = setup()

  for (const enabled of [true, false]) {
    await app.command(enabled ? "on" : "off")
    assert.equal(lstatSync(path).isSymbolicLink(), true)
    assert.equal(readlinkSync(path), target)
    assert.deepEqual(JSON.parse(readFileSync(target, "utf-8")), {
      ...settings,
      fastCodex: enabled,
    })
    assert.deepEqual(
      app.request({}),
      enabled ? { service_tier: "priority" } : undefined
    )
  }
})

await test("invalid settings default off and are not overwritten", async () => {
  const path = join(agentDir, "settings.json")
  for (const contents of ["invalid JSON", "null", "[]"]) {
    writeFileSync(path, contents)
    const app = setup()
    app.start()
    assert.equal(app.request({}), undefined)
    await app.command("on")
    assert.equal(app.request({}), undefined)
    assert.equal(app.notifications.at(-1)?.level, "error")
    assert.equal(readFileSync(path, "utf-8"), contents)
  }
})

await test("ignores non-object payloads", async () => {
  const app = setup()
  await app.command("on")
  for (const payload of [null, undefined, [], "payload", 42]) {
    assert.equal(app.request(payload), undefined)
  }
})

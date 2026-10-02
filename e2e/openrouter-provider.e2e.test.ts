import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, test } from "node:test"
import { fileURLToPath } from "node:url"

import { startOpenRouterStub } from "./openrouter-stub.ts"
import type { OpenRouterStub, StubScenario } from "./openrouter-stub.ts"

const PI_BIN = process.env.PI_BIN ?? "pi"
const EXTENSION_PATH = fileURLToPath(
  new URL("../openrouter-provider.ts", import.meta.url)
)
const STATUS_KEY = "openrouter-provider"
const RETRY_STATUS_KEY = "openrouter-retries"
const WAIT_TIMEOUT_MS = 15_000
const piAvailable = spawnSync(PI_BIN, ["--version"]).status === 0

interface PiEvent {
  type: string
  method?: string
  statusKey?: string
  statusText?: string
}

function isPiEvent(value: unknown): value is PiEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  )
}

interface EventLog {
  /** Every main footer status the extension set, in order. */
  statuses: () => string[]
  /** Every retry-count footer value, in order; `undefined` means cleared. */
  retryStatuses: () => (string | undefined)[]
  waitFor: (predicate: (event: PiEvent) => boolean) => Promise<PiEvent>
}

interface PiRun extends EventLog {
  stub: OpenRouterStub
  send: (command: Record<string, unknown>) => void
  waitForStatus: (pattern: RegExp) => Promise<string>
  /** Wait for the retry footer to show `text`, or to be cleared when omitted. */
  waitForRetryStatus: (text?: string) => Promise<void>
}

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

const isStatus = (event: PiEvent, key = STATUS_KEY): boolean =>
  event.method === "setStatus" && event.statusKey === key

/** Collect Pi's JSONL stdout and let tests wait for matching events. */
function createEventLog(
  child: ChildProcessWithoutNullStreams,
  stderr: () => string
): EventLog {
  const events: PiEvent[] = []
  const waiters = new Set<() => void>()
  const statuses = () =>
    events
      .filter((event) => isStatus(event))
      .map((event) => event.statusText ?? "")
  const retryStatuses = () =>
    events
      .filter((event) => isStatus(event, RETRY_STATUS_KEY))
      .map((event) => event.statusText)

  let buffer = ""
  child.stdout.setEncoding("utf-8")
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      const event: unknown = line.startsWith("{") ? JSON.parse(line) : undefined
      if (isPiEvent(event)) {
        events.push(event)
      }
    }
    for (const wake of waiters) {
      wake()
    }
  })

  const waitFor = async (predicate: (event: PiEvent) => boolean) =>
    await new Promise<PiEvent>((resolve, reject) => {
      let seen = 0
      const check = () => {
        for (; seen < events.length; seen += 1) {
          const event = events[seen]
          if (event !== undefined && predicate(event)) {
            waiters.delete(check)
            resolve(event)
            return
          }
        }
      }
      // Rejecting after a resolve is a no-op; unref keeps it from holding the process open.
      setTimeout(() => {
        reject(
          new Error(
            `timed out; statuses: ${JSON.stringify(statuses())}; stderr: ${stderr()}`
          )
        )
      }, WAIT_TIMEOUT_MS).unref()
      waiters.add(check)
      check()
    })

  return { statuses, retryStatuses, waitFor }
}

/** Write an isolated HOME whose Pi config routes `openrouter` to the stub. */
function createHome(stubUrl: string): { home: string; agentDir: string } {
  const home = mkdtempSync(join(tmpdir(), "openrouter-e2e-"))
  const agentDir = join(home, ".pi", "agent")
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        openrouter: {
          baseUrl: stubUrl,
          apiKey: "stub-key",
          models: [
            { id: "stub/model", name: "Stub Model", api: "openai-completions" },
          ],
        },
      },
    })
  )
  writeFileSync(join(home, "note.txt"), "stub file contents\n")
  return { home, agentDir }
}

/** Run a real `pi --mode rpc` with only this extension loaded. */
function spawnPi(
  stubUrl: string,
  home: string,
  agentDir: string
): ChildProcessWithoutNullStreams {
  const args = [
    "--mode",
    "rpc",
    "--no-session",
    "--no-extensions",
    "--extension",
    EXTENSION_PATH,
    "--provider",
    "openrouter",
    "--model",
    "stub/model",
    "--tools",
    "read",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-approve",
  ]
  return spawn(PI_BIN, args, {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      PI_OPENROUTER_API_URL: stubUrl,
      // 1% of the real delays: the full late-retry schedule takes about a second.
      PI_OPENROUTER_RETRY_DELAY_SCALE: "0.01",
    },
  })
}

async function startPi(scenario: StubScenario): Promise<PiRun> {
  const stub = await startOpenRouterStub(scenario)
  const { home, agentDir } = createHome(stub.url)
  const child = spawnPi(stub.url, home, agentDir)
  let stderr = ""
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  cleanups.push(async () => {
    child.kill()
    await stub.close()
    rmSync(home, { recursive: true, force: true })
  })

  const log = createEventLog(child, () => stderr)
  return {
    ...log,
    stub,
    send: (command) => {
      child.stdin.write(`${JSON.stringify(command)}\n`)
    },
    waitForStatus: async (pattern) => {
      const event = await log.waitFor(
        (candidate) =>
          isStatus(candidate) && pattern.test(candidate.statusText ?? "")
      )
      return event.statusText ?? ""
    },
    waitForRetryStatus: async (text) => {
      await log.waitFor(
        (candidate) =>
          isStatus(candidate, RETRY_STATUS_KEY) && candidate.statusText === text
      )
    },
  }
}

async function prompt(pi: PiRun, message: string): Promise<void> {
  pi.send({ type: "prompt", message })
  await pi.waitFor((event) => event.type === "agent_settled")
}

const generation = (cost: number, provider: string) => ({
  total_cost: cost,
  provider_name: provider,
  tokens_completion: 50,
  generation_time: 1000,
})

await test(
  "shows cost and provider once a lagging generation is indexed",
  { skip: !piAvailable && `${PI_BIN} not found` },
  async () => {
    const pi = await startPi({
      completions: [{ id: "gen-final", text: "hello" }],
      generations: {
        "gen-final": { notFoundFor: 2, data: generation(0.02, "StubProv") },
      },
    })
    await prompt(pi, "hi")

    assert.equal(pi.statuses().at(-1), "$0.0200, 50.0 t/s, StubProv")
    assert.equal(pi.stub.lookups.get("gen-final"), 3)
  }
)

await test(
  "counts a tool-call generation that is indexed after the turn settles",
  { skip: !piAvailable && `${PI_BIN} not found` },
  async () => {
    const pi = await startPi({
      completions: [
        {
          id: "gen-tool",
          toolCall: { name: "read", arguments: { path: "note.txt" } },
        },
        { id: "gen-final", text: "done" },
      ],
      generations: {
        // Past the six quick retries, so only the background poll finds it.
        "gen-tool": { notFoundFor: 8, data: generation(0.01, "OldProv") },
        "gen-final": { data: generation(0.02, "StubProv") },
      },
    })
    await prompt(pi, "read the note")

    assert.equal(pi.statuses().at(-1), "$0.0200, 50.0 t/s, StubProv, 1 priced")
    assert.equal(pi.retryStatuses().at(-1), "↻ 1 retrying")
    // The late tool-call cost joins the total; the latest turn keeps its provider.
    await pi.waitForStatus(/^\$0\.0300, 50\.0 t\/s, StubProv$/u)
    await pi.waitForRetryStatus()
  }
)

await test(
  "shows priced and unpriced counts when a tool-call lookup fails",
  { skip: !piAvailable && `${PI_BIN} not found` },
  async () => {
    const pi = await startPi({
      completions: [
        {
          id: "gen-tool",
          toolCall: { name: "read", arguments: { path: "note.txt" } },
        },
        { id: "gen-final", text: "done" },
      ],
      generations: {
        "gen-tool": { error: { status: 401, message: "Invalid API key" } },
        "gen-final": { data: generation(0.02, "StubProv") },
      },
    })
    await prompt(pi, "read the note")

    assert.equal(
      pi.statuses().at(-1),
      "$0.0200, 50.0 t/s, StubProv, 1 priced, 1 unpriced"
    )
  }
)

await test(
  "shows lookup attempts while waiting for the final generation",
  { skip: !piAvailable && `${PI_BIN} not found` },
  async () => {
    const pi = await startPi({
      completions: [{ id: "gen-final", text: "hello" }],
      generations: {
        "gen-final": { notFoundFor: 8, data: generation(0.02, "StubProv") },
      },
    })
    await prompt(pi, "hi")

    assert.equal(
      pi.statuses().at(-1),
      "waiting for generation stats… (attempt 6)"
    )
    await pi.waitForStatus(/\(attempt 8\)$/u)
    await pi.waitForStatus(/^\$0\.0200, 50\.0 t\/s, StubProv$/u)
  }
)

await test(
  "shows OpenRouter's error message when the generation lookup fails",
  { skip: !piAvailable && `${PI_BIN} not found` },
  async () => {
    const pi = await startPi({
      completions: [{ id: "gen-final", text: "hello" }],
      generations: {
        "gen-final": { error: { status: 401, message: "Invalid API key" } },
      },
    })
    await prompt(pi, "hi")

    assert.equal(
      pi.statuses().at(-1),
      "provider unavailable (HTTP 401: Invalid API key)"
    )
    // Permanent errors are not retried and never show as retrying.
    assert.equal(pi.stub.lookups.get("gen-final"), 1)
    assert.ok(pi.retryStatuses().every((text) => text === undefined))
  }
)

await test(
  "keeps retrying transient server errors and counts them in the footer",
  { skip: !piAvailable && `${PI_BIN} not found` },
  async () => {
    const pi = await startPi({
      completions: [{ id: "gen-final", text: "hello" }],
      generations: {
        // Past the six quick retries, so the background poll takes over.
        "gen-final": {
          error: { status: 503, message: "upstream overloaded" },
          errorFor: 8,
          data: generation(0.02, "StubProv"),
        },
      },
    })
    await prompt(pi, "hi")

    assert.equal(pi.retryStatuses().at(-1), "↻ 1 retrying")
    assert.equal(
      pi.statuses().at(-1),
      "waiting for generation stats… (attempt 6)"
    )
    await pi.waitForStatus(/^\$0\.0200, 50\.0 t\/s, StubProv$/u)
    await pi.waitForRetryStatus()
    assert.equal(pi.stub.lookups.get("gen-final"), 9)
  }
)

await test(
  "shows the request error when the completion itself fails",
  { skip: !piAvailable && `${PI_BIN} not found` },
  async () => {
    const pi = await startPi({ completions: [], generations: {} })
    pi.send({ type: "set_auto_retry", enabled: false })
    await prompt(pi, "hi")

    const status = pi.statuses().at(-1) ?? ""
    assert.match(status, /^provider unavailable \(.+\)$/u)
    assert.match(status, /stub has no completion left/u)
  }
)

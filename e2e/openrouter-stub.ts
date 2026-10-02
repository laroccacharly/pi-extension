import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"

/** One scripted assistant response from `POST /chat/completions`. */
export type StubCompletion =
  | { id: string; text: string }
  | { id: string; toolCall: { name: string; arguments: unknown } }

/** How `GET /generation?id=…` answers for one generation id. */
export interface StubGeneration {
  /** Answer 404 to this many lookups before returning the data, simulating indexing lag. */
  notFoundFor?: number
  /** Answer lookups with this HTTP error instead of the data. */
  error?: { status: number; message: string }
  /** Only the first this-many lookups get `error`; defaults to all of them. */
  errorFor?: number
  data?: Record<string, unknown>
}

export interface StubScenario {
  completions: StubCompletion[]
  generations: Record<string, StubGeneration>
}

export interface OpenRouterStub {
  /** Base URL to use as both Pi's provider `baseUrl` and `PI_OPENROUTER_API_URL`. */
  url: string
  /** Number of generation lookups received per id. */
  lookups: Map<string, number>
  close: () => Promise<void>
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

function completionChunks(completion: StubCompletion): unknown[] {
  const base = { id: completion.id, object: "chat.completion.chunk" }
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  if ("text" in completion) {
    return [
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: completion.text },
            finish_reason: null,
          },
        ],
      },
      {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage,
      },
    ]
  }
  return [
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call-${completion.id}`,
                type: "function",
                function: {
                  name: completion.toolCall.name,
                  arguments: JSON.stringify(completion.toolCall.arguments),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage,
    },
  ]
}

function streamCompletion(
  res: ServerResponse,
  completion: StubCompletion | undefined
): void {
  if (completion === undefined) {
    sendJson(res, 500, { error: { message: "stub has no completion left" } })
    return
  }
  res.writeHead(200, { "content-type": "text/event-stream" })
  for (const chunk of completionChunks(completion)) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  }
  res.end("data: [DONE]\n\n")
}

function answerGeneration(
  res: ServerResponse,
  generation: StubGeneration | undefined,
  lookup: number
): void {
  if (
    generation?.error !== undefined &&
    lookup <= (generation.errorFor ?? Number.POSITIVE_INFINITY)
  ) {
    sendJson(res, generation.error.status, {
      error: { message: generation.error.message },
    })
    return
  }
  if (
    generation?.data === undefined ||
    lookup <= (generation.notFoundFor ?? 0)
  ) {
    sendJson(res, 404, { error: { message: "Generation not found" } })
    return
  }
  sendJson(res, 200, { data: generation.data })
}

/** Start a local OpenRouter stand-in on a random port, scripted by `scenario`. */
export async function startOpenRouterStub(
  scenario: StubScenario
): Promise<OpenRouterStub> {
  const completions = [...scenario.completions]
  const lookups = new Map<string, number>()

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://stub")
    // Drain the body so the client never blocks on a full socket.
    req.resume()

    if (req.method === "POST" && url.pathname === "/chat/completions") {
      req.on("end", () => {
        streamCompletion(res, completions.shift())
      })
      return
    }
    if (url.pathname === "/generation") {
      const id = url.searchParams.get("id") ?? ""
      const lookup = (lookups.get(id) ?? 0) + 1
      lookups.set(id, lookup)
      answerGeneration(res, scenario.generations[id], lookup)
      return
    }
    if (url.pathname === "/models") {
      sendJson(res, 200, { data: [] })
      return
    }
    if (url.pathname.endsWith("/endpoints")) {
      sendJson(res, 200, { data: { endpoints: [] } })
      return
    }
    sendJson(res, 404, {
      error: { message: `stub has no route ${url.pathname}` },
    })
  })

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("stub server has no TCP address")
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    lookups,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    },
  }
}

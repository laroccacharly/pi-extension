import assert from "node:assert/strict"
import { test } from "node:test"

import redactSecretsExtension, {
  redactSecrets,
} from "../extensions/redact-secrets.ts"

// All keys below are invented for the tests; none of them are real.
const REDACTED = "[REDACTED]"

// Joined at runtime so secret scanners don't flag the fake keys in this file.
function fakeKey(prefix: string, body: string): string {
  return `${prefix}${body}`
}

const OPENROUTER_KEY = fakeKey(
  "sk-or-v1-",
  "9f3a1c7e5b2d8046af19c3e7d5b21048fe6a9c31b7d04582e1f8a6c3d975b204"
)
const ANTHROPIC_KEY = fakeKey(
  "sk-ant-api03-",
  "Qw7Zk2Lm9Xp4Rt8Vn6Yb3Hc1Jd5Gf0Sa2Pe"
)
const OPENAI_KEY = fakeKey(
  "sk-proj-",
  "Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78St90Uv12Wx34Yz56"
)
const GITHUB_KEY = fakeKey("ghp_", "3fA9bC2dE8fG1hJ4kL7mN0pQ5rS6tU9vW2xY")
const GITHUB_PAT = fakeKey(
  "github_pat_",
  "11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEF"
)
const AWS_KEY = fakeKey("AKIA", "2B7Q9X4L1M8P3R6T")
const SLACK_KEY = fakeKey(
  "xoxb-",
  "123456789012-123456789012-AbCdEfGhIjKlMnOpQrStUvWx"
)
const GOOGLE_KEY = fakeKey("AIza", "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7")
const GENERIC_KEY = "Qm4Tz9Kp2Lx7Rv5Nb8Wc3Yd6Fs1Gh0Jk5Mn2Rt7P"
const JWT_HEADER = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
const JWT_PAYLOAD = "eyJzdWIiOiIxMjM0NTY3ODkwIn0"
const JWT_SIGNATURE = "4f2a9c7e1b3d5068"

const KEY_CASES: { name: string; secret: string; text: string }[] = [
  { name: "OpenRouter", secret: OPENROUTER_KEY, text: OPENROUTER_KEY },
  { name: "Anthropic", secret: ANTHROPIC_KEY, text: ANTHROPIC_KEY },
  { name: "OpenAI", secret: OPENAI_KEY, text: OPENAI_KEY },
  { name: "GitHub token", secret: GITHUB_KEY, text: GITHUB_KEY },
  { name: "GitHub fine-grained PAT", secret: GITHUB_PAT, text: GITHUB_PAT },
  { name: "AWS access key", secret: AWS_KEY, text: AWS_KEY },
  { name: "Slack token", secret: SLACK_KEY, text: SLACK_KEY },
  { name: "Google API key", secret: GOOGLE_KEY, text: GOOGLE_KEY },
  { name: "generic mixed-case token", secret: GENERIC_KEY, text: GENERIC_KEY },
  {
    name: "URL query parameter",
    secret: OPENROUTER_KEY,
    text: `https://openrouter.ai/api/v1/models?api_key=${OPENROUTER_KEY}&limit=5`,
  },
  {
    name: "Authorization header",
    secret: GITHUB_KEY,
    text: `Authorization: Bearer ${GITHUB_KEY}`,
  },
  {
    name: "shell assignment",
    secret: OPENROUTER_KEY,
    text: `OPENROUTER_API_KEY="${OPENROUTER_KEY}"`,
  },
  {
    name: "JSON body",
    secret: OPENROUTER_KEY,
    text: `{"api_key":"${OPENROUTER_KEY}","model":"openai/gpt-4o"}`,
  },
]

for (const { name, secret, text } of KEY_CASES) {
  await test(`redacts a ${name}`, () => {
    assert.equal(redactSecrets(text), text.replace(secret, REDACTED))
  })
}

await test("redacts a JWT header and payload", () => {
  const jwt = `${JWT_HEADER}.${JWT_PAYLOAD}.${JWT_SIGNATURE}`
  assert.equal(redactSecrets(jwt), `${REDACTED}.${REDACTED}.${JWT_SIGNATURE}`)
})

await test("redacts only the token and preserves surrounding text", () => {
  assert.equal(
    redactSecrets(`token = ${GITHUB_KEY}; done`),
    "token = [REDACTED]; done"
  )
  assert.equal(
    redactSecrets(`line one\n${ANTHROPIC_KEY}\tline two`),
    `line one\n${REDACTED}\tline two`
  )
})

const UNCHANGED_TEXTS = [
  "The quick brown fox jumps over the lazy dog.",
  "getUserAccountSettingsForAdministratorPanel",
  "OPENROUTER_API_KEY",
  "openrouter-provider-extension-global-settings-file",
  "3f9a1c7e5b2d8046af19c3e7d5b21048fe6a9c31",
  "9f3a1c7e5b2d8046af19c3e7d5b21048fe6a9c31b7d04582e1f8a6c3d975b204",
  "123e4567-e89b-12d3-a456-426614174000",
  "https://github.com/laroccacharly/pi-extension/blob/main/fast-codex.ts",
  "someone@example.com, first.last+tag@mail.example.org",
  "/home/user/Work/pi-extension/redact-secrets.test.ts",
  "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts",
  "sk-learn",
  "base64EncodeUtf8String2024",
  "getUserAccountSettings2024ForAdminPanel",
  "handleOAuth2CallbackWithPKCEVerifierV3",
  "test_ShouldRedactKeysInJson_Case12",
  "useQueryClientV2WithSuspenseFallback",
  "sk-sidebar-component-wrapper",
  "AKIAPolicyDocumentForBucketAccess",
]

for (const text of UNCHANGED_TEXTS) {
  await test(`leaves ${JSON.stringify(text)} unchanged`, () => {
    assert.equal(redactSecrets(text), text)
  })
}

await test("leaves a long prose sentence unchanged", () => {
  const text =
    "Pull the latest changes from main, run the test suite, then review the diff before deploying to production."
  assert.equal(redactSecrets(text), text)
})

interface MockImage {
  data: string
  mimeType: string
  type: "image"
}

interface MockAPI {
  on: (name: string, handler: (event: unknown) => unknown) => void
}

function setup() {
  const handlers = new Map<string, (event: unknown) => unknown>()
  // The fixture supplies only the API member used by this extension.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const register = redactSecretsExtension as unknown as (pi: MockAPI) => void
  register({
    on: (name, handler) => {
      handlers.set(name, handler)
    },
  })
  const handler = (name: string) => {
    const next = handlers.get(name)
    assert.ok(next)
    return next
  }
  return { input: handler("input"), toolResult: handler("tool_result") }
}

const IMAGE: MockImage = {
  data: "aGVsbG8=",
  mimeType: "image/png",
  type: "image",
}

await test("redacts tool result text and structured content", () => {
  const { toolResult } = setup()
  const event = {
    content: [
      { text: `key: ${OPENROUTER_KEY}`, type: "text" },
      IMAGE,
      { text: "nothing to see", type: "text" },
    ],
    isError: false,
    structuredContent: {
      count: 3,
      nested: ["plain", { key: GITHUB_KEY }],
    },
    toolName: "read",
    type: "tool_result",
  }
  assert.deepEqual(toolResult(event), {
    content: [
      { text: "key: [REDACTED]", type: "text" },
      IMAGE,
      { text: "nothing to see", type: "text" },
    ],
    structuredContent: {
      count: 3,
      nested: ["plain", { key: "[REDACTED]" }],
    },
  })
})

await test("returns nothing when a tool result has no secret", () => {
  const { toolResult } = setup()
  const event = {
    content: [{ text: "nothing to see", type: "text" }],
    isError: false,
    toolName: "read",
    type: "tool_result",
  }
  assert.equal(toolResult(event), undefined)
})

await test("redacts tool result structured content alone", () => {
  const { toolResult } = setup()
  const event = {
    content: [{ text: "nothing to see", type: "text" }],
    isError: false,
    structuredContent: { key: ANTHROPIC_KEY },
    toolName: "read",
    type: "tool_result",
  }
  assert.deepEqual(toolResult(event), {
    content: [{ text: "nothing to see", type: "text" }],
    structuredContent: { key: "[REDACTED]" },
  })
})

await test("transforms input only when it contains a secret", () => {
  const { input } = setup()
  assert.deepEqual(input({ images: [IMAGE], text: `use ${GITHUB_KEY}` }), {
    action: "transform",
    images: [IMAGE],
    text: "use [REDACTED]",
  })
  assert.deepEqual(input({ text: "plain message" }), { action: "continue" })
})

await test("redacts tool result details and object keys", () => {
  const { toolResult } = setup()
  const event = {
    content: [{ text: "Successfully replaced text", type: "text" }],
    details: { diff: `-old\n+KEY=${OPENROUTER_KEY}`, firstChangedLine: 2 },
    isError: false,
    structuredContent: { [GITHUB_KEY]: true },
    toolName: "edit",
    type: "tool_result",
  }
  assert.deepEqual(toolResult(event), {
    content: [{ text: "Successfully replaced text", type: "text" }],
    details: { diff: "-old\n+KEY=[REDACTED]", firstChangedLine: 2 },
    structuredContent: { "[REDACTED]": true },
  })
})

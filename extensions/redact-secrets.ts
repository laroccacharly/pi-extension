import type {
  ExtensionAPI,
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent"

const REDACTED = "[REDACTED]"

// A token starting with one of these prefixes is a secret when the rest has a\n// digit, whatever its shape.
const SECRET_PREFIXES = [
  "sk-",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
  "github_pat_",
  "AKIA",
  "ASIA",
  "xoxb-",
  "xoxp-",
  "xoxa-",
  "AIza",
  "glpat-",
  "eyJ",
] as const

// Minimum characters after a known prefix.
const MIN_PREFIX_SUFFIX = 16
// Minimum token length for the generic heuristic.
const MIN_TOKEN_LENGTH = 32
// Minimum Shannon entropy, in bits per character, for the generic heuristic.
const MIN_ENTROPY = 4

// Above this share of characters inside camelCase words, a token reads as an
// identifier rather than a random key (about 1% of random keys score higher).
const MAX_WORD_SHARE = 0.6
// A capitalized or lowercase word of 3+ letters, or an acronym of 4+ capitals.
const WORD_PATTERN = /[A-Z]?[a-z]{3,}|[A-Z]{4,}(?![a-z])/gu

// Maximal runs of token characters; every other character is a delimiter.
const TOKEN_PATTERN = /[A-Za-z0-9_-]+/gu

function shannonEntropy(token: string): number {
  const counts = new Map<string, number>()
  for (const char of token) {
    counts.set(char, (counts.get(char) ?? 0) + 1)
  }
  let bits = 0
  for (const count of counts.values()) {
    const probability = count / token.length
    bits -= probability * Math.log2(probability)
  }
  return bits
}

function wordShare(token: string): number {
  let wordChars = 0
  for (const match of token.matchAll(WORD_PATTERN)) {
    wordChars += match[0].length
  }
  return wordChars / token.length
}

function isSecretToken(token: string): boolean {
  for (const prefix of SECRET_PREFIXES) {
    const suffix = token.slice(prefix.length)
    if (
      token.startsWith(prefix) &&
      suffix.length >= MIN_PREFIX_SUFFIX &&
      /[0-9]/u.test(suffix)
    ) {
      return true
    }
  }
  return (
    token.length >= MIN_TOKEN_LENGTH &&
    /[A-Z]/u.test(token) &&
    /[a-z]/u.test(token) &&
    /[0-9]/u.test(token) &&
    shannonEntropy(token) >= MIN_ENTROPY &&
    wordShare(token) < MAX_WORD_SHARE
  )
}

/**
 * Replaces anything that looks like an API key or secret with `[REDACTED]`.
 *
 * Tokens are maximal runs of `[A-Za-z0-9_-]`, so URLs, paths, and emails are
 * split into short pieces while a key inside a URL or header stays one token.
 */
export function redactSecrets(text: string): string {
  return text.replace(TOKEN_PATTERN, (token) =>
    isSecretToken(token) ? REDACTED : token
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

// Redacts every string and object key inside a value, keeping references to
// unchanged parts. Image blocks are skipped so their base64 data survives.
function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSecrets(value)
  }
  if (Array.isArray(value)) {
    const items = value.map(redactValue)
    return items.some((item, index) => item !== value[index]) ? items : value
  }
  if (!isPlainObject(value) || value.type === "image") {
    return value
  }
  let changed = false
  const entries = Object.entries(value).map(([key, item]) => {
    const redactedKey = redactSecrets(key)
    const redactedItem = redactValue(item)
    changed ||= redactedKey !== key || redactedItem !== item
    return [redactedKey, redactedItem] as const
  })
  return changed ? Object.fromEntries(entries) : value
}

// Redaction only replaces strings, so the value keeps its shape and type.
function redactDeep<T>(value: T): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return redactValue(value) as T
}

function redactToolResult(
  event: ToolResultEvent
): ToolResultEventResult | undefined {
  const content = redactDeep(event.content)
  const structuredContent = redactDeep(event.structuredContent)
  const details = redactDeep(event.details)
  if (
    content === event.content &&
    structuredContent === event.structuredContent &&
    details === event.details
  ) {
    return undefined
  }
  const result: ToolResultEventResult = { content }
  if (details !== undefined) {
    result.details = details
  }
  if (structuredContent !== undefined) {
    result.structuredContent = structuredContent
  }
  return result
}

export default function redactSecretsExtension(pi: ExtensionAPI): void {
  pi.on("tool_result", (event) => redactToolResult(event))

  pi.on("input", (event) => {
    const text = redactSecrets(event.text)
    return text === event.text
      ? { action: "continue" }
      : { action: "transform", images: event.images, text }
  })
}

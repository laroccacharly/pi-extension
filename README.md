# Pi OpenRouter Provider Extension

Pi extension that displays the OpenRouter upstream provider used for each response, the actual USD spend, and the generation speed reported by OpenRouter.

## Actual spend

Pi prices OpenRouter tokens from the static model catalog, which ignores OpenRouter's per-request cost (routing, time-of-day price overrides, fees). After each assistant response the extension fetches `GET /api/v1/generation?id=<responseId>` and reads the returned `total_cost`, `tokens_completion`, and `generation_time`. The footer status shows `OpenRouter: ($lastTurn), $sessionTotal, tokensPerSecond, providerName`, i.e. last response cost, cumulative session cost, the actual generation speed in tokens per second (`tokens_completion / (generation_time / 1000)`), and upstream provider. This is OpenRouter's authoritative billed cost, so it can differ from the estimate in Pi's built-in cost display. The totals reset when a new session starts.

The `/openrouter-providers` command lists the five healthy endpoints with the highest 30-minute p50 throughput. Selecting one persists a preferred provider order with fallbacks in `~/.pi/agent/openrouter-provider.json`. Selecting auto-route removes the saved override.

## Latest models from the live API

Pi resolves OpenRouter models from a static catalog, so brand-new and stealth releases (for example `stealth/union-alpha`) can be missing from `/model` until Pi ships an updated catalog. The extension bridges that gap by reading OpenRouter's live `GET /api/v1/models` catalog and merging any unknown chat models on top of Pi's built-in OpenRouter models.

- On every session start the extension registers cached live models immediately, then refreshes the catalog in the background (network only when the cache is older than 30 minutes). Newly released models then show up in `/model`.
- `/openrouter-models` fetches the catalog on demand, registers the merged model list, and shows the 10 most recently released models so you can pick one directly. Models that were not previously known are tagged `[new]`.
- Discovered models are cached in `~/.pi/agent/openrouter-models-cache.json` so the list survives restarts and offline sessions.

Live models are mapped from OpenRouter metadata (context length, max completion tokens, pricing, input modalities, and reasoning support) and default to the `openai-completions` API. Pi's built-in definitions are preserved as-is, so hand-tuned compatibility settings are not lost.

> Note: `pi --list-models` runs before a session starts, so it only shows the static catalog plus whatever was already cached. The models are fully available in `/model` and `/openrouter-models` during a session.

## Install globally

```bash
mkdir -p ~/.pi/agent/extensions
ln -sf ~/Work/pi-extension/openrouter-provider.ts ~/.pi/agent/extensions/openrouter-provider.ts
```

Run `/reload` in Pi after changing the extension.

## Development

```bash
npm install --ignore-scripts
npm run check
npm run format
```

Linting uses Oxlint with Ultracite's core rules. Formatting uses Oxfmt with Ultracite defaults.

## Known routing behavior

OpenRouter may rerank complex tool-enabled requests despite an explicit provider order. The extension sends the selected provider first with fallbacks enabled, but strict first-provider enforcement would require client-side retries using one provider per attempt.

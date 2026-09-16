# Pi OpenRouter Provider Extension

Pi extension that displays the OpenRouter upstream provider used for each response and the actual USD spend reported by OpenRouter.

## Actual spend

Pi prices OpenRouter tokens from the static model catalog, which ignores OpenRouter's per-request cost (routing, time-of-day price overrides, fees). After each assistant response the extension fetches `GET /api/v1/generation?id=<responseId>` and reads the returned `total_cost`. The footer status shows `OpenRouter: ($lastTurn), $sessionTotal, providerName`, i.e. last response cost, cumulative session cost, and upstream provider. This is OpenRouter's authoritative billed cost, so it can differ from the estimate in Pi's built-in cost display. The totals reset when a new session starts.

The `/openrouter-providers` command lists the five healthy endpoints with the highest 30-minute p50 throughput. Selecting one persists a preferred provider order with fallbacks in `~/.pi/agent/openrouter-provider.json`. Selecting auto-route removes the saved override.

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

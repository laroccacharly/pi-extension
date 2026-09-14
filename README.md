# Pi OpenRouter Provider Extension

Pi extension that displays the OpenRouter upstream provider used for each response.

The `/openrouter-providers` command lists the five healthy endpoints with the highest 30-minute p50 throughput. Selecting one persists a preferred provider order with fallbacks in `~/.pi/agent/openrouter-provider.json`. Selecting auto-route removes the saved override.

## Install globally

```bash
mkdir -p ~/.pi/agent/extensions
ln -sf ~/Work/pi-extension/openrouter-provider.ts ~/.pi/agent/extensions/openrouter-provider.ts
```

Run `/reload` in Pi after changing the extension.

## Known routing behavior

OpenRouter may rerank complex tool-enabled requests despite an explicit provider order. The extension sends the selected provider first with fallbacks enabled, but strict first-provider enforcement would require client-side retries using one provider per attempt.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface OpenRouterGenerationResponse {
	data?: {
		provider_name?: string;
	};
}

interface OpenRouterEndpoint {
	provider_name?: string;
	tag?: string;
	status?: number;
	latency_last_30m?: { p50?: number };
	throughput_last_30m?: { p50?: number };
	uptime_last_30m?: number;
}

interface OpenRouterEndpointsResponse {
	data?: {
		endpoints?: OpenRouterEndpoint[];
	};
}

const RETRY_DELAYS_MS = [0, 250, 750, 1_500, 3_000, 5_000] as const;
const CONFIG_PATH = join(homedir(), ".pi", "agent", "openrouter-provider.json");

function normalizeModelId(modelId: string): string {
	return modelId.replace(/:(?:nitro|floor|exacto)$/, "");
}

async function getOpenRouterHeaders(ctx: ExtensionContext): Promise<Headers> {
	const auth = await ctx.modelRegistry.getProviderAuth("openrouter");
	if (!auth) throw new Error("OpenRouter authentication is unavailable");

	const headers = new Headers();
	for (const [name, value] of Object.entries(auth.auth.headers ?? {})) {
		if (value !== null) headers.set(name, value);
	}
	if (auth.auth.apiKey && !headers.has("authorization")) {
		headers.set("authorization", `Bearer ${auth.auth.apiKey}`);
	}
	return headers;
}

function loadSelectedRoutes(): Map<string, string[]> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();

		const routes = new Map<string, string[]>();
		for (const [modelId, value] of Object.entries(parsed)) {
			if (!Array.isArray(value) || !value.every((tag) => typeof tag === "string")) continue;
			routes.set(modelId, value);
		}
		return routes;
	} catch {
		return new Map();
	}
}

function saveSelectedRoutes(routes: Map<string, string[]>): void {
	const temporaryPath = `${CONFIG_PATH}.${process.pid}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(Object.fromEntries(routes), null, 2)}\n`, { mode: 0o600 });
	renameSync(temporaryPath, CONFIG_PATH);
}

export default function (pi: ExtensionAPI) {
	const selectedRoutes = loadSelectedRoutes();

	pi.registerCommand("openrouter-providers", {
		description: "Choose among the five highest-throughput providers or use automatic routing",
		handler: async (_args, ctx) => {
			if (ctx.model?.provider !== "openrouter") {
				ctx.ui.notify("The current model is not using OpenRouter", "warning");
				return;
			}

			try {
				const modelId = normalizeModelId(ctx.model.id);
				const response = await fetch(`https://openrouter.ai/api/v1/models/${modelId}/endpoints`, {
					headers: await getOpenRouterHeaders(ctx),
				});
				if (!response.ok) throw new Error(`OpenRouter returned HTTP ${response.status}`);

				const result = (await response.json()) as OpenRouterEndpointsResponse;
				const endpoints = result.data?.endpoints ?? [];
				const healthyEndpoints = endpoints.filter(
					(endpoint) =>
						endpoint.status === 0 &&
						endpoint.tag !== undefined &&
						endpoint.throughput_last_30m?.p50 !== undefined,
				);
				const top = healthyEndpoints
					.toSorted((left, right) =>
						(right.throughput_last_30m?.p50 ?? 0) - (left.throughput_last_30m?.p50 ?? 0),
					)
					.slice(0, 5);

				if (top.length === 0) throw new Error("OpenRouter returned no healthy endpoints with throughput data");

				const providerOptions = top.map((endpoint, index) => {
					const throughput = endpoint.throughput_last_30m?.p50 ?? 0;
					const latency = endpoint.latency_last_30m?.p50;
					const uptime = endpoint.uptime_last_30m;
					return `${index + 1}. ${endpoint.provider_name ?? "Unknown"} — ${throughput} t/s · ${latency === undefined ? "n/a" : `${(latency / 1_000).toFixed(2)} s`} latency · ${uptime === undefined ? "n/a" : `${uptime.toFixed(2)}%`} uptime`;
				});
				const autoOption = "Auto-route by throughput";
				const selection = await ctx.ui.select(
					`OpenRouter providers for ${modelId} (30m p50)`,
					[autoOption, ...providerOptions],
				);
				if (!selection) return;

				if (selection === autoOption) {
					selectedRoutes.delete(modelId);
					saveSelectedRoutes(selectedRoutes);
					ctx.ui.setStatus("openrouter-provider", "OpenRouter: auto-routing by throughput");
					return;
				}

				const selectedIndex = providerOptions.indexOf(selection);
				const endpoint = top[selectedIndex];
				if (!endpoint?.tag) throw new Error("Selected provider is unavailable");

				const selectedProvider = endpoint.tag.split("/")[0];
				const routeOrder = [
					selectedProvider,
					...healthyEndpoints
						.toSorted((left, right) =>
							(right.throughput_last_30m?.p50 ?? 0) - (left.throughput_last_30m?.p50 ?? 0),
						)
						.map((candidate) => candidate.tag?.split("/")[0])
						.filter(
							(tag, index, tags): tag is string =>
								tag !== undefined && tag !== selectedProvider && tags.indexOf(tag) === index,
						),
				];
				selectedRoutes.set(modelId, routeOrder);
				saveSelectedRoutes(selectedRoutes);
				ctx.ui.setStatus("openrouter-provider", `OpenRouter: preferring ${endpoint.provider_name ?? endpoint.tag}`);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		const routeOrder = ctx.model?.provider === "openrouter" ? selectedRoutes.get(normalizeModelId(ctx.model.id)) : undefined;
		ctx.ui.setStatus(
			"openrouter-provider",
			routeOrder?.[0] ? `OpenRouter: preferring ${routeOrder[0]}` : undefined,
		);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== "openrouter") return;
		const routeOrder = selectedRoutes.get(normalizeModelId(ctx.model.id));
		if (!routeOrder || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return;

		const payload = event.payload as Record<string, unknown>;
		const provider =
			payload.provider && typeof payload.provider === "object" && !Array.isArray(payload.provider)
				? { ...(payload.provider as Record<string, unknown>) }
				: {};
		delete provider.only;
		provider.sort = "price";
		provider.order = routeOrder;
		provider.allow_fallbacks = true;
		return {
			...payload,
			model: `${normalizeModelId(ctx.model.id)}:floor`,
			provider,
		};
	});

	pi.on("before_provider_headers", (event, ctx) => {
		if (
			ctx.model?.provider === "openrouter" &&
			selectedRoutes.has(normalizeModelId(ctx.model.id))
		) {
			event.headers["x-session-id"] = null;
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const entry = ctx.sessionManager
			.getBranch()
			.findLast((candidate) => candidate.type === "message" && candidate.message.role === "assistant");
		if (!entry || entry.type !== "message" || entry.message.role !== "assistant") return;

		if (entry.message.provider !== "openrouter") {
			ctx.ui.setStatus("openrouter-provider", undefined);
			return;
		}

		const generationId = entry.message.responseId;
		if (!generationId) {
			ctx.ui.setStatus("openrouter-provider", "OpenRouter: provider unavailable");
			return;
		}

		ctx.ui.setStatus("openrouter-provider", "OpenRouter: resolving provider…");

		try {
			const url = new URL("https://openrouter.ai/api/v1/generation");
			url.searchParams.set("id", generationId);
			const headers = await getOpenRouterHeaders(ctx);

			for (const [index, delayMs] of RETRY_DELAYS_MS.entries()) {
				if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));

				const response = await fetch(url, { headers });
				if (response.status === 404 && index < RETRY_DELAYS_MS.length - 1) continue;
				if (!response.ok) throw new Error(`OpenRouter returned HTTP ${response.status}`);

				const result = (await response.json()) as OpenRouterGenerationResponse;
				const providerName = result.data?.provider_name;
				if (!providerName) throw new Error("OpenRouter did not return a provider name");

				ctx.ui.setStatus("openrouter-provider", `OpenRouter: ${providerName}`);
				return;
			}
		} catch {
			ctx.ui.setStatus("openrouter-provider", "OpenRouter: provider unavailable");
		}
	});
}

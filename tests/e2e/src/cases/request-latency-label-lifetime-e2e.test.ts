import { createHash } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  EtcdClient, ProxyClient, SeedClient, pickFreePort, spawnApp, startOpenAiUpstream,
  waitConfigPropagation, type OpenAiUpstream, type SpawnedApp,
} from "../harness/index.js";
import { scrapeMetrics, sumMetric } from "../harness/metrics.js";

const KEY = "sk-latency-lifetime";
const E2E = "aisix_request_e2e_latency_seconds";
const TTFT = "aisix_request_ttft_seconds";
const contexts = [
  { endpoint: "chat/completions", provider: "openai", adapter: "openai" },
  { endpoint: "messages", provider: "anthropic", adapter: "anthropic" },
  { endpoint: "messages", provider: "deepseek", adapter: "openai" },
  { endpoint: "responses", provider: "openai", adapter: "openai" },
  { endpoint: "responses", provider: "deepseek", adapter: "openai" },
  { endpoint: "chat/completions", provider: "ensemble", adapter: "openai" },
];

describe("request latency labels survive buffering and configuration reloads", () => {
  let reachable = false;
  const apps: SpawnedApp[] = [];
  const upstreams: OpenAiUpstream[] = [];
  const servers: Server[] = [];
  beforeAll(async () => { reachable = await new EtcdClient().ping(); });
  afterAll(async () => {
    await Promise.all(apps.map((app) => app.exit()));
    await Promise.all(upstreams.map((upstream) => upstream.close()));
    await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolve());
    })));
  });

  async function setup() {
    const app = await spawnApp({ extraEnv: {
      AISIX_OBSERVABILITY__METRICS__LABELS: JSON.stringify({
        ...Object.fromEntries([E2E, TTFT].map((metric) => [metric,
          ["endpoint", "model", "upstream_model", "status_class", "streaming", "api_key_id", "team_id", "user_id", "user_name"],
        ])),
      }),
    } });
    apps.push(app);
    return { app, seed: new SeedClient(new EtcdClient(), app.etcdPrefix) };
  }

  async function authorize(app: SpawnedApp, seed: SeedClient, models: string[]) {
    const apiKey = await seed.createApiKey({
      team_id: "original-team", user_id: "original-user", user_name: "Original User",
      key_hash: createHash("sha256").update(KEY).digest("hex"), allowed_models: models,
    });
    const client = new ProxyClient(app.proxyUrl, KEY);
    await waitConfigPropagation(async () => (await client.listModels()).status === 200);
    return { client, apiKey };
  }

  function request(app: SpawnedApp, endpoint: string, model: string) {
    return fetch(`${app.proxyUrl}/v1/${endpoint}`, {
      method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model, stream: true, max_tokens: 100,
        ...(endpoint === "responses" ? { input: "hello" } : { messages: [{ role: "user", content: "hello" }] }),
      }),
    });
  }

  test("buffered Responses keep streaming=true for both allowed and blocked output", async (ctx) => {
    if (!reachable) return ctx.skip();
    const { app, seed } = await setup();
    await seed.createGuardrail({ name: "block-secret", kind: "keyword", enabled: true,
      hook_point: "output", enforcement_mode: "block", patterns: [{ kind: "literal", value: "SECRET" }],
    });
    for (const [model, text] of [["buffer-allowed", "hello"], ["buffer-blocked", "SECRET"]]) {
      const response = { id: "resp-buffer", model, status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      };
      const upstream = await startOpenAiUpstream({ streamEvents: [
        JSON.stringify({ type: "response.created", response: { ...response, status: "in_progress", output: [] } }),
        JSON.stringify({ type: "response.output_text.delta", delta: text }),
        JSON.stringify({ type: "response.completed", response }),
      ] });
      upstreams.push(upstream);
      const pk = await seed.createProviderKey({ display_name: model, provider: "openai",
        adapter: "openai", api_key: "test", api_base: `${upstream.baseUrl}/v1`,
      });
      await seed.createModel({ display_name: model, model_name: model, provider: "openai", provider_key_id: pk.id });
    }
    await authorize(app, seed, ["buffer-allowed", "buffer-blocked"]);
    for (const [model, status] of [["buffer-allowed", 200], ["buffer-blocked", 422]] as const) {
      const response = await request(app, "responses", model);
      const body = await response.text();
      expect(response.status, body).toBe(status);
      const samples = await scrapeMetrics(app.metricsUrl);
      // Both sides: the blocked response still came from a dispatched
      // attempt, so it has an upstream duration to observe.
      for (const side of ["downstream", "upstream"]) {
        expect(sumMetric(samples, `${E2E}_count`, { model, streaming: "true", side }), side).toBe(1);
      }
      expect(sumMetric(samples, `${E2E}_count`, { model, streaming: "false" })).toBe(0);
    }
  });

});

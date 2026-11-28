import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  EtcdClient,
  ProxyClient,
  SeedClient,
  spawnApp,
  startMockSls,
  waitConfigPropagation,
  waitForSlsLog,
  type MockSls,
  type SpawnedApp,
} from "../harness/index.js";

// E2E: a streamed /v1/chat/completions request with the OpenAI SDK's
// `stream_options: {include_usage: true}`, sent to an OpenAI-compatible
// upstream that reports usage on its finish chunk rather than on a chunk
// of its own.
//
// `stream_options` is forwarded to the upstream as the caller sent it.
//
// `include_usage` itself is a promise about the response the caller reads:
// one extra chunk, after the finish chunk, whose `choices` is empty and which
// alone carries `usage`.
//
// Without `include_usage` no chunk carries usage at all, while the usage
// event still records what the upstream reported.

const CALLER = "sk-chat-bridge-include-usage";
const CALLER_HASH = createHash("sha256").update(CALLER).digest("hex");
const CREDENTIAL_REF = "e2e";
const LOGSTORE = "chat-bridge-include-usage-store";

const MODELS = {
  openaiCompat: "include-usage-openai-compat",
} as const;

// Usage on the finish chunk, and no usage-only chunk, even when asked.
function openAiCompatStream(): string {
  return [
    { id: "cmpl-compat", object: "chat.completion.chunk", model: "mistral-small", choices: [{ index: 0, delta: { role: "assistant", content: "Paris." }, finish_reason: null }] },
    {
      id: "cmpl-compat",
      object: "chat.completion.chunk",
      model: "mistral-small",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 21, completion_tokens: 5, total_tokens: 26 },
    },
  ]
    .map((f) => `data: ${JSON.stringify(f)}\n\n`)
    .join("") + "data: [DONE]\n\n";
}

interface Received {
  path: string;
  body: Record<string, unknown>;
}

function startUpstream(received: Received[]): Server {
  return createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const path = req.url ?? "";
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      received.push({ path, body });
      if (path.startsWith("/oai/")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(openAiCompatStream());
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(openAiCompatStream());
    });
  });
}

function parseChatSse(raw: string): Array<Record<string, any>> {
  return raw
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)));
}

describe("chat streaming with stream_options.include_usage on bridged upstreams", () => {
  let app: SpawnedApp | undefined;
  let upstream: Server | undefined;
  let sls: MockSls | undefined;
  const received: Received[] = [];
  let etcdReachable = false;

  beforeAll(async () => {
    const etcd = new EtcdClient();
    etcdReachable = await etcd.ping();
    if (!etcdReachable) return;

    upstream = startUpstream(received);
    await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
    const addr = upstream.address();
    if (addr === null || typeof addr === "string") throw new Error("no port");
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    sls = await startMockSls();
    app = await spawnApp({
      extraEnv: {
        [`SLS_CRED_${CREDENTIAL_REF.toUpperCase()}_AK_ID`]: "mock-ak-id",
        [`SLS_CRED_${CREDENTIAL_REF.toUpperCase()}_AK_SECRET`]: "mock-ak-secret",
      },
    });
    const seed = new SeedClient(etcd, app.etcdPrefix);
    await seed.createObservabilityExporter({
      name: "chat-bridge-include-usage-sls",
      enabled: true,
      kind: "aliyun_sls",
      endpoint: sls.url,
      project: "chat-bridge-include-usage-proj",
      logstore: LOGSTORE,
      credential_ref: CREDENTIAL_REF,
    });
    const compatPk = await seed.createProviderKey({
      display_name: "include-usage-openai-compat-pk",
      api_key: "sk-compat-mock",
      api_base: `${baseUrl}/oai`,
    });
    await seed.createModel({
      display_name: MODELS.openaiCompat,
      provider: "openai",
      model_name: "mistral-small",
      provider_key_id: compatPk.id,
    });
    // Seeded last: this key authenticating implies the whole seed set landed.
    await seed.createApiKey({ key_hash: CALLER_HASH, allowed_models: Object.values(MODELS) });
    const probe = new ProxyClient(app.proxyUrl, CALLER);
    await waitConfigPropagation(async () => (await probe.listModels()).status === 200);
  });

  afterAll(async () => {
    await app?.exit();
    await sls?.close();
    await new Promise<void>((resolve) => (upstream ? upstream.close(() => resolve()) : resolve()));
  });

  async function streamChat(model: string, extra: Record<string, unknown>) {
    const res = await fetch(`${app!.proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${CALLER}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [{ role: "user", content: "What is the capital of France?" }],
        ...extra,
      }),
    });
    const raw = await res.text();
    const requestId = res.headers.get("x-aisix-request-id") ?? "";
    return { status: res.status, raw, requestId, chunks: res.status === 200 ? parseChatSse(raw) : [] };
  }

  for (const [label, model] of Object.entries(MODELS)) {
    test(`${label}: include_usage ends the stream with one usage-only chunk after the finish chunk`, async (ctx) => {
      if (!etcdReachable || !app) return ctx.skip();
      const before = received.length;
      const out = await streamChat(model, { stream_options: { include_usage: true } });
      expect(out.status, out.raw).toBe(200);

      const sent = received.slice(before);
      expect(sent).toHaveLength(1);
      if (label === "openaiCompat") {
        // Its own parameter: forwarded as the caller sent it.
        expect(sent[0]!.body.stream_options).toEqual({ include_usage: true });
      } else {
        // The upstream never saw the OpenAI parameter.
        expect(sent[0]!.body).not.toHaveProperty("stream_options");
      }

      const content = out.chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("");
      expect(content).toBe("Paris.");

      const withUsage = out.chunks.filter((c) => c.usage != null);
      expect(withUsage, out.raw).toHaveLength(1);
      const last = out.chunks.at(-1)!;
      expect(last.choices, out.raw).toEqual([]);
      expect(last.usage).toMatchObject({ prompt_tokens: 21, completion_tokens: 5, total_tokens: 26 });

      const finishes = out.chunks.filter((c) => c.choices?.[0]?.finish_reason != null);
      expect(finishes).toHaveLength(1);
      expect(finishes[0]!.choices[0].finish_reason).toBe("stop");
      expect(finishes[0]!.usage ?? null).toBeNull();
      expect(out.chunks.indexOf(finishes[0]!)).toBe(out.chunks.length - 2);
    });
    test(`${label}: without include_usage no chunk carries usage, and the usage event still has it`, async (ctx) => {
      if (!etcdReachable || !app) return ctx.skip();
      for (const extra of [{}, { stream_options: { include_usage: false } }]) {
        const out = await streamChat(model, extra);
        expect(out.status, out.raw).toBe(200);
        expect(out.chunks.every((c) => (c.choices ?? []).length === 1), out.raw).toBe(true);
        const content = out.chunks.map((c) => c.choices[0].delta?.content ?? "").join("");
        expect(content).toBe("Paris.");
        const finish = out.chunks.find((c) => c.choices[0].finish_reason != null)!;
        expect(finish.choices[0].finish_reason).toBe("stop");
        expect(out.raw, out.raw).not.toContain('"usage"');

        const row = await waitForSlsLog(
          sls!,
          LOGSTORE,
          (l) => l.get("request_id") === out.requestId,
          `usage row for ${out.requestId}`,
          15_000,
        );
        expect(row.get("prompt_tokens"), JSON.stringify([...row])).toBe("21");
        expect(row.get("completion_tokens"), JSON.stringify([...row])).toBe("5");
      }
    });
  }
});

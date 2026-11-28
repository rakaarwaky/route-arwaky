import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  EtcdClient,
  ProxyClient,
  SeedClient,
  spawnApp,
  startOpenAiUpstream,
  waitConfigPropagation,
  type OpenAiUpstream,
  type SpawnedApp,
} from "../harness/index.js";

// E2E: a model's chain-of-thought reaches the caller across the response
// shapes (AISIX-Cloud#1784): a reasoning upstream's `reasoning_content` and
// `reasoning_text` arrive as reasoning summary items on `/v1/responses` and
// as `reasoning_content` ahead of the text on `/v1/chat/completions`, in
// both buffered and streamed form.

const CALLER = "sk-thinking-cross-protocol";
const CALLER_HASH = createHash("sha256").update(CALLER).digest("hex");

const REASONING_A = "The user wants a greeting. ";
const REASONING_B = "Keep it short.";
const ANSWER = "Hello!";

function chatCompletion(message: Record<string, unknown>, finish: string) {
  return {
    id: "chatcmpl-think",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "deepseek-v4-pro",
    choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }],
    usage: { prompt_tokens: 12, completion_tokens: 20, total_tokens: 32 },
  };
}

function chatChunk(delta: Record<string, unknown>, finish: string | null = null) {
  return JSON.stringify({
    id: "chatcmpl-think-s",
    object: "chat.completion.chunk",
    model: "deepseek-v4-pro",
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
}

function chatReasoningStream(field: "reasoning_content" | "reasoning_text") {
  return [
    chatChunk({ [field]: REASONING_A }),
    chatChunk({ [field]: REASONING_B }),
    chatChunk({ content: ANSWER }),
    chatChunk({}, "stop"),
    JSON.stringify({
      id: "chatcmpl-think-s",
      object: "chat.completion.chunk",
      model: "deepseek-v4-pro",
      choices: [],
      usage: { prompt_tokens: 12, completion_tokens: 20, total_tokens: 32 },
    }),
    "[DONE]",
  ];
}

interface SseEvent {
  event: string;
  data: Record<string, any>;
}

function parseNamedSse(raw: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const frame of raw.split("\n\n")) {
    const lines = frame.split("\n");
    const event = lines.find((l) => l.startsWith("event: "))?.slice(7);
    const data = lines.find((l) => l.startsWith("data: "))?.slice(6);
    if (!event || !data) continue;
    events.push({ event, data: JSON.parse(data) });
  }
  return events;
}

function parseChatSse(raw: string): Array<Record<string, any>> {
  return raw
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)));
}

describe("thinking ↔ reasoning_content across protocols (AISIX-Cloud#1784)", () => {
  let app: SpawnedApp | undefined;
  const upstreams: Record<string, OpenAiUpstream> = {};
  let etcdReachable = false;

  const MODELS = {
    oaiText: "think-oai-text",
    oaiTool: "think-oai-tool",
    oaiStream: "think-oai-stream",
    oaiReasoningText: "think-oai-reasoning-text",
    oaiReasoningTextStream: "think-oai-reasoning-text-stream",
  } as const;
  const chatReasoningRequest = {
    model: MODELS.oaiReasoningText,
    messages: [{ role: "user", content: "say hi" }],
  };

  beforeAll(async () => {
    const etcd = new EtcdClient();
    etcdReachable = await etcd.ping();
    if (!etcdReachable) return;

    upstreams.oaiText = await startOpenAiUpstream({
      nonStreamBody: chatCompletion(
        { content: ANSWER, reasoning_content: REASONING_A + REASONING_B },
        "stop",
      ),
    });
    upstreams.oaiTool = await startOpenAiUpstream({
      nonStreamBody: chatCompletion(
        {
          content: null,
          reasoning_content: REASONING_A,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_time", arguments: '{"tz":"UTC"}' },
            },
          ],
        },
        "tool_calls",
      ),
    });
    upstreams.oaiStream = await startOpenAiUpstream({
      streamEvents: chatReasoningStream("reasoning_content"),
    });
    upstreams.oaiReasoningText = await startOpenAiUpstream({
      nonStreamBody: chatCompletion(
        { content: ANSWER, reasoning_text: REASONING_A + REASONING_B },
        "stop",
      ),
    });
    upstreams.oaiReasoningTextStream = await startOpenAiUpstream({
      streamEvents: chatReasoningStream("reasoning_text"),
    });

    app = await spawnApp();
    const seed = new SeedClient(etcd, app.etcdPrefix);
    for (const key of ["oaiText", "oaiTool", "oaiStream", "oaiReasoningText", "oaiReasoningTextStream"] as const) {
      const pk = await seed.createProviderKey({
        display_name: `${MODELS[key]}-pk`,
        api_key: "sk-mock",
        api_base: `${upstreams[key]!.baseUrl}/v1`,
        apis: {},
      });
      await seed.createModel({
        display_name: MODELS[key],
        provider: "openai",
        model_name: "deepseek-v4-pro",
        provider_key_id: pk.id,
      });
    }
    // Seeded last: the key authenticating implies the whole set is live.
    await seed.createApiKey({ key_hash: CALLER_HASH, allowed_models: Object.values(MODELS) });
  });

  afterAll(async () => {
    await app?.exit();
    for (const u of Object.values(upstreams)) await u.close();
  });

  async function ready(): Promise<void> {
    const probe = new ProxyClient(app!.proxyUrl, CALLER);
    await waitConfigPropagation(async () => {
      const res = await probe.listModels();
      if (res.status !== 200) return false;
      const data = (res.body as { data?: Array<{ id?: string }> }).data ?? [];
      return Object.values(MODELS).every((m) => data.some((e) => e.id === m));
    });
  }

  function post(path: string, body: unknown): Promise<Response> {
    return fetch(`${app!.proxyUrl}${path}`, {
      method: "POST",
      headers: { "x-api-key": CALLER, authorization: `Bearer ${CALLER}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("/v1/responses streaming: reasoning_text becomes reasoning summary deltas before output text", async (ctx) => {
    if (!etcdReachable || !app) return ctx.skip();
    await ready();
    const res = await post("/v1/responses", {
      model: MODELS.oaiReasoningTextStream,
      input: "say hi",
      stream: true,
    });
    expect(res.status).toBe(200);
    const deltas = parseNamedSse(await res.text())
      .filter(({ event }) => event === "response.reasoning_summary_text.delta" || event === "response.output_text.delta")
      .map(({ event, data }) => [event, data.delta]);
    expect(deltas).toEqual([
      ["response.reasoning_summary_text.delta", REASONING_A],
      ["response.reasoning_summary_text.delta", REASONING_B],
      ["response.output_text.delta", ANSWER],
    ]);
    expect(upstreams.oaiReasoningTextStream.receivedRequests.at(-1)?.path).toBe("/v1/chat/completions");
  });

  test("/v1/responses non-streaming: reasoning_text becomes a leading reasoning item", async (ctx) => {
    if (!etcdReachable || !app) return ctx.skip();
    await ready();
    const res = await post("/v1/responses", { model: MODELS.oaiReasoningText, input: "say hi" });
    expect(res.status).toBe(200);
    expect((await res.json()).output).toMatchObject([
      { type: "reasoning", summary: [{ type: "summary_text", text: REASONING_A + REASONING_B }] },
      { type: "message", content: [{ type: "output_text", text: ANSWER }] },
    ]);
  });

  test("/v1/chat/completions non-streaming: reasoning_text and reasoning_content are returned", async (ctx) => {
    if (!etcdReachable || !app) return ctx.skip();
    await ready();
    const res = await post("/v1/chat/completions", chatReasoningRequest);
    expect(res.status).toBe(200);
    expect((await res.json()).choices[0].message).toMatchObject({
      content: ANSWER,
      reasoning_text: REASONING_A + REASONING_B,
      reasoning_content: REASONING_A + REASONING_B,
    });
  });

  test("/v1/chat/completions streaming: reasoning_text and reasoning_content precede output text", async (ctx) => {
    if (!etcdReachable || !app) return ctx.skip();
    await ready();
    const res = await post("/v1/chat/completions", {
      ...chatReasoningRequest,
      model: MODELS.oaiReasoningTextStream,
      stream: true,
    });
    expect(res.status).toBe(200);
    const deltas = parseChatSse(await res.text()).map((chunk) => chunk.choices[0]?.delta);
    expect(deltas.slice(0, 3)).toMatchObject([
      { reasoning_text: REASONING_A, reasoning_content: REASONING_A },
      { reasoning_text: REASONING_B, reasoning_content: REASONING_B },
      { content: ANSWER },
    ]);
  });




});

// A Claude Code tool loop whose first turn came from an OpenAI-compatible
// reasoning upstream (unsigned thinking) and an earlier turn from Claude
// itself (signed thinking + redacted thinking).
const MIXED_HISTORY = [
  { role: "user", content: "first" },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Signed by Claude.", signature: "SIGNED_SIG" },
      { type: "redacted_thinking", data: "REDACTED_CIPHERTEXT" },
      { type: "text", text: "a1" },
    ],
  },
  { role: "user", content: "second" },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "UNSIGNED_REASONING", signature: "" },
      { type: "tool_use", id: "call_0", name: "get_time", input: {} },
    ],
  },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "call_0", content: "12:00" }] },
  {
    role: "assistant",
    content: [{ type: "thinking", thinking: "THINKING_ONLY_TURN", signature: "" }],
  },
  { role: "user", content: "third" },
];

function sentMessages(upstream: OpenAiUpstream, baseline: number): Array<Record<string, any>> {
  const sent = upstream.receivedRequests.slice(baseline).find((r) => r.method === "POST");
  expect(sent, "upstream received the request").toBeDefined();
  return (JSON.parse(sent!.body) as { messages: Array<Record<string, any>> }).messages;
}



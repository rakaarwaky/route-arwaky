import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocket as WsClient, WebSocketServer, type WebSocket as WsSocket } from "ws";
import {
  awaitWindowHeadroom,
  EtcdClient,
  SeedClient,
  spawnApp,
  startMockSls,
  startOpenAiUpstream,
  waitConfigPropagation,
  waitForLogLine,
  waitForSlsLog,
  type MockSls,
  type OpenAiUpstream,
  type SpawnedApp,
} from "../harness/index.js";

// E2E: a request the gateway refuses itself files a terminal usage event
// whose `error_message` names the failure with the access log's text — on
// every endpoint, through one shared helper.
//
// Before, those events carried `error_class` alone, so the control plane's
// usage log and the OTLP span showed a semantic router's failed decision,
// an unknown model or a guardrail block with no reason at all.

const CALLER = "sk-gateway-error-message-caller";
const LIMITED = "sk-gateway-error-message-limited";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

/** One field of an access-log line, as the text formatter writes it. */
function field(line: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}=("(?:[^"\\\\]|\\\\.)*"|\\S+)`).exec(line);
  if (!m) return undefined;
  return m[1].startsWith('"') ? (JSON.parse(m[1]) as string) : m[1];
}

const SLS_PROJECT = "gem-project";
const LOGSTORE = "gem-logstore";
const CREDENTIAL_REF = "gem";
const FORBIDDEN = "gemforbiddenword";

const chatChunk = (delta: Record<string, unknown>, finish: string | null = null) =>
  JSON.stringify({
    id: "chatcmpl-gem-stream",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-4o-mini",
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
// A streamed answer the output guardrail refuses once it has read it all.
const LEAKY_STREAM = [
  chatChunk({ role: "assistant" }),
  chatChunk({ content: "here is " }),
  chatChunk({ content: FORBIDDEN }),
  chatChunk({}, "stop"),
  "[DONE]",
];
/** A realtime upstream that answers every client frame with `response.done`. */
async function startRealtimeUpstream(): Promise<{ port: number; close(): Promise<void> }> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  wss.on("connection", (socket: WsSocket) => {
    socket.on("message", () => {
      socket.send(JSON.stringify({ type: "response.done", response: { usage: {} } }));
    });
  });
  await new Promise<void>((resolve) => wss.on("listening", resolve));
  const addr = wss.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  return {
    port: addr.port,
    close: () =>
      new Promise<void>((resolve, reject) => wss.close((e) => (e ? reject(e) : resolve()))),
  };
}

const STREAM_REFUSAL = "response blocked by content policy (guardrail 'gem-output-block')";

describe("gateway-side failures name themselves on the usage event", () => {
  let app: SpawnedApp | undefined;
  let sls: MockSls | undefined;
  let upstream: OpenAiUpstream | undefined;
  let leaky: OpenAiUpstream | undefined;
  let leakyResponses: OpenAiUpstream | undefined;
  let leakyStream: OpenAiUpstream | undefined;
  let leakyCompletions: OpenAiUpstream | undefined;
  let leakyTranscript: OpenAiUpstream | undefined;
  let realtime: { port: number; close(): Promise<void> } | undefined;
  let etcdReachable = false;

  beforeAll(async () => {
    const etcd = new EtcdClient();
    etcdReachable = await etcd.ping();
    if (!etcdReachable) return;

    sls = await startMockSls();
    upstream = await startOpenAiUpstream();
    // Answers every route with text the output guardrail refuses.
    leaky = await startOpenAiUpstream({
      nonStreamBody: {
        id: "chatcmpl-leaky",
        object: "chat.completion",
        created: 1,
        model: "gpt-4o-mini",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: `here is ${FORBIDDEN}` },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
      },
    });

    leakyResponses = await startOpenAiUpstream({
      nonStreamBody: {
        id: "resp_leaky",
        object: "response",
        status: "completed",
        model: "gpt-4o-mini",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: `here is ${FORBIDDEN}` }],
          },
        ],
        usage: { input_tokens: 3, output_tokens: 3, total_tokens: 6 },
      },
    });

    leakyStream = await startOpenAiUpstream({ streamEvents: LEAKY_STREAM });
    leakyCompletions = await startOpenAiUpstream({
      nonStreamBody: {
        id: "cmpl-leaky",
        object: "text_completion",
        created: 1,
        model: "gpt-3.5-turbo-instruct",
        choices: [{ index: 0, text: `here is ${FORBIDDEN}`, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
      },
    });
    leakyTranscript = await startOpenAiUpstream({
      nonStreamBody: { text: `here is ${FORBIDDEN}` },
    });
    realtime = await startRealtimeUpstream();

    app = await spawnApp({
      logLevel: "info",
      extraEnv: {
        [`SLS_CRED_${CREDENTIAL_REF.toUpperCase()}_AK_ID`]: "LTAI_mock_ak",
        [`SLS_CRED_${CREDENTIAL_REF.toUpperCase()}_AK_SECRET`]: "mock_ak_secret",
      },
    });
    const seed = new SeedClient(etcd, app.etcdPrefix);

    await seed.createObservabilityExporter({
      name: "gem-sls",
      enabled: true,
      kind: "aliyun_sls",
      endpoint: sls.url,
      project: SLS_PROJECT,
      logstore: LOGSTORE,
      credential_ref: CREDENTIAL_REF,
    });

    const pk = await seed.createProviderKey({
      display_name: "gem-pk",
      api_key: "sk-mock",
      api_base: `${upstream.baseUrl}/v1`,
    });
    await seed.createModel({
      display_name: "gem-chat",
      provider: "openai",
      model_name: "gpt-4o-mini",
      provider_key_id: pk.id,
    });

    const leakyPk = await seed.createProviderKey({
      display_name: "gem-leaky-pk",
      api_key: "sk-mock",
      api_base: `${leaky.baseUrl}/v1`,
    });
    const leakyModel = await seed.createModel({
      display_name: "gem-leaky",
      provider: "openai",
      model_name: "gpt-4o-mini",
      provider_key_id: leakyPk.id,
    });

    // A semantic router whose embedding provider is unreachable, under a
    // `fail` policy.
    const embedPk = await seed.createProviderKey({
      display_name: "gem-embedding-pk",
      api_key: "sk-mock",
      api_base: "http://127.0.0.1:9/v1",
    });
    await seed.createModel({
      display_name: "gem-embed",
      provider: "openai",
      model_name: "text-embedding-3-small",
      provider_key_id: embedPk.id,
      embedding: { dimensions: 4, normalize: true },
    });
    await seed.createModel({
      display_name: "gem-semantic",
      semantic: {
        embedding_model: "gem-embed",
        routes: [
          { name: "code", target: "gem-chat", examples: ["programming questions"] },
        ],
        default: "gem-chat",
        match: { threshold: 0.9 },
        on_embedding_failure: "fail",
      },
    });

    await seed.createGuardrail({
      name: "gem-input-block",
      enabled: true,
      hook_point: "input",
      kind: "keyword",
      patterns: [{ kind: "literal", value: FORBIDDEN }],
    });
    const outputGuard = await seed.createGuardrail(
      {
        name: "gem-output-block",
        enabled: true,
        hook_point: "output",
        kind: "keyword",
        patterns: [{ kind: "literal", value: FORBIDDEN }],
      },
      { attach: false },
    );
    await seed.attachGuardrailToModel(outputGuard.id, leakyModel.id);
    const leakyResponsesPk = await seed.createProviderKey({
      display_name: "gem-leaky-responses-pk",
      api_key: "sk-mock",
      api_base: `${leakyResponses.baseUrl}/v1`,
    });
    const leakyResponsesModel = await seed.createModel({
      display_name: "gem-leaky-responses",
      provider: "openai",
      model_name: "gpt-4o-mini",
      provider_key_id: leakyResponsesPk.id,
    });
    await seed.attachGuardrailToModel(outputGuard.id, leakyResponsesModel.id);

    // Streamed answers, refused after the `200` head: through the chat
    // stream, the /v1/messages translation, the /v1/responses bridge (a
    // provider with no native Responses API) and a passthrough route.
    const leakyStreamPk = await seed.createProviderKey({
      display_name: "gem-leaky-stream-pk",
      api_key: "sk-mock",
      api_base: `${leakyStream.baseUrl}/v1`,
    });
    const leakyStreamModel = await seed.createModel({
      display_name: "gem-leaky-stream",
      provider: "openai",
      model_name: "gpt-4o-mini",
      provider_key_id: leakyStreamPk.id,
    });
    await seed.attachGuardrailToModel(outputGuard.id, leakyStreamModel.id);
    // Buffered output refusals the gateway answers as a 422 "success".
    for (const [name, upstreamUrl, upstreamModel] of [
      ["gem-leaky-completions", leakyCompletions.baseUrl, "gpt-3.5-turbo-instruct"],
      ["gem-leaky-transcript", leakyTranscript.baseUrl, "whisper-1"],
    ] as const) {
      const leakyPk = await seed.createProviderKey({
        display_name: `${name}-pk`,
        api_key: "sk-mock",
        api_base: `${upstreamUrl}/v1`,
      });
      const m = await seed.createModel({
        display_name: name,
        provider: "openai",
        model_name: upstreamModel,
        provider_key_id: leakyPk.id,
      });
      await seed.attachGuardrailToModel(outputGuard.id, m.id);
    }

    const bridgedPk = await seed.createProviderKey({
      display_name: "gem-leaky-bridged-pk",
      api_key: "sk-mock",
      api_base: `${leakyStream.baseUrl}/v1`,
      provider: "deepseek",
      adapter: "openai",
    });
    const bridgedModel = await seed.createModel({
      display_name: "gem-leaky-bridged",
      provider: "deepseek",
      model_name: "deepseek-chat",
      provider_key_id: bridgedPk.id,
    });
    await seed.attachGuardrailToModel(outputGuard.id, bridgedModel.id);
    const streamRoute = await seed.createPassthroughRoute({
      name: "gem-stream-route",
      path_prefix: "/gem-stream-route",
      target_url: `${leakyStream.baseUrl}/v1`,
      provider_key_id: leakyStreamPk.id,
    });
    await seed.update("guardrail_attachments", randomUUID(), {
      guardrail_id: outputGuard.id,
      scope_type: "passthrough_route",
      scope_id: streamRoute.id,
      priority: 100,
    });

    const realtimePk = await seed.createProviderKey({
      display_name: "gem-realtime-pk",
      api_key: "sk-mock",
      api_base: `http://127.0.0.1:${realtime.port}/v1`,
    });
    await seed.createModel({
      display_name: "gem-realtime",
      provider: "openai",
      model_name: "gpt-realtime-mock",
      provider_key_id: realtimePk.id,
    });

    await seed.createPassthroughRoute({
      name: "gem-route",
      path_prefix: "/gem-route",
      target_url: `${upstream.baseUrl}/v1`,
      provider_key_id: pk.id,
    });

    await seed.createApiKey({
      key_hash: hash(LIMITED),
      allowed_models: ["*"],
      rate_limit: { rpm: 1 },
    });
    // Written last: its authenticating implies every row above has landed.
    await seed.createApiKey({
      key_hash: hash(CALLER),
      allowed_models: ["*"],
      allowed_routes: ["gem-stream-route"],
    });
    await waitConfigPropagation(async () => {
      const res = await fetch(`${app!.proxyUrl}/v1/models`, {
        headers: { authorization: `Bearer ${CALLER}` },
      });
      await res.text();
      return res.status === 200;
    });
  });

  afterAll(async () => {
    await app?.exit();
    await upstream?.close();
    await leaky?.close();
    await leakyResponses?.close();
    await leakyStream?.close();
    await leakyCompletions?.close();
    await leakyTranscript?.close();
    await realtime?.close();
    await sls?.close();
  });

  const ready = () => etcdReachable && !!app && !!sls;

  async function send(
    path: string,
    init: { body?: unknown; form?: FormData; method?: string; key?: string } = {},
  ): Promise<{ status: number; requestId: string }> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${init.key ?? CALLER}`,
    };
    let body: BodyInit | undefined;
    if (init.form) {
      body = init.form;
    } else if (init.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.body);
    }
    const res = await fetch(`${app!.proxyUrl}${path}`, {
      method: init.method ?? "POST",
      headers,
      body,
    });
    await res.text();
    return { status: res.status, requestId: res.headers.get("x-aisix-request-id") ?? "" };
  }

  /**
   * The terminal usage event the request filed — checked against the
   * request's access-log line, which must name the same failure: the class
   * as `error_class`, and the event's message, where it carries one, as
   * `error`.
   */
  async function eventFor(requestId: string, what: string): Promise<Map<string, string>> {
    expect(requestId, `${what}: no x-aisix-request-id`).not.toBe("");
    const event = await waitForSlsLog(
      sls!,
      LOGSTORE,
      (l) => l.get("request_id") === requestId,
      what,
    );
    const line = await waitForLogLine(
      app!,
      (l) => l.includes("proxy request completed") && l.includes(`"${requestId}"`),
      `${what}: access-log line`,
    );
    expect(field(line, "error_class"), `${what}: ${line}`).toBe(event.get("error_class"));
    const message = event.get("error_message");
    if (message !== undefined) {
      expect(field(line, "error"), `${what}: ${line}`).toBe(message);
    }
    return event;
  }

  async function expectNamed(
    r: { status: number; requestId: string },
    what: string,
    want: { status: number; errorClass: string; message: string },
  ) {
    expect(r.status, what).toBe(want.status);
    const event = await eventFor(r.requestId, what);
    expect(event.get("error_class"), what).toBe(want.errorClass);
    expect(event.get("error_message"), what).toBe(want.message);
    return event;
  }

  const notFound = (model: string) => ({
    status: 404,
    errorClass: "model_not_found",
    message: `model "${model}" not found`,
  });

  test("chat: semantic decision failure, unknown model, rate limit, input and output guardrail blocks", async (ctx) => {
    if (!ready()) return ctx.skip();
    const chat = (model: string, content = "hello", key?: string) =>
      send("/v1/chat/completions", {
        body: { model, messages: [{ role: "user", content }] },
        key,
      });

    await expectNamed(await chat("gem-semantic", "fix my python"), "semantic", {
      status: 503,
      errorClass: "semantic_decision_failed",
      message: "semantic router 'gem-semantic' could not pick a route (embedding_upstream)",
    });

    await expectNamed(await chat("gem-ghost-chat"), "unknown model", notFound("gem-ghost-chat"));

    await awaitWindowHeadroom();
    expect((await chat("gem-chat", "hello", LIMITED)).status).toBe(200);
    const limited = await chat("gem-chat", "hello", LIMITED);
    expect(limited.status).toBe(429);
    const limitedEvent = await eventFor(limited.requestId, "rate limit");
    expect(limitedEvent.get("error_class")).toBe("rate_limit_exceeded");
    expect(limitedEvent.get("error_message")).toMatch(/limit exceeded/);

    const inputBlock = await chat("gem-chat", `say ${FORBIDDEN}`);
    expect(inputBlock.status).toBe(422);
    const inputEvent = await eventFor(inputBlock.requestId, "input block");
    expect(inputEvent.get("error_class")).toBe("content_filter");
    expect(inputEvent.get("error_message")).toContain("gem-input-block");
    expect(inputEvent.get("error_message")).not.toContain(FORBIDDEN);

    const outputBlock = await chat("gem-leaky");
    expect(outputBlock.status).toBe(422);
    const outputEvent = await eventFor(outputBlock.requestId, "output block");
    expect(outputEvent.get("error_class")).toBe("content_filter");
    expect(outputEvent.get("error_message")).toContain("gem-output-block");
    expect(outputEvent.get("error_message")).not.toContain(FORBIDDEN);
  });


  test("a failure that can quote the request names itself too", async (ctx) => {
    if (!ready()) return ctx.skip();
    // A semantic router cannot serve embeddings: the refusal is an
    // `invalid_request_error`.
    const r = await send("/v1/embeddings", { body: { model: "gem-semantic", input: "hi" } });
    expect(r.status).toBe(400);
    const event = await eventFor(r.requestId, "invalid request");
    expect(event.get("error_class")).toBe("invalid_request_error");
    expect(event.get("error_message")).toBeTruthy();
  });
  const streamed: Array<[string, string, Record<string, unknown>]> = [
    [
      "/v1/chat/completions",
      "chat stream",
      { model: "gem-leaky-stream", stream: true, messages: [{ role: "user", content: "hi" }] },
    ],
    
    [
      "/v1/responses",
      "bridged responses stream",
      { model: "gem-leaky-bridged", stream: true, input: "hi" },
    ],
    [
      "/gem-stream-route/chat/completions",
      "passthrough stream",
      { model: "gpt-4o-mini", stream: true, messages: [{ role: "user", content: "hi" }] },
    ],
  ];
  for (const [path, what, body] of streamed) {
    test(`a guardrail refusal after the 200 head names itself: ${what}`, async (ctx) => {
      if (!ready()) return ctx.skip();
      const r = await send(path, { body });
      const event = await eventFor(r.requestId, what);
      expect(event.get("guardrail_blocked")).toBe("true");
      expect(event.get("error_class")).toBe("content_filter");
      expect(event.get("error_message")).toBe(STREAM_REFUSAL);
    });
  }

  test("a guardrail refusal that ends a /v1/realtime session names itself", async (ctx) => {
    if (!ready()) return ctx.skip();
    const ws = new WsClient(
      `${app!.proxyUrl.replace("http://", "ws://")}/v1/realtime?model=gem-realtime`,
      { headers: { authorization: `Bearer ${CALLER}` } },
    );
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
    ws.send(JSON.stringify({ type: "session.update", session: { instructions: `say ${FORBIDDEN}` } }));
    await closed;
    const event = await waitForSlsLog(
      sls!,
      LOGSTORE,
      (l) => l.get("requested_model") === "gem-realtime" && l.get("guardrail_blocked") === "true",
      "realtime refusal",
    );
    expect(event.get("error_class")).toBe("content_filter");
    expect(event.get("error_message")).toBe(
      "request blocked by content policy (guardrail 'gem-input-block')",
    );
  });
  test("completions and transcriptions name a buffered output refusal", async (ctx) => {
    if (!ready()) return ctx.skip();
    const completion = await send("/v1/completions", {
      body: { model: "gem-leaky-completions", prompt: "hi" },
    });
    expect(completion.status).toBe(422);
    const completionEvent = await eventFor(completion.requestId, "completions output block");
    expect(completionEvent.get("error_class")).toBe("content_filter");
    expect(completionEvent.get("error_message")).toContain("gem-output-block");

    const audio = new FormData();
    audio.set("model", "gem-leaky-transcript");
    audio.set("file", new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }), "a.wav");
    const transcript = await send("/v1/audio/transcriptions", { form: audio });
    expect(transcript.status).toBe(422);
    const transcriptEvent = await eventFor(transcript.requestId, "transcription output block");
    expect(transcriptEvent.get("error_class")).toBe("content_filter");
    expect(transcriptEvent.get("error_message")).toContain("gem-output-block");
  });
});

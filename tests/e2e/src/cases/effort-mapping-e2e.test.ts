import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
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

const execFileP = promisify(execFile);

// The three ways a request sets no reasoning effort at all. Every one of
// them takes the mapping's `""` entry.
const NO_EFFORT_CARRIERS: Record<string, unknown>[] = [
  {},
  { reasoning_effort: null },
  { reasoning_effort: "" },
];

const API_KEY = "sk-effort-mapping";
const KEY_HASH = createHash("sha256").update(API_KEY).digest("hex");

const chatResponse = {
  id: "chatcmpl-effort-map",
  object: "chat.completion",
  created: 1,
  model: "upstream-model",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "ok" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
};

const anthropicResponse = {
  id: "msg_effort_map",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "ok" }],
  model: "upstream-model",
  stop_reason: "end_turn",
  usage: { input_tokens: 2, output_tokens: 1 },
};

const openaiStreamEvents = [
  JSON.stringify({
    id: "chatcmpl-effort-stream",
    object: "chat.completion.chunk",
    model: "upstream-model",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "ok" },
        finish_reason: null,
      },
    ],
  }),
  JSON.stringify({
    id: "chatcmpl-effort-stream",
    object: "chat.completion.chunk",
    model: "upstream-model",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  }),
  "[DONE]",
];

const anthropicStreamEvents = [
  JSON.stringify({
    type: "message_start",
    message: {
      id: "msg_effort_stream",
      role: "assistant",
      content: [],
      model: "upstream-model",
      stop_reason: null,
      usage: { input_tokens: 2, output_tokens: 1 },
    },
  }),
  JSON.stringify({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  }),
  JSON.stringify({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "ok" },
  }),
  JSON.stringify({ type: "content_block_stop", index: 0 }),
  JSON.stringify({
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 1 },
  }),
  JSON.stringify({ type: "message_stop" }),
];

describe("direct-model effort mapping", () => {
  let app: SpawnedApp | undefined;
  let openai: OpenAiUpstream | undefined;
  let anthropic: OpenAiUpstream | undefined;
  let openaiStream: OpenAiUpstream | undefined;
  let anthropicStream: OpenAiUpstream | undefined;
  let ensembleStream: OpenAiUpstream | undefined;
  let tokensOpenai: OpenAiUpstream | undefined;
  let tokensAnthropic: OpenAiUpstream | undefined;
  let tokensCount: OpenAiUpstream | undefined;
  let etcdReachable = false;

  beforeAll(async () => {
    const etcd = new EtcdClient();
    etcdReachable = await etcd.ping();
    if (!etcdReachable) return;

    openai = await startOpenAiUpstream({ nonStreamBody: chatResponse });
    anthropic = await startOpenAiUpstream({
      scriptedResponses: [
        { nonStreamBody: anthropicResponse },
        { nonStreamBody: anthropicResponse },
        { nonStreamBody: anthropicResponse },
        { nonStreamBody: { input_tokens: 3 } },
      ],
    });
    openaiStream = await startOpenAiUpstream({
      streamEvents: openaiStreamEvents,
    });
    anthropicStream = await startOpenAiUpstream({
      streamEvents: anthropicStreamEvents,
    });
    ensembleStream = await startOpenAiUpstream({
      scriptedResponses: [
        { nonStreamBody: chatResponse },
        { streamEvents: openaiStreamEvents },
      ],
    });
    // The reserved-token models get upstreams of their own: the ones above
    // answer from a fixed script, so an extra request would run off its end.
    tokensOpenai = await startOpenAiUpstream({ nonStreamBody: chatResponse });
    tokensAnthropic = await startOpenAiUpstream({
      nonStreamBody: anthropicResponse,
    });
    tokensCount = await startOpenAiUpstream({
      nonStreamBody: { input_tokens: 3 },
    });
    app = await spawnApp();
    const seed = new SeedClient(etcd, app.etcdPrefix);

    const openaiKey = await seed.createProviderKey({
      display_name: "effort-map-openai-key",
      api_key: "sk-openai-mock",
      api_base: `${openai.baseUrl}/v1`,
    });
    const anthropicKey = await seed.createProviderKey({
      display_name: "effort-map-anthropic-key",
      provider: "anthropic",
      adapter: "anthropic",
      api_key: "sk-anthropic-mock",
      api_base: anthropic.baseUrl,
    });
    const openaiStreamKey = await seed.createProviderKey({
      display_name: "effort-map-openai-stream-key",
      api_key: "sk-openai-stream-mock",
      api_base: `${openaiStream.baseUrl}/v1`,
    });
    const anthropicStreamKey = await seed.createProviderKey({
      display_name: "effort-map-anthropic-stream-key",
      provider: "anthropic",
      adapter: "anthropic",
      api_key: "sk-anthropic-stream-mock",
      api_base: anthropicStream.baseUrl,
    });
    const ensembleStreamKey = await seed.createProviderKey({
      display_name: "effort-map-ensemble-stream-key",
      api_key: "sk-ensemble-stream-mock",
      api_base: `${ensembleStream.baseUrl}/v1`,
    });
    const tokensOpenaiKey = await seed.createProviderKey({
      display_name: "effort-map-tokens-openai-key",
      api_key: "sk-tokens-openai-mock",
      api_base: `${tokensOpenai.baseUrl}/v1`,
    });
    const tokensAnthropicKey = await seed.createProviderKey({
      display_name: "effort-map-tokens-anthropic-key",
      provider: "anthropic",
      adapter: "anthropic",
      api_key: "sk-tokens-anthropic-mock",
      api_base: tokensAnthropic.baseUrl,
    });
    const tokensCountKey = await seed.createProviderKey({
      display_name: "effort-map-tokens-count-key",
      provider: "anthropic",
      adapter: "anthropic",
      api_key: "sk-tokens-count-mock",
      api_base: tokensCount.baseUrl,
    });

    const mapping = { medium: "high", high: "max" };
    await seed.createModel({
      display_name: "effort-map-openai",
      provider: "openai",
      model_name: "glm-openai-wire",
      provider_key_id: openaiKey.id,
      effort_mapping: mapping,
    });
    await seed.createModel({
      display_name: "effort-map-openai-stream",
      provider: "openai",
      model_name: "glm-openai-stream-wire",
      provider_key_id: openaiStreamKey.id,
      effort_mapping: mapping,
    });
    await seed.createModel({
      display_name: "effort-map-anthropic-stream",
      provider: "anthropic",
      model_name: "glm-anthropic-stream-wire",
      provider_key_id: anthropicStreamKey.id,
      effort_mapping: mapping,
    });
    await seed.createModel({
      display_name: "effort-map-anthropic",
      provider: "anthropic",
      model_name: "glm-anthropic-wire",
      provider_key_id: anthropicKey.id,
      effort_mapping: mapping,
    });
    await seed.createModel({
      display_name: "effort-map-ensemble-panel",
      provider: "openai",
      model_name: "glm-ensemble-panel-wire",
      provider_key_id: openaiKey.id,
      effort_mapping: mapping,
    });
    await seed.createModel({
      display_name: "effort-map-ensemble-judge",
      provider: "openai",
      model_name: "glm-ensemble-judge-wire",
      provider_key_id: openaiKey.id,
      effort_mapping: { medium: "max" },
    });
    await seed.createModel({
      display_name: "effort-map-ensemble",
      ensemble: {
        panel: [{ model: "effort-map-ensemble-panel" }],
        judge: { model: "effort-map-ensemble-judge" },
        min_responses: 1,
      },
    });
    await seed.createModel({
      display_name: "effort-map-ensemble-stream-panel",
      provider: "openai",
      model_name: "glm-ensemble-stream-panel-wire",
      provider_key_id: ensembleStreamKey.id,
      effort_mapping: mapping,
    });
    await seed.createModel({
      display_name: "effort-map-ensemble-stream-judge",
      provider: "openai",
      model_name: "glm-ensemble-stream-judge-wire",
      provider_key_id: ensembleStreamKey.id,
      effort_mapping: { medium: "max" },
    });
    await seed.createModel({
      display_name: "effort-map-ensemble-stream",
      ensemble: {
        panel: [{ model: "effort-map-ensemble-stream-panel" }],
        judge: { model: "effort-map-ensemble-stream-judge" },
        min_responses: 1,
      },
    });
    // One map carrying all three reserved entries: add `high` when the
    // request sets no effort, drop the field for `medium`, and catch every
    // other value with `*`.
    const tokens = { "": "high", medium: null, "*": "low" };
    await seed.createModel({
      display_name: "effort-tokens-openai",
      provider: "openai",
      model_name: "glm-tokens-openai-wire",
      provider_key_id: tokensOpenaiKey.id,
      effort_mapping: tokens,
    });
    await seed.createModel({
      display_name: "effort-tokens-star",
      provider: "openai",
      model_name: "glm-tokens-star-wire",
      provider_key_id: tokensOpenaiKey.id,
      effort_mapping: { "*": "low" },
    });
    await seed.createModel({
      display_name: "effort-tokens-anthropic",
      provider: "anthropic",
      model_name: "glm-tokens-anthropic-wire",
      provider_key_id: tokensAnthropicKey.id,
      effort_mapping: tokens,
    });
    await seed.createModel({
      display_name: "effort-tokens-count",
      provider: "anthropic",
      model_name: "glm-tokens-count-wire",
      provider_key_id: tokensCountKey.id,
      effort_mapping: tokens,
    });
    // An ensemble whose judge carries the not-set entry: `judge_request`
    // copies the caller's effort only when there is one, so a caller that
    // sets none leaves the judge request for the `""` entry to fill.
    await seed.createModel({
      display_name: "effort-tokens-strip",
      provider: "openai",
      model_name: "glm-tokens-strip-wire",
      provider_key_id: tokensOpenaiKey.id,
      effort_mapping: { "*": null, medium: "high" },
    });
    // Claude Code sends `thinking` on every request and states an effort
    // only when its user picked one, so these models exercise a request
    // whose only reasoning control is the block. Each maps the not-set
    // entry to a tier the bridge would never derive from `thinking` on
    // its own, so the assertion fails if the injection stops happening.
    await seed.createModel({
      display_name: "effort-thinking-low",
      provider: "openai",
      model_name: "glm-thinking-low-wire",
      provider_key_id: tokensOpenaiKey.id,
      effort_mapping: { "": "low" },
    });
    await seed.createModel({
      display_name: "effort-thinking-minimal",
      provider: "openai",
      model_name: "glm-thinking-minimal-wire",
      provider_key_id: tokensOpenaiKey.id,
      effort_mapping: { "": "minimal" },
    });
    await seed.createModel({
      display_name: "effort-thinking-drop-exact",
      provider: "openai",
      model_name: "glm-thinking-drop-exact-wire",
      provider_key_id: tokensOpenaiKey.id,
      effort_mapping: { high: null },
    });
    await seed.createModel({
      display_name: "effort-thinking-drop-star",
      provider: "openai",
      model_name: "glm-thinking-drop-star-wire",
      provider_key_id: tokensOpenaiKey.id,
      effort_mapping: { "*": null },
    });
    // Every kind of write one map can perform, so the `disabled` cells
    // can show each of them being skipped: the not-set entry, an exact
    // rewrite, a wildcard rewrite — and a removal, which still applies.
    await seed.createModel({
      display_name: "effort-thinking-disabled",
      provider: "anthropic",
      model_name: "glm-thinking-disabled-wire",
      provider_key_id: tokensAnthropicKey.id,
      effort_mapping: { "": "low", medium: "max", "*": "xhigh", low: null },
    });
    await seed.createModel({
      display_name: "effort-thinking-passthrough",
      provider: "anthropic",
      model_name: "glm-thinking-passthrough-wire",
      provider_key_id: tokensAnthropicKey.id,
      effort_mapping: { "": "low", high: null },
    });
    await seed.createModel({
      display_name: "effort-tokens-panel",
      provider: "openai",
      model_name: "glm-tokens-panel-wire",
      provider_key_id: tokensOpenaiKey.id,
    });
    await seed.createModel({
      display_name: "effort-tokens-judge",
      provider: "openai",
      model_name: "glm-tokens-judge-wire",
      provider_key_id: tokensOpenaiKey.id,
      effort_mapping: { "": "high" },
    });
    await seed.createModel({
      display_name: "effort-tokens-ensemble",
      ensemble: {
        panel: [{ model: "effort-tokens-panel" }],
        judge: { model: "effort-tokens-judge" },
        min_responses: 1,
      },
    });
    await seed.createModel({
      display_name: "effort-map-group",
      routing: {
        strategy: "failover",
        targets: [{ model: "effort-map-openai" }],
      },
    });

    // The caller key is seeded last, so successful authentication implies
    // every model and provider key above has reached the snapshot.
    await seed.createApiKey({
      key_hash: KEY_HASH,
      allowed_models: [
        "effort-map-openai",
        "effort-map-anthropic",
        "effort-map-openai-stream",
        "effort-map-anthropic-stream",
        "effort-map-ensemble",
        "effort-map-ensemble-stream",
        "effort-map-group",
        "effort-tokens-openai",
        "effort-tokens-star",
        "effort-tokens-anthropic",
        "effort-tokens-count",
        "effort-tokens-ensemble",
        "effort-tokens-strip",
        "effort-thinking-low",
        "effort-thinking-minimal",
        "effort-thinking-drop-exact",
        "effort-thinking-drop-star",
        "effort-thinking-passthrough",
        "effort-thinking-disabled",
      ],
    });
    const proxy = new ProxyClient(app.proxyUrl, API_KEY);
    await waitConfigPropagation(
      async () => (await proxy.listModels()).status === 200,
    );
  });

  afterAll(async () => {
    await app?.exit();
    await openai?.close();
    await anthropic?.close();
    await openaiStream?.close();
    await anthropicStream?.close();
    await ensembleStream?.close();
    await tokensOpenai?.close();
    await tokensAnthropic?.close();
    await tokensCount?.close();
  });

  async function post(
    path: string,
    body: Record<string, unknown>,
    auth: "openai" | "anthropic" = "openai",
  ): Promise<{ body: string; contentType: string | null }> {
    const response = await fetch(`${app!.proxyUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(auth === "openai"
          ? { authorization: `Bearer ${API_KEY}` }
          : { "x-api-key": API_KEY }),
      },
      body: JSON.stringify(body),
    });
    const responseBody = await response.text();
    expect(response.ok, responseBody).toBe(true);
    return {
      body: responseBody,
      contentType: response.headers.get("content-type"),
    };
  }

  function receivedSince(
    upstream: OpenAiUpstream,
    baseline: number,
    path: string,
  ): Record<string, unknown> {
    const request = upstream.receivedRequests
      .slice(baseline)
      .find((candidate) => candidate.path === path);
    expect(request).toBeDefined();
    return JSON.parse(request!.body) as Record<string, unknown>;
  }

  function chatRequestsSince(
    upstream: OpenAiUpstream,
    baseline: number,
  ): Record<string, unknown>[] {
    return upstream.receivedRequests
      .slice(baseline)
      .filter((request) => request.path === "/v1/chat/completions")
      .map((request) => JSON.parse(request.body) as Record<string, unknown>);
  }


  test("uses the dispatched target map once and passes unlisted values through", async (ctx) => {
    if (!etcdReachable || !app || !openai) {
      ctx.skip();
      return;
    }

    let baseline = openai.receivedRequests.length;
    await post("/v1/chat/completions", {
      model: "effort-map-group",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "medium",
    });
    expect(
      receivedSince(openai, baseline, "/v1/chat/completions")
        .reasoning_effort,
    ).toBe("high");

    baseline = openai.receivedRequests.length;
    await post("/v1/chat/completions", {
      model: "effort-map-openai",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "low",
    });
    expect(
      receivedSince(openai, baseline, "/v1/chat/completions")
        .reasoning_effort,
    ).toBe("low");

    baseline = openai.receivedRequests.length;
    await post("/v1/chat/completions", {
      model: "effort-map-ensemble",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "medium",
    });
    const ensembleRequests = chatRequestsSince(openai, baseline);
    expect(
      ensembleRequests.find(
        (request) => request.model === "glm-ensemble-panel-wire",
      )?.reasoning_effort,
    ).toBe("high");
    expect(
      ensembleRequests.find(
        (request) => request.model === "glm-ensemble-judge-wire",
      )?.reasoning_effort,
    ).toBe("max");
  });





  test("fills the ensemble judge request from the judge's own not-set entry", async (ctx) => {
    if (!etcdReachable || !app || !tokensOpenai) {
      ctx.skip();
      return;
    }

    const baseline = tokensOpenai.receivedRequests.length;
    await post("/v1/chat/completions", {
      model: "effort-tokens-ensemble",
      messages: [{ role: "user", content: "hello" }],
    });
    const requests = chatRequestsSince(tokensOpenai, baseline);
    expect(
      requests.find((request) => request.model === "glm-tokens-panel-wire"),
    ).not.toHaveProperty("reasoning_effort");
    expect(
      requests.find((request) => request.model === "glm-tokens-judge-wire")
        ?.reasoning_effort,
    ).toBe("high");
  });





  test("strips the effort from every unlisted value when the wildcard maps to null", async (ctx) => {
    if (!etcdReachable || !app || !tokensOpenai) {
      ctx.skip();
      return;
    }

    let baseline = tokensOpenai.receivedRequests.length;
    await post("/v1/chat/completions", {
      model: "effort-tokens-strip",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "xl",
    });
    expect(
      receivedSince(tokensOpenai, baseline, "/v1/chat/completions"),
    ).not.toHaveProperty("reasoning_effort");

    // An exact entry still outranks the wildcard, and a request that sets
    // no effort is still not the wildcard's business.
    baseline = tokensOpenai.receivedRequests.length;
    await post("/v1/chat/completions", {
      model: "effort-tokens-strip",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "medium",
    });
    expect(
      receivedSince(tokensOpenai, baseline, "/v1/chat/completions")
        .reasoning_effort,
    ).toBe("high");

    baseline = tokensOpenai.receivedRequests.length;
    await post("/v1/chat/completions", {
      model: "effort-tokens-strip",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(
      receivedSince(tokensOpenai, baseline, "/v1/chat/completions"),
    ).not.toHaveProperty("reasoning_effort");
  });

  test("passes an unset effort through when no entry matches it", async (ctx) => {
    if (!etcdReachable || !app || !openai) {
      ctx.skip();
      return;
    }

    // `effort-map-openai` maps only `medium` and `high`, so a request that
    // sets no effort reaches the upstream exactly as the caller wrote it —
    // an explicit null or empty string included.
    for (const carrier of NO_EFFORT_CARRIERS) {
      const baseline = openai.receivedRequests.length;
      await post("/v1/chat/completions", {
        model: "effort-map-openai",
        messages: [{ role: "user", content: "hello" }],
        ...carrier,
      });
      const sent = receivedSince(openai, baseline, "/v1/chat/completions");
      expect(sent.reasoning_effort, JSON.stringify(carrier)).toEqual(
        carrier.reasoning_effort,
      );
    }

    let baseline = openai.receivedRequests.length;
    await post("/v1/responses", {
      model: "effort-map-openai",
      input: "hello",
      reasoning: { effort: null, summary: "auto" },
    });
    expect(
      receivedSince(openai, baseline, "/v1/responses").reasoning,
    ).toEqual({ effort: null, summary: "auto" });

    baseline = openai.receivedRequests.length;
    await post("/v1/responses", {
      model: "effort-map-openai",
      input: "hello",
    });
    expect(
      receivedSince(openai, baseline, "/v1/responses"),
    ).not.toHaveProperty("reasoning");
  });

});

// The empty-string key stands for a request that sets no effort, and a
// null value removes the effort field — so the pair asks to remove a field
// the request never set. Such a row does not load, from etcd or from a
// resources file.
describe("resources file: the not-set key may not map to null", () => {
  const BIN_PATH =
    process.env.AISIX_BIN ??
    join(process.cwd(), "..", "..", "target", "debug", "aisix");

  const file = (mapping: string) =>
    [
      '_format_version: "2"',
      "provider_keys:",
      "  - id: 0b6f3c1e-2f0a-4c5e-9d55-7d1a8b0c2e11",
      "    display_name: pk",
      "    api_key: sk-x",
      "models:",
      "  - id: 6efd592d-a73b-573d-8e2c-e9e103692f92",
      "    display_name: m",
      "    provider: openai",
      "    model_name: gpt-4o",
      "    provider_key_id: 0b6f3c1e-2f0a-4c5e-9d55-7d1a8b0c2e11",
      "    effort_mapping:",
      mapping,
    ].join("\n");

  test("`\"\": null` is refused, and the other two tokens validate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aisix-effort-tokens-"));
    try {
      const bad = join(dir, "bad.yaml");
      await writeFile(bad, file('      "": null'), "utf8");
      let failure: (Error & { code?: number; stderr?: string }) | undefined;
      try {
        await execFileP(BIN_PATH, ["validate", "--resources", bad]);
      } catch (e) {
        failure = e as Error & { code?: number; stderr?: string };
      }
      if (!failure) throw new Error("expected `aisix validate` to fail");
      expect(failure.code).toBe(1);
      expect(String(failure.stderr)).toContain("effort_mapping");

      // The same file with a value on that key, plus the two tokens that
      // do combine, validates — so the refusal is the pair and nothing
      // else in the fixture.
      const good = join(dir, "good.yaml");
      await writeFile(
        good,
        file('      "": high\n      "*": low\n      medium: null'),
        "utf8",
      );
      const ok = await execFileP(BIN_PATH, ["validate", "--resources", good]);
      expect(ok.stdout).toContain("OK:");

    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

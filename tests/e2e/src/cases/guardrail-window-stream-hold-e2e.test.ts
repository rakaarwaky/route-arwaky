import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  EtcdClient,
  ProxyClient,
  SeedClient,
  spawnApp,
  startMockSls,
  startOpenAiUpstream,
  waitConfigPropagation,
  waitForSlsLog,
  type MockSls,
  type OpenAiUpstream,
  type SpawnedApp,
} from "../harness/index.js";

// E2E: a custom OUTPUT guardrail in its default `window` streaming mode, on
// the routes that hold a streamed response whole — /v1/responses and
// passthrough Chat routes — plus a chat release path for the mixed chain.
//
// A block-capable output guardrail has to judge the content before any of it
// reaches the caller, so on each route:
//   - a stream the provider flags is refused with none of it on the wire —
//     not even the clean text the upstream sent ahead of the flagged part;
//   - a clean stream still arrives whole, after the scan.
// Held content is capped by the row's own `max_buffer_bytes`, and what
// happens past it is the row's own `on_buffer_exceeded`:
//   - `fail_closed` refuses the stream and names the row whose cap it
//     outgrew (`blocked_buffer_exceeded`);
//   - `fail_open` releases it unscanned and records the skipped scan as an
//     `output_buffer_exceeded` bypass.
// With several window rows the caps fold: the smallest wins, fail-closed
// unless every row fails open. A chain with a `buffer_full` row takes its
// cap and overflow policy from its `buffer_full` rows alone, on every route
// including chat: a default window row beside a 1 MiB fail-open
// `buffer_full` row does not tighten it to the window default (256 KiB,
// fail-closed).

const CALLER = "sk-window-stream-hold-e2e";
const CREDENTIAL_REF = "mock";
const LOGSTORE = "window-stream-hold-events";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

const LEAD = "Here is the first part of the answer. ";
const FLAGGED = "wndholdflaggedphrase";
const CLEAN_TAIL = "Nothing else to add.";

const SCRIPT_BLOCK = `\nexport function checkOutput(ctx) {\n  return ctx.text.includes("${FLAGGED}") ? { action: "block" } : { action: "none" };\n}`;

const BLOCK_ROW = "window-custom-block";
const CLOSED_ROW = "window-custom-cap-closed";
const OPEN_ROW = "window-custom-cap-open";
const FOLD_OPEN_ROW = "window-custom-fold-open";
const FOLD_CLOSED_ROW = "window-custom-fold-closed";
const MIXED_FULL_ROW = "mixed-custom-buffer-full";
const MIXED_WINDOW_ROW = "mixed-custom-window-default";
const PASSTHROUGH_AT_CAP_ROUTE = "window-pt-cap-equal";
const PASSTHROUGH_CLOSED_ROUTE = "window-pt-cap-closed";
const PASSTHROUGH_OPEN_ROUTE = "window-pt-cap-open";
const PASSTHROUGH_OPEN_TAIL_ROUTE = "window-pt-cap-open-tail";
const PASSTHROUGH_CLOSED_TAIL_ROUTE = "window-pt-cap-closed-tail";
const PASSTHROUGH_RAW_CLOSED_ROUTE = "window-pt-raw-cap-closed";
const PASSTHROUGH_RAW_OPEN_ROUTE = "window-pt-raw-cap-open";
const PASSTHROUGH_FRAGMENT_CLOSED_ROUTE = "window-pt-fragment-cap-closed";

// 30 pieces of 100 bytes: three times the rows' cap, far under the window.
const CAP = 1_000;
const RAW_HOLD_FACTOR = 128;
const BIG = Array.from({ length: 30 }, (_, i) => `${String(i).padStart(2, "0")}${"w".repeat(98)}`);
// 300 pieces of 1,000 bytes: past the window default (256 KiB), under the
// buffer_full row's 1 MiB.
const HUGE = Array.from({ length: 300 }, (_, i) => `${String(i).padStart(3, "0")}${"h".repeat(997)}`);

const chatChunk = (delta: Record<string, unknown>, finish: string | null = null) =>
  JSON.stringify({
    id: "chatcmpl-window-hold",
    object: "chat.completion.chunk",
    model: "gpt-4o-mini",
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
const chatEvents = (pieces: string[]) => [
  chatChunk({ role: "assistant" }),
  ...pieces.map((content) => chatChunk({ content })),
  chatChunk({}, "stop"),
  "[DONE]",
];
const WINDOW_OPEN_MARKER = "window-open-marker";
const WINDOW_OPEN_EVENTS = chatEvents([
  ...BIG.slice(0, 5),
  `${WINDOW_OPEN_MARKER}${FLAGGED}${BIG[5]}`,
  ...BIG.slice(6),
]);
const WINDOW_AT_CAP_MARKER = "window-at-cap-marker";
const WINDOW_AT_CAP_EVENTS = chatEvents([
  ...BIG.slice(0, 9),
  `${WINDOW_AT_CAP_MARKER}${"e".repeat(BIG[9]!.length - WINDOW_AT_CAP_MARKER.length)}`,
]);
const WINDOW_TAIL_MARKER = "window-tail-marker";
const WINDOW_TAIL_FRAME = `data: ${chatChunk({ content: `${WINDOW_TAIL_MARKER}${FLAGGED}${"z".repeat(CAP)}` })}`;
const WINDOW_CLOSED_TAIL_MARKER = "window-closed-tail-marker";
const WINDOW_CLOSED_TAIL_FRAME = `data: ${chatChunk({ content: `${WINDOW_CLOSED_TAIL_MARKER}${"z".repeat(CAP)}` })}`;
const WINDOW_RAW_MARKER = "window-raw-keepalive-marker";
const WINDOW_RAW_FRAME = `:${WINDOW_RAW_MARKER}${"k".repeat(RAW_HOLD_FACTOR * CAP)}\n\n`;
const WINDOW_FRAGMENT_MARKER = "window-fragment-marker";
const WINDOW_UNTERMINATED_FRAME = `:${WINDOW_FRAGMENT_MARKER}${"u".repeat(RAW_HOLD_FACTOR * CAP)}`;

const anthropicEvents = (pieces: string[]) => [
  JSON.stringify({
    type: "message_start",
    message: {
      id: "msg_window_hold",
      type: "message",
      role: "assistant",
      content: [],
      model: "claude-3-5-haiku-20241022",
      stop_reason: null,
      usage: { input_tokens: 5, output_tokens: 1 },
    },
  }),
  JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  ...pieces.map((text) =>
    JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
  ),
  JSON.stringify({ type: "content_block_stop", index: 0 }),
  JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 40 } }),
  JSON.stringify({ type: "message_stop" }),
];

const responsesEvents = (pieces: string[]) => [
  JSON.stringify({
    type: "response.created",
    response: { id: "resp_window_hold", object: "response", status: "in_progress", model: "gpt-4o-mini", output: [] },
  }),
  ...pieces.map((delta) =>
    JSON.stringify({
      type: "response.output_text.delta",
      item_id: "msg_window_hold",
      output_index: 0,
      content_index: 0,
      delta,
    }),
  ),
  JSON.stringify({
    type: "response.completed",
    response: {
      id: "resp_window_hold",
      object: "response",
      status: "completed",
      model: "gpt-4o-mini",
      output: [],
      usage: { input_tokens: 5, output_tokens: 40, total_tokens: 45 },
    },
  }),
];

type Variant = "block" | "clean" | "closed" | "open" | "fold" | "mixed";
const variants = ["block", "clean", "closed", "open", "fold", "mixed"] as const;
const piecesFor = (v: Variant) =>
  v === "block" ? [LEAD, FLAGGED, CLEAN_TAIL] : v === "clean" ? [LEAD, CLEAN_TAIL] : v === "mixed" ? HUGE : BIG;

interface EnforcedHit {
  guardrail_name: string;
  hook: string;
  action: string;
}

describe("a window-mode output guardrail holds a streamed response it cannot release by window", () => {
  let app: SpawnedApp | undefined;
  let sls: MockSls | undefined;
  const upstreams: OpenAiUpstream[] = [];
  const passthroughUpstreams = new Map<string, OpenAiUpstream>();
  let etcdReachable = false;

  const routes = [
    { route: "/v1/responses", slug: "resp-native", events: responsesEvents },
    // Chat releases a window chain window by window; only the mixed chain,
    // which holds as buffer_full, is driven through it.
    { route: "/v1/chat/completions", slug: "chat", events: chatEvents },
  ] as const;
  const variantsFor = (slug: string): readonly Variant[] => (slug === "chat" ? ["mixed"] : variants);
  const modelName = (slug: string, v: Variant) => `wnd-${slug}-${v}`;

  beforeAll(async () => {
    const etcd = new EtcdClient();
    etcdReachable = await etcd.ping();
    if (!etcdReachable) return;

    sls = await startMockSls();
    app = await spawnApp({
      extraEnv: {
        [`SLS_CRED_${CREDENTIAL_REF.toUpperCase()}_AK_ID`]: "mock-akid",
        [`SLS_CRED_${CREDENTIAL_REF.toUpperCase()}_AK_SECRET`]: "mock-secret",
      },
    });
    const seed = new SeedClient(etcd, app.etcdPrefix);
    await seed.createObservabilityExporter({
      name: "sls-window-hold",
      enabled: true,
      kind: "aliyun_sls",
      endpoint: sls.url,
      project: "aisix-e2e-obs",
      logstore: LOGSTORE,
      credential_ref: CREDENTIAL_REF,
      content_mode: "metadata_only",
    });

    // No `stream_processing_mode`: the kind's default, `window`.
    const row = (name: string, extra: Record<string, unknown> = {}) =>
      seed.createGuardrail(
        {
          name,
          enabled: true,
          kind: "custom",
          hook_point: "output",
          script: SCRIPT_BLOCK,
          timeout_ms: 5000,
          ...extra,
        },
        { attach: false },
      );
    const rows: Record<Variant, { id: string }[]> = {
      block: [await row(BLOCK_ROW)],
      clean: [await row(`${BLOCK_ROW}-clean`)],
      closed: [await row(CLOSED_ROW, { max_buffer_bytes: CAP, on_buffer_exceeded: "fail_closed" })],
      open: [await row(OPEN_ROW, { max_buffer_bytes: CAP, on_buffer_exceeded: "fail_open" })],
      fold: [
        await row(FOLD_OPEN_ROW, { max_buffer_bytes: 2 * CAP, on_buffer_exceeded: "fail_open" }),
        await row(FOLD_CLOSED_ROW, { max_buffer_bytes: CAP, on_buffer_exceeded: "fail_closed" }),
      ],
      mixed: [
        await row(MIXED_FULL_ROW, {
          stream_processing_mode: "buffer_full",
          max_buffer_bytes: 1_048_576,
          on_buffer_exceeded: "fail_open",
        }),
        await row(MIXED_WINDOW_ROW),
      ],
    };

    for (const r of routes) {
      for (const v of variantsFor(r.slug)) {
        const upstream = await startOpenAiUpstream({ streamEvents: r.events(piecesFor(v)) });
        upstreams.push(upstream);
        const pk = await seed.createProviderKey({
          display_name: `${modelName(r.slug, v)}-pk`,
          api_key: "sk-mock",
          api_base: `${upstream.baseUrl}/v1`,
        });
        const m = await seed.createModel({
          display_name: modelName(r.slug, v),
          provider: "openai",
          model_name: "gpt-4o-mini",
          provider_key_id: pk.id,
        });
        for (const g of rows[v]) await seed.attachGuardrailToModel(g.id, m.id);
      }
    }

    const addPassthrough = async (
      name: string,
      path_prefix: string,
      upstream: OpenAiUpstream,
      guardrail_id: string,
    ) => {
      upstreams.push(upstream);
      passthroughUpstreams.set(name, upstream);
      const providerKey = await seed.createProviderKey({
        display_name: `${name}-pk`,
        api_key: "sk-mock",
        api_base: `${upstream.baseUrl}/v1`,
      });
      const route = await seed.createPassthroughRoute({
        name,
        path_prefix,
        target_url: `${upstream.baseUrl}/v1`,
        provider_key_id: providerKey.id,
      });
      await seed.update("guardrail_attachments", randomUUID(), {
        guardrail_id,
        scope_type: "passthrough_route",
        scope_id: route.id,
        priority: 100,
      });
    };
    await addPassthrough(
      PASSTHROUGH_AT_CAP_ROUTE,
      "/passthrough/window-cap-equal",
      await startOpenAiUpstream({ streamEvents: WINDOW_AT_CAP_EVENTS }),
      rows.closed[0]!.id,
    );
    await addPassthrough(
      PASSTHROUGH_CLOSED_ROUTE,
      "/passthrough/window-cap-closed",
      await startOpenAiUpstream({ streamEvents: chatEvents(BIG) }),
      rows.closed[0]!.id,
    );
    await addPassthrough(
      PASSTHROUGH_OPEN_ROUTE,
      "/passthrough/window-cap-open",
      await startOpenAiUpstream({ streamEvents: WINDOW_OPEN_EVENTS }),
      rows.open[0]!.id,
    );
    await addPassthrough(
      PASSTHROUGH_OPEN_TAIL_ROUTE,
      "/passthrough/window-cap-open-tail",
      await startOpenAiUpstream({ rawStreamFrames: [WINDOW_TAIL_FRAME] }),
      rows.open[0]!.id,
    );
    await addPassthrough(
      PASSTHROUGH_CLOSED_TAIL_ROUTE,
      "/passthrough/window-cap-closed-tail",
      await startOpenAiUpstream({ rawStreamFrames: [WINDOW_CLOSED_TAIL_FRAME] }),
      rows.closed[0]!.id,
    );
    await addPassthrough(
      PASSTHROUGH_RAW_CLOSED_ROUTE,
      "/passthrough/window-raw-cap-closed",
      await startOpenAiUpstream({ rawStreamFrames: [WINDOW_RAW_FRAME] }),
      rows.closed[0]!.id,
    );
    await addPassthrough(
      PASSTHROUGH_RAW_OPEN_ROUTE,
      "/passthrough/window-raw-cap-open",
      await startOpenAiUpstream({ rawStreamFrames: [WINDOW_RAW_FRAME] }),
      rows.open[0]!.id,
    );
    await addPassthrough(
      PASSTHROUGH_FRAGMENT_CLOSED_ROUTE,
      "/passthrough/window-fragment-cap-closed",
      await startOpenAiUpstream({
        rawStreamFrames: [WINDOW_UNTERMINATED_FRAME, "\n\n"],
        eventDelayMs: 3_000,
      }),
      rows.closed[0]!.id,
    );

    // Caller key LAST: it authenticating implies every row above is live.
    await seed.createApiKey({ key_hash: hash(CALLER), allowed_models: ["*"], allowed_routes: ["*"] });
    const proxy = new ProxyClient(app.proxyUrl, CALLER);
    await waitConfigPropagation(async () => (await proxy.listModels()).status === 200);
  }, 120_000);

  afterAll(async () => {
    await app?.exit();
    await Promise.all(upstreams.map((u) => u.close()));
    await sls?.close();
  });

  const send = async (slug: string, model: string) => {
    const path = slug === "chat" ? "/v1/chat/completions" : "/v1/responses";
    const body =
      slug === "chat" ? { model, messages: [{ role: "user", content: "go" }] } : { model, input: "go" };
    const res = await fetch(`${app!.proxyUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${CALLER}`,
      },
      body: JSON.stringify({ ...body, stream: true }),
    });
    return res.text();
  };
  const byModel = (model: string) => (l: Map<string, string>) => l.get("requested_model") === model;
  const sendPassthrough = async (path: string) => {
    const res = await fetch(`${app!.proxyUrl}${path}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${CALLER}`,
        "x-api-key": CALLER,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "go" }],
        stream: true,
      }),
    });
    return res.text();
  };
  const beforeTimeout = <T>(promise: Promise<T>, timeoutMs: number) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`passthrough response did not arrive within ${timeoutMs}ms`)),
        timeoutMs,
      );
      void promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  const passthroughUpstream = (name: string) => {
    const upstream = passthroughUpstreams.get(name);
    if (!upstream) throw new Error(`missing passthrough upstream for ${name}`);
    return upstream;
  };
  const waitForPassthroughRequest = async (name: string, timeoutMs = 5_000) => {
    const upstream = passthroughUpstream(name);
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const poll = () => {
        if (upstream.receivedRequests.length > 0) {
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error(`upstream ${name} did not receive a request`));
          return;
        }
        setTimeout(poll, 10);
      };
      poll();
    });
  };
  const expectPassthroughRequest = (name: string) => {
    const request = passthroughUpstream(name).receivedRequests[0];
    expect(passthroughUpstream(name).receivedRequests).toHaveLength(1);
    expect(request).toMatchObject({ method: "POST", path: "/v1/chat/completions" });
    expect(JSON.parse(request!.body)).toMatchObject({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "go" }],
      stream: true,
    });
  };

  for (const r of routes) {
    test(`${r.route}: a default window row does not tighten a 1 MiB fail_open buffer_full sibling`, async (ctx) => {
      if (!etcdReachable || !app || !sls) return ctx.skip();
      const model = modelName(r.slug, "mixed");
      const body = await send(r.slug, model);
      expect(body, "the chain was capped below the buffer_full row's 1 MiB").not.toContain("output_buffer_exceeded");
      expect(body).toContain(HUGE[299]);
      const log = await waitForSlsLog(sls, LOGSTORE, byModel(model), r.route);
      expect(log.get("guardrail_blocked") ?? "false").not.toBe("true");
      expect(log.get("guardrail_bypassed_reason") ?? "", `${r.route}: scanned whole, nothing bypassed`).toBe("");
    });
  }

  for (const r of routes.filter((r) => r.slug !== "chat")) {
    test(`${r.route}: window rows fold to the smallest cap, fail_closed unless all fail open`, async (ctx) => {
      if (!etcdReachable || !app || !sls) return ctx.skip();
      const model = modelName(r.slug, "fold");
      const body = await send(r.slug, model);
      expect(body).toContain("output_buffer_exceeded");
      expect(body).not.toContain(BIG[29]);
      const log = await waitForSlsLog(sls, LOGSTORE, byModel(model), r.route);
      const hits = JSON.parse(log.get("guardrail_enforced_hits") ?? "[]") as EnforcedHit[];
      expect(hits.map(({ guardrail_name, action }) => ({ guardrail_name, action }))).toEqual([
        { guardrail_name: FOLD_CLOSED_ROW, action: "blocked_buffer_exceeded" },
      ]);
    });

    test(`${r.route}: a flagged stream is refused with none of it sent`, async (ctx) => {
      if (!etcdReachable || !app || !sls) return ctx.skip();
      const model = modelName(r.slug, "block");
      const body = await send(r.slug, model);
      expect(body, "the clean text ahead of the flagged part went out before the verdict").not.toContain(LEAD);
      expect(body).not.toContain(FLAGGED);
      const log = await waitForSlsLog(sls, LOGSTORE, byModel(model), r.route);
      expect(log.get("guardrail_blocked"), `${r.route}: the refusal is not recorded`).toBe("true");
    });

    test(`${r.route}: a clean stream arrives whole after the scan`, async (ctx) => {
      if (!etcdReachable || !app) return ctx.skip();
      const body = await send(r.slug, modelName(r.slug, "clean"));
      expect(body).toContain(LEAD);
      expect(body).toContain(CLEAN_TAIL);
    });

    test(`${r.route}: past the row's cap under fail_closed, the stream is refused and the row named`, async (ctx) => {
      if (!etcdReachable || !app || !sls) return ctx.skip();
      const model = modelName(r.slug, "closed");
      const body = await send(r.slug, model);
      expect(body).toContain("output_buffer_exceeded");
      expect(body).not.toContain(BIG[29]);
      const log = await waitForSlsLog(sls, LOGSTORE, byModel(model), r.route);
      expect(log.get("guardrail_blocked")).toBe("true");
      const hits = JSON.parse(log.get("guardrail_enforced_hits") ?? "[]") as EnforcedHit[];
      expect(
        hits.map(({ guardrail_name, hook, action }) => ({ guardrail_name, hook, action })),
        `${r.route}: the refusal names no row, or the wrong one`,
      ).toEqual([{ guardrail_name: CLOSED_ROW, hook: "output", action: "blocked_buffer_exceeded" }]);
    });

    test(`${r.route}: past the row's cap under fail_open, the stream is released and the bypass recorded`, async (ctx) => {
      if (!etcdReachable || !app || !sls) return ctx.skip();
      const model = modelName(r.slug, "open");
      const body = await send(r.slug, model);
      expect(body, "fail_open releases what was held").toContain(BIG[29]);
      expect(body).not.toContain("output_buffer_exceeded");
      const log = await waitForSlsLog(sls, LOGSTORE, byModel(model), r.route);
      expect(log.get("guardrail_blocked") ?? "false").not.toBe("true");
      expect(log.get("guardrail_bypassed_reason"), `${r.route}: the unscanned release is not recorded`).toBe(
        "output_buffer_exceeded",
      );
    });
  }

  test("passthrough route: a Window cap does not trip at exactly its configured content limit", async (ctx) => {
    if (!etcdReachable || !app || !sls) return ctx.skip();
    const body = await sendPassthrough("/passthrough/window-cap-equal");
    expectPassthroughRequest(PASSTHROUGH_AT_CAP_ROUTE);
    expect(body).toContain(WINDOW_AT_CAP_MARKER);
    expect(body).not.toContain("output_buffer_exceeded");
    const log = await waitForSlsLog(
      sls,
      LOGSTORE,
      (l) => l.get("passthrough_route_name") === PASSTHROUGH_AT_CAP_ROUTE,
      "passthrough Window at-cap control",
    );
    expect(log.get("guardrail_blocked") ?? "false").not.toBe("true");
    expect(log.get("guardrail_bypassed_reason") ?? "").toBe("");
    expect(JSON.parse(log.get("guardrail_enforced_hits") ?? "[]")).toEqual([]);
  });
});

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  EtcdClient,
  SeedClient,
  spawnApp,
  startMockSls,
  waitConfigPropagation,
  waitForSlsLog,
  type MockSls,
  type SpawnedApp,
} from "../harness/index.js";

// A chat, messages or responses answer always carries an id. On a chat
// stream the upstream's first id holds
// from the frame that reports it on, and empty frames ahead of it share one
// generated id.

const CALLER = "sk-response-id-never-empty";
const CALLER_HASH = createHash("sha256").update(CALLER).digest("hex");
const CREDENTIAL_REF = "mock";
const LOGSTORE = "response-id";
const RESPONSE_ID = "h-Pq_2xY7-Lm0Nb4Vc9Zt1A";

/** An OpenAI-shape stream whose frames report these ids, in order. */
const OPENAI_FRAME_IDS = ["", "", "up-first", "", "up-other"];
const OPENAI_STREAM = OPENAI_FRAME_IDS.map((id, i) =>
  JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        delta: i === 0 ? { role: "assistant", content: "o" } : { content: "k" },
        finish_reason: i === OPENAI_FRAME_IDS.length - 1 ? "stop" : null,
      },
    ],
  }),
);

function sseData(raw: string): any[] {
  return raw
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
    .map((l) => JSON.parse(l.slice(6)));
}

describe("response ids", () => {
  let app: SpawnedApp | undefined;
  let upstream: Server | undefined;
  let sls: MockSls | undefined;
  let etcdReachable = false;

  beforeAll(async () => {
    const etcd = new EtcdClient();
    etcdReachable = await etcd.ping();
    if (!etcdReachable) return;

    upstream = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`${OPENAI_STREAM.map((f) => `data: ${f}\n\n`).join("")}data: [DONE]\n\n`);
      });
    });
    await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
    const addr = upstream.address();
    if (addr === null || typeof addr === "string") throw new Error("no port");
    const base = `http://127.0.0.1:${addr.port}`;

    sls = await startMockSls();
    app = await spawnApp({
      extraEnv: {
        [`SLS_CRED_${CREDENTIAL_REF.toUpperCase()}_AK_ID`]: "LTAI_mock_ak",
        [`SLS_CRED_${CREDENTIAL_REF.toUpperCase()}_AK_SECRET`]: "mock_ak_secret",
      },
    });
    const seed = new SeedClient(etcd, app.etcdPrefix);
    await seed.createObservabilityExporter({
      name: "id-sls",
      enabled: true,
      kind: "aliyun_sls",
      endpoint: sls.url,
      project: "aisix-e2e-obs",
      logstore: LOGSTORE,
      credential_ref: CREDENTIAL_REF,
    });
    const openai = await seed.createProviderKey({
      display_name: "id-openai-pk",
      api_key: "sk-mock",
      api_base: `${base}/v1`,
    });
    await seed.createModel({
      display_name: "openai-late-id",
      provider: "openai",
      model_name: "gpt-4o-mini",
      provider_key_id: openai.id,
    });
    // Seeded last: this key authenticating implies the whole seed set landed.
    await seed.createApiKey({ key_hash: CALLER_HASH, allowed_models: ["*"] });
    await waitConfigPropagation(async () => {
      const res = await fetch(`${app!.proxyUrl}/v1/models`, { headers: { authorization: `Bearer ${CALLER}` } });
      await res.text();
      return res.status === 200;
    });
  }, 60_000);

  afterAll(async () => {
    await app?.exit();
    await sls?.close();
    await new Promise<void>((resolve) => (upstream ? upstream.close(() => resolve()) : resolve()));
  });

  async function post(path: string, body: Record<string, unknown>): Promise<{ raw: string; requestId: string }> {
    const res = await fetch(`${app!.proxyUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${CALLER}`, "x-api-key": CALLER, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    expect(res.status, raw.slice(0, 500)).toBe(200);
    return { raw, requestId: res.headers.get("x-aisix-request-id") ?? "" };
  }

  const chat = (model: string, stream = false) =>
    post("/v1/chat/completions", { model, stream, messages: [{ role: "user", content: "hi" }] });
  const responses = (model: string, stream = false) => post("/v1/responses", { model, stream, input: "hi" });

  async function providerRequestId(requestId: string): Promise<string | undefined> {
    const row = await waitForSlsLog(sls!, LOGSTORE, (l) => l.get("request_id") === requestId, "usage row");
    return row.get("provider_request_id");
  }

  /** The one id every frame of a chat stream carries. */
  function chatStreamId(raw: string): string {
    const frames = sseData(raw);
    expect(frames.length).toBeGreaterThan(1);
    const ids = new Set(frames.map((f) => f.id));
    expect([...ids], "every frame carries one id").toHaveLength(1);
    return [...ids][0];
  }

  test("the upstream's first id holds whatever later frames report", async (ctx) => {
    if (!etcdReachable || !app) return ctx.skip();
    const ids = sseData((await chat("openai-late-id", true)).raw).map((f) => f.id);
    // One frame per upstream frame: two empty, then "up-first", "", "up-other".
    expect(ids).toHaveLength(OPENAI_FRAME_IDS.length);
    expect(ids[0]).toMatch(/^chatcmpl-[0-9a-f]{32}$/);
    expect(ids[1]).toBe(ids[0]);
    expect(ids.slice(2)).toEqual(["up-first", "up-first", "up-first"]);
  });
});

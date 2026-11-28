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

// E2E: a request that carries no scannable text still gets a guardrail
// VERDICT. Found by release QA on v0.11.0-rc.5 and reproducing back to
// rc.4 — pre-existing, not a regression.
//
// The gateway used to treat "nothing to scan" as "nothing to decide":
// `/v1/audio/transcriptions` with no `prompt` form field — i.e. the
// ordinary shape of that endpoint — and `/v1/images/edits` with no
// `prompt` part succeeded under an unconditional `block` policy.
//
// A guardrail that decides about the CALL does not allow an empty request
// through, and that difference belongs to the guardrail, never to the
// call site.
//
// The upstream request recorder is the load-bearing assertion: a refusal
// that still contacted the provider would have leaked exactly the payload
// the guardrail exists to keep in.

const BLOCKING_KEY = "sk-textless-blocking";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** No `ctx` read at all: the verdict cannot come from the text. */
const BLOCK_EVERYTHING = `
export function checkInput() {
  return { action: "block", reason_code: "textless-e2e" };
}
`;

/** One gateway plus its upstream, wired with a single guardrail row. */
interface Env {
  app: SpawnedApp;
  llm: OpenAiUpstream;
  key: string;
}

const startEnv = async (
  etcd: EtcdClient,
  key: string,
  guardrail: Record<string, unknown>,
): Promise<Env> => {
  const llm = await startOpenAiUpstream({ nonStreamBody: { input_tokens: 7 } });
  const app = await spawnApp();
  const seed = new SeedClient(etcd, app.etcdPrefix);

  const openaiPk = await seed.createProviderKey({
    display_name: "textless-openai",
    api_key: "sk-mock",
    api_base: `${llm.baseUrl}/v1`,
  });
  await seed.createModel({
    display_name: "textless-audio",
    provider: "openai",
    model_name: "gpt-4o-transcribe",
    provider_key_id: openaiPk.id,
  });
  // No attachment row: a guardrail with none falls back to implicit
  // env scope, which is what an operator gets by default.
  await seed.createGuardrail(guardrail);

  // Written LAST, so the key authenticating implies every row above it
  // landed (etcd applies in revision order). The gate touches neither a
  // guarded endpoint nor a guardrail, so a broken assertion below fails as
  // an assertion rather than as a gate timeout.
  await seed.createApiKey({
    key_hash: sha256(key),
    allowed_models: ["*"],
  });
  const proxy = new ProxyClient(app.proxyUrl, key);
  await waitConfigPropagation(async () => (await proxy.listModels()).status === 200);

  return { app, llm, key };
};

/** A transcription upload with no `prompt` part — the ordinary shape. */
const transcribe = (env: Env) => {
  const form = new FormData();
  form.set("model", "textless-audio");
  form.set(
    "file",
    new Blob([new Uint8Array([0x49, 0x44, 0x33])], { type: "audio/mpeg" }),
    "a.mp3",
  );
  return fetch(`${env.app.proxyUrl}/v1/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.key}` },
    body: form,
  });
};

describe("textless requests still get a guardrail verdict", () => {
  let etcdReachable = false;
  let blocking: Env | undefined;

  beforeAll(async () => {
    const etcd = new EtcdClient();
    etcdReachable = await etcd.ping();
    if (!etcdReachable) return;

    blocking = await startEnv(etcd, BLOCKING_KEY, {
      name: "textless-block-all",
      enabled: true,
      kind: "custom",
      hook_point: "input",
      fail_open: false,
      script: BLOCK_EVERYTHING,
      timeout_ms: 5000,
    });
  }, 90_000);

  afterAll(async () => {
    await blocking?.app.exit();
    await blocking?.llm.close();
  });

  test("a transcription with no prompt field is refused", async (ctx) => {
    if (!etcdReachable || !blocking) return ctx.skip();

    const before = blocking.llm.receivedRequests.length;
    const res = await transcribe(blocking);

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error?: { type?: string; message?: string } };
    expect(body.error?.type).toBe("content_filter");
    expect(body.error?.message ?? "").toContain("textless-block-all");

    const forwarded = blocking.llm.receivedRequests
      .slice(before)
      .filter((r) => r.path.includes("transcriptions"));
    expect(forwarded).toEqual([]);
  }, 30_000);
});

import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { WebSocket as WsClient } from "ws";
import {
  EtcdClient,
  SeedClient,
  expectFailureRowsNamed,
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

// Every failure row names its failure in `error_message`, under `metadata_only`
// too, on the routes that hold no typed error as well as those that do. Only an
// exporter at `metadata_only` is configured here, so nothing a full-content
// export would read can be what filled the message in.

const CALLER = "sk-row-meta-caller";
const LOGSTORE = "row-meta";
const CREDENTIAL_REF = "mock";
const SENTINEL = "sentinel-upstream-said-this";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

const jsonError = JSON.stringify({ error: { message: SENTINEL } });
const JSON_HEADERS = { "content-type": "application/json" };

describe("failure rows name the failure under metadata_only", () => {
  let app: SpawnedApp | undefined;
  let sls: MockSls | undefined;
  const httpServers: HttpServer[] = [];
  const tcpServers: TcpServer[] = [];
  const upstreams: OpenAiUpstream[] = [];
  let etcdReachable = false;

  async function fixedUpstream(
    status: number,
    body: string | Buffer,
    headers: Record<string, string> = JSON_HEADERS,
  ): Promise<string> {
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(status, headers);
        res.end(body);
      });
    });
    httpServers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }

  /** An upstream answering in one write, so what arrives with the head is up to the test. */
  async function rawUpstream(response: string): Promise<string> {
    const server = createTcpServer((socket) => {
      socket.once("data", () => socket.write(response, () => socket.destroy()));
      socket.on("error", () => {});
    });
    tcpServers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }

  beforeAll(async () => {
    const etcd = new EtcdClient();
    etcdReachable = await etcd.ping();
    if (!etcdReachable) return;
    sls = await startMockSls();
    app = await spawnApp({ logLevel: "info" });
    const seed = new SeedClient(etcd, app.etcdPrefix);
    await seed.createObservabilityExporter({
      name: LOGSTORE,
      enabled: true,
      kind: "aliyun_sls",
      endpoint: sls.url,
      project: "row-meta-project",
      logstore: LOGSTORE,
      credential_ref: CREDENTIAL_REF,
      content_mode: "metadata_only",
    });

    const modelAt = async (name: string, base: string) => {
      const pk = await seed.createProviderKey({
        display_name: `${name}-pk`,
        api_key: "sk-mock",
        api_base: base,
      });
      await seed.createModel({
        display_name: name,
        provider: "openai",
        model_name: "gpt-4o-mini",
        provider_key_id: pk.id,
      });
      return pk;
    };

    const chatOk = await startOpenAiUpstream();
    upstreams.push(chatOk);
    await modelAt("meta-chat", `${chatOk.baseUrl}/v1`);

    const failing = await fixedUpstream(500, jsonError);
    await modelAt("meta-jobs-500", `${failing}/v1`);
    const refusal = (headers: string, body: string) =>
      rawUpstream(`HTTP/1.1 400 Bad Request\r\n${headers}\r\n\r\n${body}`);
    const size = Buffer.byteLength(jsonError);
    await modelAt(
      "meta-realtime-sized",
      `${await refusal(`content-length: ${size}`, jsonError)}/v1`,
    );
    await modelAt(
      "meta-realtime-chunked",
      `${await refusal("transfer-encoding: chunked", `${size.toString(16)}\r\n${jsonError}\r\n0\r\n\r\n`)}/v1`,
    );
    await modelAt(
      "meta-realtime-late-detail",
      `${await refusal(`content-length: ${size}`, "")}/v1`,
    );
    await modelAt(
      "meta-in-band-blank",
      `${await fixedUpstream(
        200,
        `data: ${JSON.stringify({ error: { message: "", code: "overloaded" } })}\n\n`,
        { "content-type": "text/event-stream" },
      )}/v1`,
    );
    await modelAt(
      "meta-in-band-blank-mid-stream",
      `${await fixedUpstream(
        200,
        `data: ${JSON.stringify({
          id: "c1",
          object: "chat.completion.chunk",
          model: "gpt-4o-mini",
          choices: [{ index: 0, delta: { role: "assistant", content: "partial" } }],
        })}\n\n` +
          `data: ${JSON.stringify({ error: { message: "", code: "overloaded" } })}\n\n`,
        { "content-type": "text/event-stream" },
      )}/v1`,
    );
    const failingPk = await modelAt("meta-chat-500", `${failing}/v1`);

    await seed.createPassthroughRoute({
      name: "meta-route-json",
      path_prefix: "/meta-route-json",
      target_url: failing,
      provider_key_id: failingPk.id,
    });
    await seed.createPassthroughRoute({
      name: "meta-route-empty",
      path_prefix: "/meta-route-empty",
      target_url: await fixedUpstream(503, ""),
      provider_key_id: failingPk.id,
    });
    await seed.createPassthroughRoute({
      name: "meta-route-sse",
      path_prefix: "/meta-route-sse",
      target_url: await fixedUpstream(429, `data: ${SENTINEL}\n\n`, {
        "content-type": "text/event-stream",
      }),
      provider_key_id: failingPk.id,
    });

    await seed.createPassthroughRoute({
      name: "meta-route-gzip",
      path_prefix: "/meta-route-gzip",
      target_url: await fixedUpstream(500, gzipSync(jsonError), {
        ...JSON_HEADERS,
        "content-encoding": "gzip",
      }),
      provider_key_id: failingPk.id,
    });
    await seed.createPassthroughRoute({
      name: "meta-route-gzip-sse",
      path_prefix: "/meta-route-gzip-sse",
      target_url: await fixedUpstream(500, gzipSync(jsonError), {
        "content-type": "text/event-stream",
        "content-encoding": "gzip",
      }),
      provider_key_id: failingPk.id,
    });

    await seed.createApiKey({
      key_hash: hash(CALLER),
      allowed_models: ["*"],
      allowed_routes: [
        "meta-route-json",
        "meta-route-empty",
        "meta-route-sse",
        "meta-route-gzip",
        "meta-route-gzip-sse",
      ],
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
    if (etcdReachable) expect(expectFailureRowsNamed(sls!, LOGSTORE)).toBeGreaterThan(0);
    await sls?.close();
    await Promise.all(upstreams.map((u) => u.close()));
    for (const server of tcpServers) server.close();
    await Promise.all(
      httpServers.map((s) => new Promise<void>((r) => s.close(() => r()))),
    );
  });

  async function post(path: string, body: unknown) {
    const res = await fetch(`${app!.proxyUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${CALLER}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      text: await res.text(),
      requestId: res.headers.get("x-aisix-request-id") ?? "",
    };
  }

  const rowOf = (requestId: string, what: string) =>
    waitForSlsLog(sls!, LOGSTORE, (l) => l.get("request_id") === requestId, what);

  afterEach(() => {
    if (etcdReachable) expectFailureRowsNamed(sls!, LOGSTORE);
  });

  test("a validation 400 carries the text the caller was told", async (ctx) => {
    if (!etcdReachable) return ctx.skip();
    const r = await post("/v1/chat/completions", { model: "meta-chat", messages: [] });
    expect(r.status).toBe(400);
    const row = await rowOf(r.requestId, "the 400 row");
    expect(row.get("error_class")).toBe("invalid_request_error");
    expect(row.get("error_message")).toBe(JSON.parse(r.text).error.message);
  });

  test("an upstream's error on a typed route reads as it does on an attempt", async (ctx) => {
    if (!etcdReachable) return ctx.skip();
    const r = await post("/v1/chat/completions", {
      model: "meta-chat-500",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r.status).toBeGreaterThanOrEqual(500);
    const row = await rowOf(r.requestId, "the chat row");
    expect(row.get("error_class")).toBe("upstream_status");
    expect(row.get("error_message")).toBe(`upstream returned HTTP 500: ${SENTINEL}`);
  });

  test("jobs: a relayed upstream failure carries what the upstream said", async (ctx) => {
    if (!etcdReachable) return ctx.skip();
    const r = await post("/v1/batches?model=meta-jobs-500", { input_file_id: "f" });
    expect(r.status).toBe(500);
    expect(r.text).toBe(jsonError);
    const row = await rowOf(r.requestId, "the jobs row");
    expect(row.get("status_code")).toBe("500");
    expect(row.get("error_class")).toBe("upstream_status");
    expect(row.get("error_message")).toBe(`upstream returned HTTP 500: ${SENTINEL}`);
  });

  test("passthrough: a buffered failure is relayed as sent and named on the row", async (ctx) => {
    if (!etcdReachable) return ctx.skip();
    const r = await post("/meta-route-json/anything", { x: 1 });
    expect(r.status).toBe(500);
    expect(r.text).toBe(jsonError);
    const row = await rowOf(r.requestId, "the passthrough row");
    expect(row.get("error_class")).toBe("upstream_status");
    expect(row.get("error_message")).toBe(`upstream returned HTTP 500: ${SENTINEL}`);
  });

  test("passthrough: an empty failure says it had no detail", async (ctx) => {
    if (!etcdReachable) return ctx.skip();
    const r = await post("/meta-route-empty/anything", { x: 1 });
    expect(r.status).toBe(503);
    expect(r.text).toBe("");
    const row = await rowOf(r.requestId, "the empty passthrough row");
    expect(row.get("error_message")).toBe(
      "upstream returned HTTP 503 with no error detail in the response",
    );
  });

  test("passthrough: a failure relayed as a stream reaches the caller untouched", async (ctx) => {
    if (!etcdReachable) return ctx.skip();
    const r = await post("/meta-route-sse/anything", { x: 1 });
    expect(r.status).toBe(429);
    expect(r.text).toBe(`data: ${SENTINEL}\n\n`);
    const row = await rowOf(r.requestId, "the opaque passthrough row");
    expect(row.get("error_class")).toBe("upstream_status");
    expect(row.get("error_message")).toContain(SENTINEL);
  });

  test.for(["/meta-route-gzip", "/meta-route-gzip-sse"])(
    "passthrough %s: a compressed failure is not read as text",
    async (prefix, ctx) => {
      if (!etcdReachable) return ctx.skip();
      const r = await post(`${prefix}/anything`, { x: 1 });
      expect(r.status).toBe(500);
      const row = await rowOf(r.requestId, "the compressed failure's row");
      expect(row.get("error_class")).toBe("upstream_status");
      expect(row.get("error_message")).toBe("upstream returned HTTP 500 with a compressed error body");
    },
  );



  async function refusedRealtime(model: string) {
    const requestId = await new Promise<string>((resolve, reject) => {
      const ws = new WsClient(
        `${app!.proxyUrl.replace("http://", "ws://")}/v1/realtime?model=${model}`,
        { headers: { authorization: `Bearer ${CALLER}` } },
      );
      let id = "";
      ws.on("upgrade", (res) => {
        id = String(res.headers["x-aisix-request-id"] ?? "");
      });
      ws.on("close", () => resolve(id));
      ws.on("error", reject);
    });
    const row = await rowOf(requestId, "the realtime row");
    expect(row.get("status_code")).toBe("400");
    expect(row.get("error_class")).toBe("upstream_status");
    return row;
  }

  test.for(["meta-realtime-sized", "meta-realtime-chunked"])(
    "realtime %s: a refusal whose body arrived whole is named with what it said",
    async (model, ctx) => {
      if (!etcdReachable) return ctx.skip();
      const row = await refusedRealtime(model);
      expect(row.get("error_message")).toBe(
        `upstream returned HTTP 400: ${SENTINEL}`,
      );
    },
  );

  test("realtime: a refusal whose detail never arrived names the failed read", async (ctx) => {
    if (!etcdReachable) return ctx.skip();
    const row = await refusedRealtime("meta-realtime-late-detail");
    expect(row.get("error_message")).toMatch(
      /^upstream returned HTTP 400: failed to read response body: .+/,
    );
  });

  test("an in-band stream error with an empty message says so and names its code", async (ctx) => {
    if (!etcdReachable) return ctx.skip();
    const r = await post("/v1/chat/completions", {
      model: "meta-in-band-blank",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    const row = await rowOf(r.requestId, "the blank in-band row");
    expect(row.get("error_class")).toBe("upstream_in_band");
    expect(row.get("error_message")).toBe(
      "upstream reported an in-band error with no message: overloaded",
    );
  });

  test("a mid-stream in-band error with an empty message names it on the row, not to the caller", async (ctx) => {
    if (!etcdReachable) return ctx.skip();
    const r = await post("/v1/chat/completions", {
      model: "meta-in-band-blank-mid-stream",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r.status).toBe(200);
    expect(r.text).toContain("upstream reported an in-band stream error: ");
    expect(r.text).not.toContain("with no message");
    const row = await rowOf(r.requestId, "the mid-stream in-band row");
    expect(row.get("error_message")).toBe(
      "upstream reported an in-band error with no message: overloaded",
    );
  });

});

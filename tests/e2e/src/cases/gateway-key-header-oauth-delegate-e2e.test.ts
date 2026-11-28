import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  EtcdClient,
  ProxyClient,
  SeedClient,
  spawnApp,
  startMcpUpstream,
  startOpenAiUpstream,
  waitConfigPropagation,
  type McpUpstream,
  type OpenAiUpstream,
  type SpawnedApp,
} from "../harness/index.js";

// E2E: the dedicated gateway-credential header `x-aisix-api-key`, and the
// `oauth_delegate` MCP upstream auth type it makes possible.
//
// A caller that needs both a gateway credential and its own credential
// for an upstream — an MCP server behind its own OAuth — cannot put both
// in `Authorization`. With `x-aisix-api-key` present the gateway reads
// only that header for its own authentication, and `Authorization` is
// left to the caller. Pinned journeys:
//
//   1. On an LLM endpoint and on /mcp, `x-aisix-api-key` authenticates
//      the request whatever `Authorization` carries; a wrong or empty one
//      is refused even beside a valid `Authorization` (no fall-through);
//      and the header never reaches an upstream.
//   2. An `oauth_delegate` server (`type: mcp` and `type: openapi`)
//      receives the caller's `Authorization` unchanged when the caller
//      authenticated with `x-aisix-api-key`, and nothing when that
//      `Authorization` WAS the gateway credential.
//   3. A `gateway_key` passthrough route that forwards the caller's
//      credentials relays `Authorization` when the gateway key came in its
//      own header.

const CALLER_KEY = "sk-gateway-key-header-e2e";
const CALLER_HASH = createHash("sha256").update(CALLER_KEY).digest("hex");
const NARROW_KEY = "sk-gateway-key-header-narrow";
const USER_TOKEN = "Bearer upstream-user-token-123";
const MODEL = "gw-key-header-model";
const ROUTE_PREFIX = "/passthrough/gw-key-header";

function systemServerSpec(): Record<string, unknown> {
  return {
    openapi: "3.0.0",
    info: { title: "delegate-rest", version: "1" },
    paths: {
      "/models": {
        get: {
          operationId: "listmodels",
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };
}

describe("x-aisix-api-key + oauth_delegate e2e", () => {
  let app: SpawnedApp | undefined;
  let upstream: OpenAiUpstream | undefined;
  let mcpUpstream: McpUpstream | undefined;
  let otherUpstream: McpUpstream | undefined;
  let etcdReachable = false;

  const chat = (headers: Record<string, string>): Promise<Response> =>
    fetch(`${app!.proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "probe" }],
      }),
    });

  const mcpPost = (
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<Response> =>
    fetch(`${app!.proxyUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify(body),
    });

  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "gateway-key-header-e2e", version: "0.1" },
    },
  };

  /** One tool call through `path`, failing loudly on a non-2xx. */
  const callTool = async (
    path: string,
    tool: string,
    headers: Record<string, string>,
  ): Promise<Record<string, any>> => {
    for (const body of [
      initialize,
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ]) {
      const res = await mcpPost(path, body, headers);
      expect(res.ok, `${path} handshake: ${res.status}`).toBe(true);
      await res.text();
    }
    const res = await mcpPost(
      path,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: tool, arguments: { text: "hi" } },
      },
      headers,
    );
    const text = await res.text();
    expect(res.ok, `${path} tools/call: ${res.status} ${text.slice(0, 300)}`).toBe(true);
    return JSON.parse(text);
  };

  beforeAll(async () => {
    const etcd = new EtcdClient();
    etcdReachable = await etcd.ping();
    if (!etcdReachable) return;

    upstream = await startOpenAiUpstream();
    mcpUpstream = await startMcpUpstream("deleg");
    otherUpstream = await startMcpUpstream("other");
    app = await spawnApp({});
    const seed = new SeedClient(etcd, app.etcdPrefix);

    const pk = await seed.createProviderKey({
      display_name: "gw-key-header-pk",
      api_key: "sk-provider-secret",
      api_base: `${upstream.baseUrl}/v1`,
    });
    await seed.createModel({
      display_name: MODEL,
      provider: "openai",
      model_name: "gpt-4o-mini",
      provider_key_id: pk.id,
    });
    await seed.update("mcp_servers", randomUUID(), {
      name: "delegmcp",
      type: "mcp",
      url: mcpUpstream.url,
      auth_type: "oauth_delegate",
      // Naming the slot the auth type owns must not reopen it: the gateway
      // credential still never reaches the upstream.
      forward_client_headers: ["authorization"],
    });
    await seed.update("mcp_servers", randomUUID(), {
      name: "delegother",
      type: "mcp",
      url: otherUpstream.url,
      auth_type: "oauth_delegate",
    });
    await seed.update("mcp_servers", randomUUID(), {
      name: "delegrest",
      type: "openapi",
      url: `${upstream.baseUrl}/v1`,
      spec: systemServerSpec(),
      auth_type: "oauth_delegate",
    });
    await seed.createPassthroughRoute({
      name: "gw-key-header-route",
      path_prefix: ROUTE_PREFIX,
      target_url: upstream.baseUrl,
      auth_mode: "gateway_key",
      credential_mode: "forward_client",
    });
    await seed.createApiKey({
      key_hash: createHash("sha256").update(NARROW_KEY).digest("hex"),
      allowed_models: [],
      mcp_access: { allow: ["delegmcp__*"] },
    });
    await seed.createApiKey({
      key_hash: CALLER_HASH,
      allowed_models: ["*"],
      allowed_routes: ["*"],
      mcp_access: { allow: ["*"] },
    });
    const proxy = new ProxyClient(app.proxyUrl, CALLER_KEY);
    await waitConfigPropagation(async () => (await proxy.listModels()).status === 200);
  }, 120_000);

  afterAll(async () => {
    await app?.exit();
    await upstream?.close();
    await mcpUpstream?.close();
    await otherUpstream?.close();
  });

  test("an LLM endpoint authenticates with x-aisix-api-key, ignoring Authorization", async () => {
    if (!etcdReachable) return;
    const mark = upstream!.receivedRequests.length;

    const ok = await chat({
      "x-aisix-api-key": CALLER_KEY,
      authorization: USER_TOKEN,
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
    const seen = upstream!.receivedRequests.slice(mark);
    expect(seen.length).toBe(1);
    expect(seen[0].headers["x-aisix-api-key"]).toBeUndefined();
    // The provider still gets the gateway-held key, not the caller's token.
    expect(seen[0].headers.authorization).toBe("Bearer sk-provider-secret");

    // A client that can only send a scheme may send one.
    const withScheme = await chat({
      "x-aisix-api-key": `Bearer ${CALLER_KEY}`,
      authorization: USER_TOKEN,
    });
    expect(withScheme.status).toBe(200);

    // Present means it is the only header read: wrong or empty is refused
    // even beside a valid gateway key in Authorization or x-api-key.
    for (const value of ["sk-not-a-key", ""]) {
      const refused = await chat({
        "x-aisix-api-key": value,
        authorization: `Bearer ${CALLER_KEY}`,
        "x-api-key": CALLER_KEY,
      });
      expect(refused.status, `x-aisix-api-key=${JSON.stringify(value)}`).toBe(401);
    }

    // Without it, nothing changed: Authorization is the gateway credential.
    expect((await chat({ authorization: `Bearer ${CALLER_KEY}` })).status).toBe(200);
    expect(
      (await chat({ authorization: USER_TOKEN, "x-api-key": CALLER_KEY })).status,
    ).toBe(401);
  });





  test("a forward_client passthrough route relays Authorization when the gateway key has its own header", async () => {
    if (!etcdReachable) return;
    const send = (headers: Record<string, string>) =>
      fetch(`${app!.proxyUrl}${ROUTE_PREFIX}/v1/models`, { headers });

    let mark = upstream!.receivedRequests.length;
    let res = await send({ "x-aisix-api-key": CALLER_KEY, authorization: USER_TOKEN });
    expect(res.status, await res.text()).toBe(200);
    let seen = upstream!.receivedRequests.slice(mark).at(-1)!;
    expect(seen.headers.authorization).toBe(USER_TOKEN);
    expect(seen.headers["x-aisix-api-key"]).toBeUndefined();

    // The gateway key in Authorization is consumed, as before.
    mark = upstream!.receivedRequests.length;
    res = await send({ authorization: `Bearer ${CALLER_KEY}` });
    expect(res.status, await res.text()).toBe(200);
    seen = upstream!.receivedRequests.slice(mark).at(-1)!;
    expect(seen.headers.authorization).toBeUndefined();
  });
});

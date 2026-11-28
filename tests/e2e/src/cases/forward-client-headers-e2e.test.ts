import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  EtcdClient,
  ProxyClient,
  SeedClient,
  spawnApp,
  startOpenAiUpstream,
  waitConfigPropagation,
  type OpenAiUpstream,
  type ReceivedRequest,
  type SpawnedApp,
} from "../harness/index.js";

// E2E: `forward_client_headers` across every proxy face the gateway
// serves, exercised through a real gateway against real upstreams.
//
// The capability is auth-independent: the operator names header patterns
// per upstream, and whatever the caller sent under a matching name reaches
// that upstream verbatim. It is how a gateway fronting an INTERNAL service
// hands that service the end user's own credentials and context — the
// service keeps reading the header it always read.
//
// Two faces build their outbound headers in completely different code,
// which is why each gets its own coverage here:
//
//   1. /v1/*             — ProviderKey `request.forward_client_headers`,
//                          on the shared bridge pipeline.
//   2. /passthrough/*    — the `passthrough_route` field, where the
//                          default is the opposite (forward everything)
//                          and the list OVERRIDES a strip.
//
// And beside them, the sub-dispatch paths of the model kinds that do NOT
// go through the one convergence point the faces above share: an
// ensemble's panel members and its judge each reach a DIFFERENT upstream,
// so each obeys ITS OWN ProviderKey's list rather than the ensemble
// entry's — the entry has no ProviderKey at all.
//
// The credential collision is asserted on every face: a header the
// operator named beats the credential the gateway would otherwise inject
// into that slot, and rides ALONE — two credentials on the wire would let
// the upstream choose. And the limits are asserted beside it, because they
// are why the default is "forward nothing": the gateway's own `x-aisix-*`
// namespace, and trace context under a glob.

const CALLER_KEY = "sk-fwd-headers-caller-PLAINTEXT";
const CALLER_HASH = createHash("sha256").update(CALLER_KEY).digest("hex");

const FORWARD_MODEL = "fwd-openai-model";
const PLAIN_MODEL = "fwd-plain-model";
const ENSEMBLE_MODEL = "fwd-ensemble-model";
const ENSEMBLE_MEMBER_A = "fwd-ensemble-member-a";
const ENSEMBLE_MEMBER_B = "fwd-ensemble-member-b";
const ENSEMBLE_JUDGE = "fwd-ensemble-judge";
const ROUTE_PREFIX = "/passthrough/fwd";
const GATEWAY_KEY_HEADER = "x-gw-key";
const CUSTOM_HEADER = "x-user-jwt";
const CALLER_CREDENTIAL = "Bearer callers-own-credential";
const GATEWAY_SECRET = "sk-mock-provider-secret";

// What a caller carries in the slots no route's strip set used to name.
const CALLER_SLOTS: Record<string, string> = {
  "api-key": "caller-azure-key",
  "x-goog-api-key": "caller-gemini-key",
  "x-amz-security-token": "caller-aws-session-token",
  "x-amz-date": "20260903T120000Z",
  "x-amz-content-sha256": "e3b0c44298fc1c14",
  cookie: "session=caller-cookie",
};
const PLAIN_HEADER = "x-plain-context";

describe("forward_client_headers e2e: one capability across every proxy face", () => {
  let app: SpawnedApp | undefined;
  let upstream: OpenAiUpstream | undefined;
  let etcdReachable = false;

  const since = (mark: number): ReceivedRequest[] =>
    upstream!.receivedRequests.slice(mark);

  /** How many times `name` arrived on the wire, occurrences not values. */
  const occurrences = (req: { headerNames: string[] }, name: string): number =>
    req.headerNames.filter((n) => n === name).length;

  const bodyOf = async (res: Response, what: string): Promise<string> => {
    const text = await res.text();
    expect(
      res.ok,
      `${what} failed with ${res.status}: ${text.slice(0, 400)}`,
    ).toBe(true);
    return text;
  };

  const chat = async (
    model: string,
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    fetch(`${app!.proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${CALLER_KEY}`,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "probe" }],
      }),
    });

  beforeAll(async () => {
    const etcd = new EtcdClient();
    etcdReachable = await etcd.ping();
    if (!etcdReachable) return;

    upstream = await startOpenAiUpstream();
    app = await spawnApp({});
    const seed = new SeedClient(etcd, app.etcdPrefix);

    // The upstream the operator opted in: a custom header, the caller's
    // own credential slot, and a glob that must NOT sweep trace context.
    const forwardingPk = await seed.createProviderKey({
      display_name: "fwd-pk",
      api_key: GATEWAY_SECRET,
      api_base: `${upstream.baseUrl}/v1`,
      request: {
        // `X-*` and `Trace*` deliberately in the spelling an operator's
        // own docs use: header names are case-insensitive on the wire, so
        // a matcher that compared case-sensitively would forward nothing
        // under either.
        forward_client_headers: [CUSTOM_HEADER, "authorization", "X-*", "Trace*"],
      },
    });
    // A second upstream with no opt-in — the default every ProviderKey has.
    const plainPk = await seed.createProviderKey({
      display_name: "fwd-plain-pk",
      api_key: GATEWAY_SECRET,
      api_base: `${upstream.baseUrl}/v1`,
    });
    await seed.createModel({
      display_name: FORWARD_MODEL,
      provider: "openai",
      model_name: "gpt-4o-mini",
      provider_key_id: forwardingPk.id,
    });
    await seed.createModel({
      display_name: PLAIN_MODEL,
      provider: "openai",
      model_name: "gpt-4o-mini",
      provider_key_id: plainPk.id,
    });

    // An ensemble whose panel members and judge all sit behind the
    // opted-in ProviderKey. `ProxyModelCaller::call` and the streaming
    // judge build their own dispatch contexts instead of reusing the
    // entry's, which is the shape this repo's model-kind rule calls the
    // most-repeated silent gap.
    for (const member of [ENSEMBLE_MEMBER_A, ENSEMBLE_MEMBER_B, ENSEMBLE_JUDGE]) {
      await seed.createModel({
        display_name: member,
        provider: "openai",
        model_name: "gpt-4o-mini",
        provider_key_id: forwardingPk.id,
      });
    }
    await seed.createModel({
      display_name: ENSEMBLE_MODEL,
      ensemble: {
        panel: [{ model: ENSEMBLE_MEMBER_A }, { model: ENSEMBLE_MEMBER_B }],
        judge: { model: ENSEMBLE_JUDGE },
        min_responses: 2,
      },
    });

    // `gateway_key` + `inject`: the gateway CONSUMES `authorization` to
    // identify the caller and strips it, and `strip_headers` removes the
    // custom slot too. Both strips are what the list overrides.
    const routePk = await seed.createProviderKey({
      display_name: "fwd-route-pk",
      api_key: GATEWAY_SECRET,
      api_base: upstream.baseUrl,
      strip_headers: ["authorization", CUSTOM_HEADER],
    });
    await seed.createPassthroughRoute({
      name: "fwd-route",
      path_prefix: ROUTE_PREFIX,
      target_url: upstream.baseUrl,
      auth_mode: "gateway_key",
      credential_mode: "inject",
      provider_key_id: routePk.id,
      forward_client_headers: [CUSTOM_HEADER, "authorization"],
    });
    await seed.createPassthroughRoute({
      name: "fwd-route-plain",
      path_prefix: `${ROUTE_PREFIX}-plain`,
      target_url: upstream.baseUrl,
      auth_mode: "gateway_key",
      credential_mode: "inject",
      provider_key_id: routePk.id,
    });

    const callerKeyId = randomUUID();

    // Credential slots on `inject` hold whatever the ProviderKey lists, so
    // this one lists nothing at all.
    const injectPk = await seed.createProviderKey({
      display_name: "fwd-inject-pk",
      api_key: GATEWAY_SECRET,
      api_base: upstream.baseUrl,
      strip_headers: [],
    });
    const injectRoutes: Array<[string, Record<string, unknown>]> = [
      ["none", {}],
      ["subglob", { forward_client_headers: ["x-*"] }],
      ["star", { forward_client_headers: ["*"] }],
      [
        "named",
        {
          forward_client_headers: [
            ...Object.keys(CALLER_SLOTS),
            "authorization",
            "proxy-authorization",
          ],
        },
      ],
      ["one-named", { forward_client_headers: ["x-goog-api-key", "x-*"] }],
      [
        "anon",
        {
          auth_mode: "anonymous",
          anonymous_key_id: callerKeyId,
          source_cidrs: ["127.0.0.0/8", "::1/128"],
          forward_client_headers: ["x-*"],
        },
      ],
      [
        "headerkey",
        {
          auth_mode: "header_key",
          auth_header_name: GATEWAY_KEY_HEADER,
          forward_client_headers: ["x-*"],
        },
      ],
    ];
    for (const [suffix, overrides] of injectRoutes) {
      await seed.createPassthroughRoute({
        name: `fwd-route-inject-${suffix}`,
        path_prefix: `${ROUTE_PREFIX}-inject-${suffix}`,
        target_url: upstream.baseUrl,
        auth_mode: "gateway_key",
        credential_mode: "inject",
        provider_key_id: injectPk.id,
        ...overrides,
      });
    }
    for (const [suffix, overrides] of [
      ["byo", {}],
      ["byo-glob", { forward_client_headers: ["x-*"] }],
    ] as Array<[string, Record<string, unknown>]>) {
      await seed.createPassthroughRoute({
        name: `fwd-route-${suffix}`,
        path_prefix: `${ROUTE_PREFIX}-${suffix}`,
        target_url: upstream.baseUrl,
        auth_mode: "gateway_key",
        credential_mode: "forward_client",
        ...overrides,
      });
    }

    // A route that names its OWN gateway-credential slot, and one that
    // names none. `x-*` is the same pattern on both: what differs is
    // whether the route declared a slot for it to have to leave alone.
    //
    // Their ProviderKey strips all three `x-` names below, which is what
    // makes the assertions mean anything: a passthrough route relays
    // whatever it does not strip, so a header outside the strip set
    // arrives upstream whether or not a pattern matched it.
    const slotPk = await seed.createProviderKey({
      display_name: "fwd-slot-pk",
      api_key: GATEWAY_SECRET,
      api_base: upstream.baseUrl,
      strip_headers: [
        "authorization",
        GATEWAY_KEY_HEADER,
        "x-end-user",
        CUSTOM_HEADER,
      ],
    });
    await seed.createPassthroughRoute({
      name: "fwd-route-headerkey",
      path_prefix: `${ROUTE_PREFIX}-headerkey`,
      target_url: upstream.baseUrl,
      auth_mode: "header_key",
      auth_header_name: GATEWAY_KEY_HEADER,
      credential_mode: "inject",
      provider_key_id: slotPk.id,
      identity_header: "x-end-user",
      forward_client_headers: ["x-*"],
    });
    await seed.createPassthroughRoute({
      name: "fwd-route-anon",
      path_prefix: `${ROUTE_PREFIX}-anon`,
      target_url: upstream.baseUrl,
      auth_mode: "anonymous",
      anonymous_key_id: callerKeyId,
      source_cidrs: ["127.0.0.0/8", "::1/128"],
      credential_mode: "inject",
      provider_key_id: slotPk.id,
      forward_client_headers: ["x-*"],
    });
    await seed.update("api_keys", callerKeyId, {
      key_hash: CALLER_HASH,
      allowed_models: ["*"],
      allowed_routes: ["*"],
    });
    const proxy = new ProxyClient(app.proxyUrl, CALLER_KEY);
    await waitConfigPropagation(async () => (await proxy.listModels()).status === 200);
  }, 120_000);

  afterAll(async () => {
    await app?.exit();
    await upstream?.close();
  });

  test("a named header reaches an LLM upstream that opted in", async () => {
    if (!etcdReachable) return;
    const mark = upstream!.receivedRequests.length;

    await chat(FORWARD_MODEL, { [CUSTOM_HEADER]: "carried.verbatim" }).then((r) =>
      bodyOf(r, "/v1/chat/completions"),
    );

    expect(since(mark).at(-1)!.headers[CUSTOM_HEADER]).toBe("carried.verbatim");
  });

  test("an upstream nobody opted in receives nothing", async () => {
    if (!etcdReachable) return;
    const mark = upstream!.receivedRequests.length;

    await chat(PLAIN_MODEL, { [CUSTOM_HEADER]: "carried.verbatim" }).then((r) =>
      bodyOf(r, "/v1/chat/completions on the un-opted-in key"),
    );

    const seen = since(mark).at(-1)!;
    expect(seen.headers[CUSTOM_HEADER]).toBeUndefined();
    expect(seen.headers.authorization).toBe(`Bearer ${GATEWAY_SECRET}`);
  });

  test("a forwarded credential replaces the gateway's, and rides alone", async () => {
    if (!etcdReachable) return;
    const mark = upstream!.receivedRequests.length;

    // The caller authenticates to the GATEWAY with its own AISIX key; the
    // operator has declared that this upstream reads the caller's
    // credential rather than the ProviderKey's.
    await chat(FORWARD_MODEL).then((r) => bodyOf(r, "credential-slot forward"));

    const seen = since(mark).at(-1)!;
    expect(seen.headers.authorization).toBe(`Bearer ${CALLER_KEY}`);
    // And ALONE. Counting occurrences rather than reading the collapsed
    // value is the whole point: node keeps only the FIRST `authorization`,
    // so a second one appended behind it would be invisible here.
    expect(occurrences(seen, "authorization")).toBe(1);
  });


  test("a passthrough route's list overrides its strip set", async () => {
    if (!etcdReachable) return;
    const mark = upstream!.receivedRequests.length;

    // Control first: without the field, `gateway_key` strips the caller's
    // `Authorization` and `strip_headers` strips the custom slot, so the
    // upstream sees the ProviderKey's own credential instead.
    await fetch(`${app!.proxyUrl}${ROUTE_PREFIX}-plain/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${CALLER_KEY}`,
        "content-type": "application/json",
        [CUSTOM_HEADER]: "carried.verbatim",
      },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [] }),
    }).then((r) => bodyOf(r, "the route with no forward"));

    const stripped = since(mark).at(-1)!;
    expect(stripped.headers[CUSTOM_HEADER]).toBeUndefined();
    expect(stripped.headers.authorization).toBe(`Bearer ${GATEWAY_SECRET}`);

    const mark2 = upstream!.receivedRequests.length;
    await fetch(`${app!.proxyUrl}${ROUTE_PREFIX}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${CALLER_KEY}`,
        "content-type": "application/json",
        [CUSTOM_HEADER]: "carried.verbatim",
        "x-aisix-routing-tags": "spoofed-by-caller",
      },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [] }),
    }).then((r) => bodyOf(r, "the route with a forward"));

    const forwarded = since(mark2).at(-1)!;
    expect(forwarded.headers[CUSTOM_HEADER]).toBe("carried.verbatim");
    // A route forwards by default, so the gateway's own namespace has to
    // be refused explicitly — nothing in the strip set names it beyond
    // `x-aisix-request-id`, and a relayed copy would forge a gateway
    // assertion at the upstream.
    expect(forwarded.headers["x-aisix-routing-tags"]).toBeUndefined();
    // The consumed credential slot too. Passthrough relays the caller's
    // copy FIRST and appends the gateway's after it, so the collapsed
    // value would read correctly even if the suppression failed entirely
    // — only the occurrence count shows the ProviderKey credential really
    // stood aside rather than joining it on the wire.
    expect(forwarded.headers.authorization).toBe(`Bearer ${CALLER_KEY}`);
    expect(occurrences(forwarded, "authorization")).toBe(1);
  });

  test("a glob never sweeps the slots a route named for itself", async () => {
    if (!etcdReachable) return;
    const mark = upstream!.receivedRequests.length;

    // `header_key`: the caller's AISIX key arrives in the route's own
    // `x-gw-key`, and the end-user identity in its own `x-end-user`.
    // Both match `x-*`, and neither is on the credential list every
    // surface shares — the route schema in fact forbids those names —
    // so only the per-route rule keeps them off the wire.
    await fetch(`${app!.proxyUrl}${ROUTE_PREFIX}-headerkey/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [GATEWAY_KEY_HEADER]: CALLER_KEY,
        "x-end-user": "alice@example.com",
        [CUSTOM_HEADER]: "recovered",
      },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [] }),
    }).then((r) => bodyOf(r, "the header_key route"));

    const seen = since(mark).at(-1)!;
    expect(seen.headers[GATEWAY_KEY_HEADER]).toBeUndefined();
    expect(seen.headers["x-end-user"]).toBeUndefined();
    // The SAME `x-*` recovers a stripped header that is not a slot. All
    // three are in this ProviderKey's strip set, so the pattern was asked
    // about each of them — without that, a header the route never strips
    // arrives upstream regardless and proves nothing.
    expect(seen.headers[CUSTOM_HEADER]).toBe("recovered");
  });

  test("a route that names no slot of its own is unchanged", async () => {
    if (!etcdReachable) return;
    const mark = upstream!.receivedRequests.length;

    // `anonymous` reads no inbound credential at all, so nothing joins
    // the exact-name set and `x-*` means exactly what it always did —
    // including for a header another route would have treated as a slot.
    await fetch(`${app!.proxyUrl}${ROUTE_PREFIX}-anon/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [GATEWAY_KEY_HEADER]: "not-a-slot-on-this-route",
        [CUSTOM_HEADER]: "recovered",
      },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [] }),
    }).then((r) => bodyOf(r, "the anonymous route"));

    const seen = since(mark).at(-1)!;
    // `x-gw-key` is in this ProviderKey's strip set, so the pattern IS
    // asked about it — and answers yes, because THIS route declared no
    // slot. Widen the narrowing to a global list and this line fails.
    expect(seen.headers[GATEWAY_KEY_HEADER]).toBe("not-a-slot-on-this-route");
    expect(seen.headers[CUSTOM_HEADER]).toBe("recovered");
    // And the shared rule is untouched: the ProviderKey's credential
    // still rides alone.
    expect(seen.headers.authorization).toBe(`Bearer ${GATEWAY_SECRET}`);
    expect(occurrences(seen, "authorization")).toBe(1);
  });


  const callRoute = async (
    suffix: string,
    headers: Record<string, string>,
  ): Promise<ReceivedRequest> => {
    const mark = upstream!.receivedRequests.length;
    await fetch(`${app!.proxyUrl}${ROUTE_PREFIX}-${suffix}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...CALLER_SLOTS,
        [PLAIN_HEADER]: "kept",
        ...headers,
      },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [] }),
    }).then((r) => bodyOf(r, `the ${suffix} route`));
    return since(mark).at(-1)!;
  };

  test.each([
    ["no pattern", "inject-none", { authorization: `Bearer ${CALLER_KEY}` }],
    ["an x-* glob", "inject-subglob", { authorization: `Bearer ${CALLER_KEY}` }],
    ["a * glob", "inject-star", { authorization: `Bearer ${CALLER_KEY}` }],
    ["auth_mode anonymous", "inject-anon", { authorization: "Bearer caller-upstream-cred" }],
    [
      "auth_mode header_key",
      "inject-headerkey",
      { [GATEWAY_KEY_HEADER]: CALLER_KEY, authorization: "Bearer caller-upstream-cred" },
    ],
  ])("an injecting route keeps every credential slot home under %s", async (_, suffix, auth) => {
    if (!etcdReachable) return;

    const seen = await callRoute(suffix, {
      ...auth,
      "x-api-key": "caller-x-api-key",
      "proxy-authorization": "Basic caller-proxy",
    });

    for (const name of [...Object.keys(CALLER_SLOTS), "x-api-key", "proxy-authorization"]) {
      expect(seen.headers[name], `${name} reached the upstream`).toBeUndefined();
    }
    // Withholding the slots is not withholding everything: the header no
    // credential rule applies to still rides, or the checks above would
    // pass for a route that forwards nothing.
    expect(seen.headers[PLAIN_HEADER]).toBe("kept");
    expect(seen.headers.authorization).toBe(`Bearer ${GATEWAY_SECRET}`);
    expect(occurrences(seen, "authorization")).toBe(1);
  });

  test("an injecting route returns a slot named exactly, in place of the injected value", async () => {
    if (!etcdReachable) return;

    const seen = await callRoute("inject-named", {
      authorization: `Bearer ${CALLER_KEY}`,
      "proxy-authorization": "Basic caller-proxy",
    });

    for (const [name, value] of Object.entries({
      ...CALLER_SLOTS,
      "proxy-authorization": "Basic caller-proxy",
    })) {
      expect(seen.headers[name]).toBe(value);
      expect(occurrences(seen, name)).toBe(1);
    }
    expect(seen.headers.authorization).toBe(`Bearer ${CALLER_KEY}`);
    expect(occurrences(seen, "authorization")).toBe(1);
    expect(seen.headers[PLAIN_HEADER]).toBe("kept");
  });


  test("naming one slot beside a glob returns that slot and no other", async () => {
    if (!etcdReachable) return;

    const seen = await callRoute("inject-one-named", { authorization: `Bearer ${CALLER_KEY}` });

    expect(seen.headers["x-goog-api-key"]).toBe(CALLER_SLOTS["x-goog-api-key"]);
    for (const name of Object.keys(CALLER_SLOTS).filter((n) => n !== "x-goog-api-key")) {
      expect(seen.headers[name], `${name} reached the upstream`).toBeUndefined();
    }
    expect(seen.headers.authorization).toBe(`Bearer ${GATEWAY_SECRET}`);
  });

  test.each([
    ["no pattern", "byo"],
    ["an x-* glob", "byo-glob"],
  ])("a forward_client route relays the caller's credentials under %s", async (_, suffix) => {
    if (!etcdReachable) return;

    const seen = await callRoute(suffix, {
      "x-aisix-api-key": CALLER_KEY,
      authorization: "Bearer callers-upstream-credential",
      "x-api-key": "caller-x-api-key",
    });

    for (const [name, value] of Object.entries(CALLER_SLOTS)) {
      expect(seen.headers[name]).toBe(value);
    }
    expect(seen.headers.authorization).toBe("Bearer callers-upstream-credential");
    expect(seen.headers["x-api-key"]).toBe("caller-x-api-key");
    expect(seen.headers[PLAIN_HEADER]).toBe("kept");
  });



  test("an ensemble's panel and judge each forward on their own upstream", async () => {
    if (!etcdReachable) return;
    const mark = upstream!.receivedRequests.length;

    await chat(ENSEMBLE_MODEL, { [CUSTOM_HEADER]: "carried.verbatim" }).then((r) =>
      bodyOf(r, "the ensemble entry"),
    );

    // Two panel members plus the judge, each a separate upstream call
    // built by `ProxyModelCaller::call` rather than by the single
    // dispatch chokepoint.
    const calls = since(mark);
    expect(calls.length, "panel of two plus a judge").toBe(3);
    for (const call of calls) {
      expect(call.headers[CUSTOM_HEADER]).toBe("carried.verbatim");
      // Each sub-call reads its OWN ProviderKey's list, which here also
      // names the credential slot — the ensemble entry has no
      // ProviderKey to inherit one from.
      expect(call.headers.authorization).toBe(`Bearer ${CALLER_KEY}`);
    }
  });

  test("a streamed ensemble judge forwards too", async () => {
    if (!etcdReachable) return;
    const mark = upstream!.receivedRequests.length;

    // The streaming judge is dispatched from a different call site than
    // the buffered one, and only this path exercises it.
    const res = await fetch(`${app!.proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${CALLER_KEY}`,
        "content-type": "application/json",
        [CUSTOM_HEADER]: "carried.verbatim",
      },
      body: JSON.stringify({
        model: ENSEMBLE_MODEL,
        messages: [{ role: "user", content: "probe" }],
        stream: true,
      }),
    });
    await bodyOf(res, "the streamed ensemble");

    const calls = since(mark);
    expect(calls.length).toBe(3);
    for (const call of calls) {
      expect(call.headers[CUSTOM_HEADER]).toBe("carried.verbatim");
    }
  });

  test("the gateway's own namespace and trace context resist a glob", async () => {
    if (!etcdReachable) return;
    const mark = upstream!.receivedRequests.length;

    await chat(FORWARD_MODEL, {
      // Every one of these MATCHES a configured pattern — `x-*` the
      // first three and the SigV4 trio, `trace*` the last — so what stops
      // them is the rule under test, not a pattern that failed to fire.
      "x-aisix-routing-tags": "spoofed-by-caller",
      "x-stainless-lang": "js",
      "x-allowed": "yes",
      "x-amz-security-token": "FQoGZXIvYXdzE-caller-session",
      "x-amz-date": "20260903T120000Z",
      "x-amz-content-sha256": "e3b0c44298fc1c14",
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    }).then((r) => bodyOf(r, "the glob case"));

    const seen = since(mark).at(-1)!;
    expect(seen.headers["x-allowed"]).toBe("yes");
    // The gateway's own assertions cannot be forged through the forward.
    expect(seen.headers["x-aisix-routing-tags"]).toBeUndefined();
    expect(seen.headers["x-stainless-lang"]).toBeUndefined();
    // Trace context needs its own name: a glob is not consent to graft the
    // caller's trace onto the provider's telemetry.
    expect(seen.headers.traceparent).toBeUndefined();
    // A credential slot needs its own name for the same reason, and this
    // is the shape the bug actually took: the caller's live AWS session
    // token arriving at an upstream that has no business holding one.
    for (const name of ["x-amz-security-token", "x-amz-date", "x-amz-content-sha256"]) {
      expect(seen.headers[name], `${name} reached the upstream under a glob`).toBeUndefined();
    }
  });
});

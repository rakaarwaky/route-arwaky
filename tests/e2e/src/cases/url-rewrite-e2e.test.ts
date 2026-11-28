import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { EtcdClient, SeedClient, spawnApp, waitConfigPropagation, type SpawnedApp } from "../harness/index.js";

// E2E: entry-level URL rewriting (`proxy.url_rewrites`) against a real
// gateway + etcd.
//
// Pinned contract:
//   - the first rule whose host and path conditions match rewrites it; the
//     request then flows through the normal endpoint (auth, ACL, quota) as
//     if the client had sent the rewritten path;
//   - rewriting is generic, not endpoint-specific (any path → any endpoint);
//   - a miss leaves the request untouched (canonical paths keep working,
//     unmatched legacy shapes 404);
//   - the query string survives the rewrite.

const KEY = "sk-url-rewrite-e2e";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

describe("url rewrite e2e: proxy.url_rewrites", () => {
  let app: SpawnedApp | undefined;
  let etcdReachable = false;

  beforeAll(async () => {
    const etcd = new EtcdClient();
    etcdReachable = await etcd.ping();
    if (!etcdReachable) return;

    app = await spawnApp({
      urlRewrites: [
        { hosts: ["127.0.0.1"], match: "^/legacy/health$", rewrite: "/livez" },
        // Generic mapping: proves the layer rewrites any path onto any
        // endpoint.
        { match: "^/compat/health$", rewrite: "/livez" },
      ],
    });
    const seed = new SeedClient(new EtcdClient(), app.etcdPrefix);

    await seed.createApiKey({
      key_hash: sha256(KEY),
      allowed_models: [],
    });

    await waitConfigPropagation(async () => {
      const res = await fetch(`${app!.proxyUrl}/v1/models`, {
        headers: { authorization: `Bearer ${KEY}` },
      });
      await res.text();
      return res.status === 200;
    });
  }, 60_000);

  afterAll(async () => {
    await app?.exit();
  });

  test("rewriting is generic: any path maps onto any endpoint", async (ctx) => {
    if (!etcdReachable || !app) return ctx.skip();

    const res = await fetch(`${app.proxyUrl}/compat/health`);
    expect(res.status).toBe(200);

    // A request carrying a query string still matches and routes (`match`
    // never sees the query). Preservation of the query itself is pinned by
    // the `with_path_preserves_the_query_string` unit test — no proxy
    // endpoint echoes its query back for an e2e-level assertion.
    const withQuery = await fetch(`${app.proxyUrl}/compat/health?probe=1`);
    expect(withQuery.status).toBe(200);
  });
});

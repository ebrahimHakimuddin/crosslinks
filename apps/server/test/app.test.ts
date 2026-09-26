import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import type { Config } from "../src/config.js";

describe("LinkSync API", () => {
  let app: FastifyInstance;
  const setupToken = "test-setup-token-with-enough-entropy";
  const password = "a sufficiently long test password";
  let adminCookie = "";

  before(async () => {
    const directory = mkdtempSync(join(tmpdir(), "linksync-test-"));
    const config: Config = {
      host: "127.0.0.1",
      port: 0,
      databasePath: join(directory, "test.db"),
      publicUrl: "http://localhost:8787",
      setupToken,
      secureCookies: false,
      deliveryTtlMs: 1_000,
      historyTtlMs: 10_000,
      pairingTtlMs: 10_000
    };
    app = await buildApp({ config });
  });

  after(async () => app.close());

  it("configures the owner exactly once", async () => {
    const page = await app.inject({ method: "GET", url: "/admin" });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers["content-security-policy"]!, /default-src 'none'/);
    assert.match(page.body, /Set up your server/);
    const icon = await app.inject({ method: "GET", url: "/assets/icon.png" });
    assert.equal(icon.headers["content-type"], "image/png");
    const setup = await app.inject({ method: "POST", url: "/api/v1/setup", payload: { token: setupToken, password } });
    assert.equal(setup.statusCode, 201);
    const repeated = await app.inject({ method: "POST", url: "/api/v1/setup", payload: { token: setupToken, password } });
    assert.equal(repeated.statusCode, 409);
  });

  it("authenticates the owner", async () => {
    const response = await app.inject({ method: "POST", url: "/api/v1/admin/login", payload: { password } });
    assert.equal(response.statusCode, 200);
    adminCookie = response.headers["set-cookie"]!.split(";")[0]!;
  });

  async function pair(deviceKind: "android" | "chrome", name: string, autoOpen = false) {
    const grant = await app.inject({
      method: "POST",
      url: "/api/v1/admin/pairings",
      headers: { cookie: adminCookie },
      payload: { deviceKind }
    });
    assert.equal(grant.statusCode, 201);
    const { code } = grant.json<{ code: string }>();
    const paired = await app.inject({
      method: "POST",
      url: "/api/v1/pair",
      payload: { code, name, deviceKind, autoOpen }
    });
    assert.equal(paired.statusCode, 201);
    return paired.json<{ deviceId: string; token: string }>();
  }

  it("pairs devices and delivers a URL idempotently", async () => {
    const android = await pair("android", "Phone");
    const chrome = await pair("chrome", "Desk", true);
    const versions = await app.inject({
      method: "GET", url: "/api/v1/version", headers: { authorization: `Bearer ${android.token}` }
    });
    assert.equal(versions.statusCode, 200);
    assert.deepEqual(Object.keys(versions.json()).sort(), ["android", "extension", "server"]);
    const payload = { url: "https://example.com/path?q=1#section", targetDeviceId: chrome.deviceId, idempotencyKey: "share-1" };

    const created = await app.inject({
      method: "POST", url: "/api/v1/deliveries", headers: { authorization: `Bearer ${android.token}` }, payload
    });
    assert.equal(created.statusCode, 201);
    const delivery = created.json<{ id: string }>();

    const repeated = await app.inject({
      method: "POST", url: "/api/v1/deliveries", headers: { authorization: `Bearer ${android.token}` }, payload
    });
    assert.equal(repeated.statusCode, 200);
    assert.equal(repeated.json<{ id: string }>().id, delivery.id);

    const next = await app.inject({
      method: "GET", url: "/api/v1/deliveries/next", headers: { authorization: `Bearer ${chrome.token}` }
    });
    assert.equal(next.json<{ id: string }>().id, delivery.id);

    const ack = await app.inject({
      method: "POST", url: `/api/v1/deliveries/${delivery.id}/ack`,
      headers: { authorization: `Bearer ${chrome.token}` }, payload: { status: "delivered" }
    });
    assert.equal(ack.statusCode, 200);

    const empty = await app.inject({
      method: "GET", url: "/api/v1/deliveries/next", headers: { authorization: `Bearer ${chrome.token}` }
    });
    assert.equal(empty.json(), null);
  });

  it("rejects unsafe URL schemes and embedded credentials", async () => {
    const android = await pair("android", "Second phone");
    const chrome = await pair("chrome", "Laptop");
    for (const url of ["javascript:alert(1)", "https://user:secret@example.com/"]) {
      const response = await app.inject({
        method: "POST", url: "/api/v1/deliveries", headers: { authorization: `Bearer ${android.token}` },
        payload: { url, targetDeviceId: chrome.deviceId, idempotencyKey: url }
      });
      assert.equal(response.statusCode, 400);
    }
  });

  it("syncs article metadata with revisions and metadata-free tombstones", async () => {
    const android = await pair("android", "Library phone");
    const chrome = await pair("chrome", "Library browser");
    const body = { url: "https://example.com/article", title: "A story", list: "Read later", snippet: "A passage", progress: 0.4, savedAt: Date.now() };
    const saved = await app.inject({ method: "PUT", url: "/api/v1/articles/story-1", headers: { authorization: `Bearer ${android.token}` }, payload: body });
    assert.equal(saved.statusCode, 200);
    const listed = await app.inject({ method: "GET", url: "/api/v1/articles", headers: { authorization: `Bearer ${chrome.token}` } });
    assert.deepEqual(listed.json<{ articles: unknown[] }>().articles[0], { id: "story-1", ...body, revision: 1, deleted: false });
    const removed = await app.inject({ method: "DELETE", url: "/api/v1/articles/story-1", headers: { authorization: `Bearer ${chrome.token}` } });
    assert.equal(removed.statusCode, 200);
    assert.deepEqual(removed.json(), { id: "story-1", revision: 2, deleted: true });
    const tombstone = await app.inject({ method: "GET", url: "/api/v1/articles", headers: { authorization: `Bearer ${android.token}` } });
    assert.deepEqual(tombstone.json<{ articles: unknown[] }>().articles.at(-1), { id: "story-1", revision: 2, deleted: true });
  });

  it("removes a device while preserving its delivery history", async () => {
    const android = await pair("android", "Removable phone");
    const chrome = await pair("chrome", "Removable browser");
    const created = await app.inject({ method: "POST", url: "/api/v1/deliveries", headers: { authorization: `Bearer ${android.token}` }, payload: { url: "https://example.com/remove", targetDeviceId: chrome.deviceId, idempotencyKey: "remove-1" } });
    assert.equal(created.statusCode, 201);
    const removed = await app.inject({ method: "DELETE", url: `/api/v1/admin/devices/${chrome.deviceId}/remove`, headers: { cookie: adminCookie } });
    assert.equal(removed.statusCode, 204);
    const credential = await app.inject({ method: "GET", url: "/api/v1/version", headers: { authorization: `Bearer ${chrome.token}` } });
    assert.equal(credential.statusCode, 401);
    const history = await app.inject({ method: "GET", url: "/api/v1/history", headers: { authorization: `Bearer ${android.token}` } });
    assert.equal(history.statusCode, 200);
    assert.equal(history.json<Array<{ id: string }>>().some((item) => item.id === created.json<{ id: string }>().id), true);
    const repeated = await app.inject({ method: "DELETE", url: `/api/v1/admin/devices/${chrome.deviceId}/remove`, headers: { cookie: adminCookie } });
    assert.equal(repeated.statusCode, 404);
  });
});

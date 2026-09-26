import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { LinkSyncDatabase } from "../src/database.js";
import type { Config } from "../src/config.js";
import Database from "better-sqlite3";

describe("server revision behavior", () => {
  let app: FastifyInstance;
  let dbPath: string;
  let adminCookie: string;
  const password = "a sufficiently long revision test password";

  before(async () => {
    const directory = mkdtempSync(join(tmpdir(), "linksync-revision-test-"));
    dbPath = join(directory, "linksync.db");
    const config: Config = {
      host: "127.0.0.1", port: 0, databasePath: dbPath,
      publicUrl: "http://localhost:8787", setupToken: "revision-setup-token",
      secureCookies: false, deliveryTtlMs: 60_000, historyTtlMs: 60_000, pairingTtlMs: 60_000
    };
    app = await buildApp({ config });
    await app.inject({ method: "POST", url: "/api/v1/setup", payload: { token: config.setupToken, password } });
    const login = await app.inject({ method: "POST", url: "/api/v1/admin/login", payload: { password } });
    adminCookie = login.headers["set-cookie"]!.split(";")[0]!;
  });

  after(async () => app.close());

  async function pair(deviceKind: "android" | "chrome", name: string) {
    const grant = await app.inject({ method: "POST", url: "/api/v1/admin/pairings", headers: { cookie: adminCookie }, payload: { deviceKind } });
    const paired = await app.inject({ method: "POST", url: "/api/v1/pair", payload: { code: grant.json<{ code: string }>().code, name, deviceKind } });
    assert.equal(paired.statusCode, 201);
    return paired.json<{ deviceId: string; token: string }>();
  }

  it("rejects malformed article fields and persists tombstones across reopen", async () => {
    const device = await pair("android", "revision phone");
    const invalid = await app.inject({ method: "PUT", url: "/api/v1/articles/a", headers: { authorization: `Bearer ${device.token}` }, payload: {
      url: "https://example.com/a", title: [], list: "saved", snippet: "text", progress: 0, savedAt: Date.now()
    } });
    assert.equal(invalid.statusCode, 400);
    const removed = await app.inject({ method: "DELETE", url: "/api/v1/articles/a", headers: { authorization: `Bearer ${device.token}` } });
    assert.deepEqual(removed.json(), { id: "a", revision: 1, deleted: true });
    await app.close();
    const reopened = new LinkSyncDatabase(dbPath);
    const row = reopened.raw.prepare("SELECT url, title, snippet, progress, deleted, revision FROM articles WHERE id = ?").get("a") as Record<string, unknown>;
    assert.deepEqual(row, { url: null, title: null, snippet: null, progress: null, deleted: 1, revision: 1 });
    reopened.close();
    // The suite's after hook must not close an already closed Fastify instance.
    app = await buildApp({ config: {
      host: "127.0.0.1", port: 0, databasePath: dbPath, publicUrl: "http://localhost:8787",
      secureCookies: false, deliveryTtlMs: 60_000, historyTtlMs: 60_000, pairingTtlMs: 60_000
    } });
    const next = await app.inject({ method: "PUT", url: "/api/v1/articles/a", headers: { authorization: `Bearer ${device.token}` }, payload: {
      url: "https://example.com/a", title: "restored", list: "saved", snippet: "after restart", progress: 0.5, savedAt: Date.now()
    } });
    assert.equal(next.json<{ revision: number }>().revision, 2);
  });

  it("turns explicit queued deletion into a terminal receipt without requeueing", async () => {
    const android = await pair("android", "cancel phone");
    const chrome = await pair("chrome", "cancel browser");
    const created = await app.inject({ method: "POST", url: "/api/v1/deliveries", headers: { authorization: `Bearer ${android.token}` }, payload: {
      url: "https://example.com/cancel", targetDeviceId: chrome.deviceId, idempotencyKey: "cancel-1"
    } });
    const delivery = created.json<{ id: string }>();
    assert.equal((await app.inject({ method: "DELETE", url: `/api/v1/admin/deliveries/${delivery.id}`, headers: { cookie: adminCookie } })).statusCode, 204);
    const replay = await app.inject({ method: "POST", url: "/api/v1/deliveries", headers: { authorization: `Bearer ${android.token}` }, payload: {
      url: "https://example.com/cancel", targetDeviceId: chrome.deviceId, idempotencyKey: "cancel-1"
    } });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json<{ status: string }>().status, "failed");
    const next = await app.inject({ method: "GET", url: "/api/v1/deliveries/next", headers: { authorization: `Bearer ${chrome.token}` } });
    assert.equal(next.json(), null);
  });

  it("backfills receipts and adds removed_at when reopening a legacy database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "linksync-legacy-test-"));
    const path = join(directory, "legacy.db");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, auto_open INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER);
      CREATE TABLE deliveries (id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL, url TEXT NOT NULL, source_device_id TEXT NOT NULL, target_device_id TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, delivered_at INTEGER, failure_reason TEXT, UNIQUE(source_device_id, idempotency_key));
      INSERT INTO devices VALUES ('legacy-device', 'Legacy', 'chrome', 'hash', 0, 1, NULL, NULL);
      INSERT INTO deliveries VALUES ('legacy-delivery', 'legacy-key', 'https://example.com/legacy', 'legacy-device', 'legacy-device', 'queued', 1, 9999999999999, NULL, NULL);
    `);
    legacy.close();
    const reopened = new LinkSyncDatabase(path);
    assert.equal((reopened.raw.prepare("PRAGMA table_info(devices)").all() as Array<{ name: string }>).some((column) => column.name === "removed_at"), true);
    assert.deepEqual(reopened.raw.prepare("SELECT token_hash FROM devices WHERE id = ?").get("legacy-device"), { token_hash: "hash" });
    assert.deepEqual(reopened.raw.prepare("SELECT id, idempotency_key, url, status, created_at, expires_at FROM deliveries WHERE id = ?").get("legacy-delivery"), {
      id: "legacy-delivery", idempotency_key: "legacy-key", url: "https://example.com/legacy", status: "queued", created_at: 1, expires_at: 9999999999999
    });
    assert.deepEqual(reopened.raw.prepare("SELECT delivery_id, status, url FROM delivery_receipts WHERE idempotency_key = ?").get("legacy-key"), {
      delivery_id: "legacy-delivery", status: "queued", url: "https://example.com/legacy"
    });
    reopened.close();
  });
});

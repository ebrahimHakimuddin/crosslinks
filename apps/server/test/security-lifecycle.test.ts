import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { LinkSyncDatabase } from "../src/database.js";
import type { Config } from "../src/config.js";

type Fixture = { app: FastifyInstance; db: LinkSyncDatabase; config: Config; cookie: string; password: string };

async function fixture(overrides: Partial<Config> = {}, options: Record<string, unknown> = {}): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), "linksync-security-test-"));
  const config: Config = { host: "127.0.0.1", port: 0, databasePath: join(directory, "linksync.db"), publicUrl: "http://localhost:8787", setupToken: "fixture-setup-token", secureCookies: false, deliveryTtlMs: 60_000, historyTtlMs: 60_000, pairingTtlMs: 60_000, ...overrides };
  const db = new LinkSyncDatabase(config.databasePath);
  const app = await buildApp({ config, database: db, ...options });
  const password = "a sufficiently long fixture password";
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/setup", payload: { token: config.setupToken, password } })).statusCode, 201);
  const login = await app.inject({ method: "POST", url: "/api/v1/admin/login", payload: { password } });
  return { app, db, config, password, cookie: login.headers["set-cookie"]!.split(";")[0]! };
}

async function pair(f: Fixture, kind: "android" | "chrome", name: string) {
  const grant = await f.app.inject({ method: "POST", url: "/api/v1/admin/pairings", headers: { cookie: f.cookie }, payload: { deviceKind: kind } });
  return (await f.app.inject({ method: "POST", url: "/api/v1/pair", payload: { code: grant.json<{ code: string }>().code, name, deviceKind: kind } })).json<{ deviceId: string; token: string }>();
}

async function close(f: Fixture) { await f.app.close(); }

describe("security and lifecycle regressions", () => {
  const fixtures: Fixture[] = [];
  after(async () => { for (const f of fixtures) if (!f.app.server.listening) continue; else await f.app.close(); });

  it("invalid admin origin and unauthenticated remove are rejected", async () => {
    const f = await fixture(); fixtures.push(f);
    assert.equal((await f.app.inject({ method: "GET", url: "/api/v1/admin/devices", headers: { cookie: f.cookie, origin: "https://evil.example" } })).statusCode, 403);
    assert.equal((await f.app.inject({ method: "DELETE", url: "/api/v1/admin/devices/nope/remove" })).statusCode, 401);
    await close(f);
  });

  it("expired and reused pairing codes are denied", async () => {
    const f = await fixture(); fixtures.push(f);
    const grant = await f.app.inject({ method: "POST", url: "/api/v1/admin/pairings", headers: { cookie: f.cookie }, payload: { deviceKind: "chrome" } });
    f.db.raw.prepare("UPDATE pairing_grants SET expires_at = 0").run();
    assert.equal((await f.app.inject({ method: "POST", url: "/api/v1/pair", payload: { code: grant.json<{ code: string }>().code, name: "expired", deviceKind: "chrome" } })).statusCode, 403);
    const live = await f.app.inject({ method: "POST", url: "/api/v1/admin/pairings", headers: { cookie: f.cookie }, payload: { deviceKind: "chrome" } });
    const body = { code: live.json<{ code: string }>().code, name: "once", deviceKind: "chrome" };
    assert.equal((await f.app.inject({ method: "POST", url: "/api/v1/pair", payload: body })).statusCode, 201);
    assert.equal((await f.app.inject({ method: "POST", url: "/api/v1/pair", payload: body })).statusCode, 403);
    await close(f);
  });

  it("login limit recovers and concurrent verifier slots are released", async () => {
    const f = await fixture({}, { loginFailureWindowMs: 100, verifyPassword: async (_hash, password) => { if (password === "wrong") { await new Promise((resolve) => setTimeout(resolve, 10)); throw new Error("verifier failure"); } return true; } }); fixtures.push(f);
    const concurrent = await Promise.all(Array.from({ length: 3 }, () => f.app.inject({ method: "POST", url: "/api/v1/admin/login", payload: { password: "wrong" } })));
    assert.equal(concurrent.filter((response) => response.statusCode === 429).length, 1);
    await new Promise((resolve) => setTimeout(resolve, 110));
    const recovered = await f.app.inject({ method: "POST", url: "/api/v1/admin/login", payload: { password: "wrong" } });
    assert.equal(recovered.statusCode, 500);
    await close(f);
  });

  it("login failures reach five attempts, lock out, and recover", async () => {
    const f = await fixture({}, { loginFailureWindowMs: 300 }); fixtures.push(f);
    for (let i = 0; i < 5; i += 1) assert.equal((await f.app.inject({ method: "POST", url: "/api/v1/admin/login", payload: { password: "wrong" } })).statusCode, 401);
    assert.equal((await f.app.inject({ method: "POST", url: "/api/v1/admin/login", payload: { password: "wrong" } })).statusCode, 429);
    await new Promise((resolve) => setTimeout(resolve, 310));
    assert.equal((await f.app.inject({ method: "POST", url: "/api/v1/admin/login", payload: { password: "wrong" } })).statusCode, 401);
    await close(f);
  });

  it("trusted proxy clients are independent and untrusted forwarded addresses cannot spoof the bucket", async () => {
    const trusted = await fixture({ trustedProxyCidrs: ["127.0.0.1"] }, { loginFailureWindowMs: 300 }); fixtures.push(trusted);
    const attempt = (xff: string) => trusted.app.inject({ method: "POST", url: "/api/v1/admin/login", headers: { "x-forwarded-for": xff }, payload: { password: "wrong" } });
    for (let i = 0; i < 5; i += 1) assert.equal((await attempt("10.0.0.1")).statusCode, 401);
    for (let i = 0; i < 5; i += 1) assert.equal((await attempt("10.0.0.2")).statusCode, 401);
    assert.equal((await attempt("10.0.0.1")).statusCode, 429);
    assert.equal((await attempt("10.0.0.2")).statusCode, 429);
    await close(trusted);
    const untrusted = await fixture({}, { loginFailureWindowMs: 300 }); fixtures.push(untrusted);
    const forged = (xff: string) => untrusted.app.inject({ method: "POST", url: "/api/v1/admin/login", headers: { "x-forwarded-for": xff }, payload: { password: "wrong" } });
    for (let i = 0; i < 5; i += 1) assert.equal((await forged(`10.0.0.${i + 1}`)).statusCode, 401);
    assert.equal((await forged("10.0.0.99")).statusCode, 429);
    await close(untrusted);
  });

  it("cross-device ACK and source/target delivery reads are denied", async () => {
    const f = await fixture(); fixtures.push(f);
    const android = await pair(f, "android", "source"); const target = await pair(f, "chrome", "target"); const other = await pair(f, "chrome", "other");
    const created = await f.app.inject({ method: "POST", url: "/api/v1/deliveries", headers: { authorization: `Bearer ${android.token}` }, payload: { url: "https://example.com/x", targetDeviceId: target.deviceId, idempotencyKey: "x" } });
    const id = created.json<{ id: string }>().id;
    assert.equal((await f.app.inject({ method: "GET", url: `/api/v1/deliveries/${id}`, headers: { authorization: `Bearer ${other.token}` } })).statusCode, 404);
    assert.equal((await f.app.inject({ method: "POST", url: `/api/v1/deliveries/${id}/ack`, headers: { authorization: `Bearer ${other.token}` }, payload: { status: "delivered" } })).statusCode, 404);
    assert.equal((await f.app.inject({ method: "GET", url: `/api/v1/deliveries/${id}`, headers: { authorization: `Bearer ${target.token}` } })).statusCode, 200);
    await close(f);
  });

  it("revoked devices lose article access", async () => {
    const f = await fixture(); fixtures.push(f);
    const device = await pair(f, "android", "article device");
    const body = { url: "https://example.com/article", title: "title", list: "saved", snippet: "snippet", progress: 0, savedAt: Date.now() };
    assert.equal((await f.app.inject({ method: "PUT", url: "/api/v1/articles/revoked", headers: { authorization: `Bearer ${device.token}` }, payload: body })).statusCode, 200);
    assert.equal((await f.app.inject({ method: "DELETE", url: `/api/v1/admin/devices/${device.deviceId}`, headers: { cookie: f.cookie } })).statusCode, 204);
    assert.equal((await f.app.inject({ method: "GET", url: "/api/v1/articles", headers: { authorization: `Bearer ${device.token}` } })).statusCode, 401);
    await close(f);
  });

  it("article validation rejects unsafe URLs, credentials, bounds, progress, and timestamps", async () => {
    const f = await fixture(); fixtures.push(f);
    const device = await pair(f, "android", "validation device");
    const base = { url: "https://example.com/article", title: "title", list: "saved", snippet: "snippet", progress: 0, savedAt: Date.now() };
    const invalid = [
      { ...base, url: "javascript:alert(1)" }, { ...base, url: "https://user:pass@example.com" },
      { ...base, title: "x".repeat(301) }, { ...base, list: "x".repeat(61) }, { ...base, snippet: "x".repeat(501) },
      { ...base, progress: Number.NaN }, { ...base, progress: 2 }, { ...base, savedAt: Number.MAX_SAFE_INTEGER + 1 }, { ...base, readAt: -1 }
    ];
    for (const payload of invalid) assert.equal((await f.app.inject({ method: "PUT", url: "/api/v1/articles/invalid", headers: { authorization: `Bearer ${device.token}` }, payload })).statusCode, 400);
    await close(f);
  });

  it("late ACK expires and conflicting ACK is rejected", async () => {
    const f = await fixture(); fixtures.push(f);
    const android = await pair(f, "android", "source"); const target = await pair(f, "chrome", "target");
    const created = await f.app.inject({ method: "POST", url: "/api/v1/deliveries", headers: { authorization: `Bearer ${android.token}` }, payload: { url: "https://example.com/x", targetDeviceId: target.deviceId, idempotencyKey: "late" } });
    const id = created.json<{ id: string }>().id; f.db.raw.prepare("UPDATE deliveries SET expires_at = 0 WHERE id = ?").run(id);
    assert.equal((await f.app.inject({ method: "POST", url: `/api/v1/deliveries/${id}/ack`, headers: { authorization: `Bearer ${target.token}` }, payload: { status: "delivered" } })).statusCode, 409);
    const second = await f.app.inject({ method: "POST", url: "/api/v1/deliveries", headers: { authorization: `Bearer ${android.token}` }, payload: { url: "https://example.com/y", targetDeviceId: target.deviceId, idempotencyKey: "conflict" } });
    const secondId = second.json<{ id: string }>().id;
    assert.equal((await f.app.inject({ method: "POST", url: `/api/v1/deliveries/${secondId}/ack`, headers: { authorization: `Bearer ${target.token}` }, payload: { status: "delivered" } })).statusCode, 200);
    assert.equal((await f.app.inject({ method: "POST", url: `/api/v1/deliveries/${secondId}/ack`, headers: { authorization: `Bearer ${target.token}` }, payload: { status: "failed" } })).statusCode, 409);
    await close(f);
  });

  it("history maintenance strips receipt metadata and preserves unexpired queued deliveries", async () => {
    const f = await fixture({ deliveryTtlMs: 500, historyTtlMs: 20 }, { maintenanceIntervalMs: 10 }); fixtures.push(f);
    const android = await pair(f, "android", "source"); const target = await pair(f, "chrome", "target");
    const created = await f.app.inject({ method: "POST", url: "/api/v1/deliveries", headers: { authorization: `Bearer ${android.token}` }, payload: { url: "https://example.com/x", targetDeviceId: target.deviceId, idempotencyKey: "queued" } });
    const id = created.json<{ id: string }>().id;
    f.db.raw.prepare("UPDATE delivery_receipts SET created_at = ?, url = ?, failure_reason = ? WHERE delivery_id = ?").run(Date.now() - 30, "https://secret.example", "secret", id);
    const finalized = await f.app.inject({ method: "POST", url: "/api/v1/deliveries", headers: { authorization: `Bearer ${android.token}` }, payload: { url: "https://example.com/finalized", targetDeviceId: target.deviceId, idempotencyKey: "periodic-finalized" } });
    const finalizedId = finalized.json<{ id: string }>().id;
    assert.equal((await f.app.inject({ method: "POST", url: `/api/v1/deliveries/${finalizedId}/ack`, headers: { authorization: `Bearer ${target.token}` }, payload: { status: "delivered" } })).statusCode, 200);
    f.db.raw.prepare("UPDATE deliveries SET created_at = ? WHERE id = ?").run(Date.now() - 30, finalizedId);
    f.db.raw.prepare("UPDATE delivery_receipts SET created_at = ?, url = ?, failure_reason = ? WHERE delivery_id = ?").run(Date.now() - 30, "https://secret.finalized", "secret-finalized", finalizedId);
    await new Promise((resolve) => setTimeout(resolve, 35));
    const receipt = f.db.raw.prepare("SELECT url, failure_reason, status FROM delivery_receipts WHERE delivery_id = ?").get(id) as Record<string, unknown>;
    assert.equal(receipt.url, null); assert.equal(receipt.failure_reason, null); assert.equal(receipt.status, "queued");
    assert.equal(f.db.raw.prepare("SELECT id FROM deliveries WHERE id = ?").get(finalizedId), undefined);
    await close(f);
  });

  it("bulk history clear preserves queued delivery and receipt pairs while scrubbing finalized metadata", async () => {
    const f = await fixture({ deliveryTtlMs: 500 }); fixtures.push(f);
    const android = await pair(f, "android", "source"); const target = await pair(f, "chrome", "target");
    const queued = await f.app.inject({ method: "POST", url: "/api/v1/deliveries", headers: { authorization: `Bearer ${android.token}` }, payload: { url: "https://example.com/queued", targetDeviceId: target.deviceId, idempotencyKey: "bulk-q" } });
    const finalized = await f.app.inject({ method: "POST", url: "/api/v1/deliveries", headers: { authorization: `Bearer ${android.token}` }, payload: { url: "https://example.com/final", targetDeviceId: target.deviceId, idempotencyKey: "bulk-f" } });
    const finalizedId = finalized.json<{ id: string }>().id;
    assert.equal((await f.app.inject({ method: "POST", url: `/api/v1/deliveries/${finalizedId}/ack`, headers: { authorization: `Bearer ${target.token}` }, payload: { status: "delivered" } })).statusCode, 200);
    assert.equal((await f.app.inject({ method: "DELETE", url: "/api/v1/admin/deliveries", headers: { cookie: f.cookie } })).statusCode, 204);
    const queuedId = queued.json<{ id: string }>().id;
    const queuedReceipt = f.db.raw.prepare("SELECT status, url, failure_reason FROM delivery_receipts WHERE delivery_id = ?").get(queuedId) as Record<string, unknown>;
    assert.equal(queuedReceipt.status, "queued"); assert.equal(queuedReceipt.url, "https://example.com/queued");
    const finalizedReceipt = f.db.raw.prepare("SELECT status, url, failure_reason FROM delivery_receipts WHERE delivery_id = ?").get(finalizedId) as Record<string, unknown>;
    assert.equal(finalizedReceipt.status, "delivered"); assert.equal(finalizedReceipt.url, null); assert.equal(finalizedReceipt.failure_reason, null);
    const replay = await f.app.inject({ method: "POST", url: "/api/v1/deliveries", headers: { authorization: `Bearer ${android.token}` }, payload: { url: "https://example.com/final", targetDeviceId: target.deviceId, idempotencyKey: "bulk-f" } });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json<{ id: string; status: string }>().id, finalizedId);
    assert.equal(replay.json<{ status: string }>().status, "delivered");
    assert.equal((await f.app.inject({ method: "GET", url: "/api/v1/deliveries/next", headers: { authorization: `Bearer ${target.token}` } })).json<{ id: string }>().id, queuedId);
    assert.equal((await f.app.inject({ method: "POST", url: `/api/v1/deliveries/${queuedId}/ack`, headers: { authorization: `Bearer ${target.token}` }, payload: { status: "delivered" } })).statusCode, 200);
    await close(f);
  });

  it("restarts with retention boundaries while preserving delivered idempotency receipts", async () => {
    const f = await fixture({ deliveryTtlMs: 100, historyTtlMs: 1_000 }); fixtures.push(f);
    const android = await pair(f, "android", "restart source"); const target = await pair(f, "chrome", "restart target");
    const retained = await f.app.inject({ method: "POST", url: "/api/v1/deliveries", headers: { authorization: `Bearer ${android.token}` }, payload: { url: "https://example.com/retained", targetDeviceId: target.deviceId, idempotencyKey: "restart-retained" } });
    const retainedId = retained.json<{ id: string }>().id;
    assert.equal((await f.app.inject({ method: "POST", url: `/api/v1/deliveries/${retainedId}/ack`, headers: { authorization: `Bearer ${target.token}` }, payload: { status: "delivered" } })).statusCode, 200);
    const deliveredAt = (f.db.raw.prepare("SELECT delivered_at FROM deliveries WHERE id = ?").get(retainedId) as { delivered_at: number }).delivered_at;
    const purged = await f.app.inject({ method: "POST", url: "/api/v1/deliveries", headers: { authorization: `Bearer ${android.token}` }, payload: { url: "https://example.com/purged", targetDeviceId: target.deviceId, idempotencyKey: "restart-purged" } });
    const purgedId = purged.json<{ id: string }>().id;
    assert.equal((await f.app.inject({ method: "POST", url: `/api/v1/deliveries/${purgedId}/ack`, headers: { authorization: `Bearer ${target.token}` }, payload: { status: "delivered" } })).statusCode, 200);
    const retainedAt = Date.now() - 1_010;
    const purgedAt = Date.now() - 1_200;
    f.db.raw.prepare("UPDATE deliveries SET created_at = ? WHERE id = ?").run(retainedAt, retainedId);
    f.db.raw.prepare("UPDATE delivery_receipts SET created_at = ?, url = ?, failure_reason = ? WHERE delivery_id = ?").run(retainedAt, "https://secret.retained", "secret-retained", retainedId);
    f.db.raw.prepare("UPDATE deliveries SET created_at = ? WHERE id = ?").run(purgedAt, purgedId);
    f.db.raw.prepare("UPDATE delivery_receipts SET created_at = ? WHERE delivery_id = ?").run(purgedAt, purgedId);
    await close(f);

    const db = new LinkSyncDatabase(f.config.databasePath);
    const restarted = await buildApp({ config: f.config, database: db });
    const login = await restarted.inject({ method: "POST", url: "/api/v1/admin/login", payload: { password: f.password } });
    const cookie = login.headers["set-cookie"]!.split(";")[0]!;
    assert.equal(db.raw.prepare("SELECT id FROM deliveries WHERE id = ?").get(retainedId), undefined);
    assert.deepEqual(db.raw.prepare("SELECT url, failure_reason, status FROM delivery_receipts WHERE delivery_id = ?").get(retainedId), { url: null, failure_reason: null, status: "delivered" });
    assert.equal(db.raw.prepare("SELECT delivery_id FROM delivery_receipts WHERE delivery_id = ?").get(purgedId), undefined);
    const replay = await restarted.inject({ method: "POST", url: "/api/v1/deliveries", headers: { authorization: `Bearer ${android.token}` }, payload: { url: "https://example.com/retained", targetDeviceId: target.deviceId, idempotencyKey: "restart-retained" } });
    assert.equal(replay.statusCode, 200);
    assert.deepEqual(replay.json<{ id: string; status: string }>(), { id: retainedId, status: "delivered", target_device_id: target.deviceId, created_at: retainedAt, expires_at: retained.json<{ expires_at: number }>().expires_at, delivered_at: deliveredAt, failure_reason: null, url: "https://example.com/retained", source_device_id: android.deviceId });
    assert.deepEqual(db.raw.prepare("SELECT COUNT(*) AS count FROM deliveries WHERE source_device_id = ? AND idempotency_key = ?").get(android.deviceId, "restart-retained"), { count: 0 });
    assert.equal((await restarted.inject({ method: "GET", url: "/api/v1/admin/deliveries", headers: { cookie } })).statusCode, 200);
    await restarted.close();
  });

  it("receipt update failure rolls back both delivery tables", async () => {
    const f = await fixture(); fixtures.push(f);
    const android = await pair(f, "android", "source"); const target = await pair(f, "chrome", "target");
    const created = await f.app.inject({ method: "POST", url: "/api/v1/deliveries", headers: { authorization: `Bearer ${android.token}` }, payload: { url: "https://example.com/x", targetDeviceId: target.deviceId, idempotencyKey: "abort" } });
    const id = created.json<{ id: string }>().id;
    f.db.raw.exec("CREATE TRIGGER abort_receipt AFTER UPDATE ON delivery_receipts BEGIN SELECT RAISE(ABORT, 'test'); END");
    assert.equal((await f.app.inject({ method: "POST", url: `/api/v1/deliveries/${id}/ack`, headers: { authorization: `Bearer ${target.token}` }, payload: { status: "delivered" } })).statusCode, 500);
    assert.equal((f.db.raw.prepare("SELECT status FROM deliveries WHERE id = ?").get(id) as { status: string }).status, "queued");
    assert.equal((f.db.raw.prepare("SELECT status FROM delivery_receipts WHERE delivery_id = ?").get(id) as { status: string }).status, "queued");
    f.db.raw.exec("DROP TRIGGER abort_receipt");
    assert.equal((await f.app.inject({ method: "POST", url: `/api/v1/deliveries/${id}/ack`, headers: { authorization: `Bearer ${target.token}` }, payload: { status: "delivered" } })).statusCode, 200);
    await close(f);
    const reopened = new LinkSyncDatabase(f.config.databasePath);
    assert.equal((reopened.raw.prepare("SELECT status FROM deliveries WHERE id = ?").get(id) as { status: string }).status, "delivered");
    assert.equal((reopened.raw.prepare("SELECT status FROM delivery_receipts WHERE delivery_id = ?").get(id) as { status: string }).status, "delivered");
    reopened.close();
  });

  it("malformed and oversized live messages close only their socket, while a healthy socket heartbeats and receives notifications", async () => {
    const f = await fixture(); fixtures.push(f);
    const chrome = await pair(f, "chrome", "live browser");
    await f.app.listen({ host: "127.0.0.1", port: 0 });
    const address = f.app.server.address();
    assert.ok(address && typeof address !== "string");
    const endpoint = `ws://127.0.0.1:${address.port}/api/v1/live`;
    const closeCode = async (payload: string): Promise<number> => {
      const socket = new WebSocket(endpoint);
      await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve()); socket.addEventListener("error", () => reject(new Error("socket error"))); });
      socket.send(payload);
      return await new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
    };
    const healthy = new WebSocket(endpoint);
    const messages: string[] = [];
    healthy.addEventListener("message", (event) => messages.push(String(event.data)));
    await new Promise<void>((resolve, reject) => { healthy.addEventListener("open", () => resolve()); healthy.addEventListener("error", () => reject(new Error("socket error"))); });
    healthy.send(JSON.stringify({ type: "authenticate", token: chrome.token }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    for (const payload of ["null", "[]", "1", "not-json"]) assert.ok((await closeCode(payload)) >= 4000);
    assert.equal(await closeCode(JSON.stringify({ type: "authenticate", token: "x" }).repeat(2_000)), 1009);
    healthy.send(JSON.stringify({ type: "heartbeat" }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(messages.some((message) => message.includes("heartbeat_ack")));
    const android = await pair(f, "android", "notify source");
    const created = await f.app.inject({ method: "POST", url: "/api/v1/deliveries", headers: { authorization: `Bearer ${android.token}` }, payload: { url: "https://example.com/live", targetDeviceId: chrome.deviceId, idempotencyKey: "live" } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(messages.some((message) => message.includes(created.json<{ id: string }>().id)));
    healthy.close();
    await close(f);
  });

  it("revocation and removal close live sockets and deny reconnect", async () => {
    const f = await fixture(); fixtures.push(f);
    const revoked = await pair(f, "chrome", "revoked live");
    await f.app.listen({ host: "127.0.0.1", port: 0 });
    const address = f.app.server.address(); assert.ok(address && typeof address !== "string");
    const endpoint = `ws://127.0.0.1:${address.port}/api/v1/live`;
    const connect = async (token: string) => {
      const socket = new WebSocket(endpoint);
      await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve()); socket.addEventListener("error", () => reject(new Error("socket error"))); });
      socket.send(JSON.stringify({ type: "authenticate", token }));
      return socket;
    };
    const socket = await connect(revoked.token);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
    assert.equal((await f.app.inject({ method: "DELETE", url: `/api/v1/admin/devices/${revoked.deviceId}`, headers: { cookie: f.cookie } })).statusCode, 204);
    assert.equal(await closed, 4003);
    const denied = await connect(revoked.token);
    assert.equal(await new Promise<number>((resolve) => denied.addEventListener("close", (event) => resolve(event.code))), 4003);
    denied.close();
    const removed = await pair(f, "chrome", "removed live");
    const removedSocket = await connect(removed.token);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const removedClosed = new Promise<number>((resolve) => removedSocket.addEventListener("close", (event) => resolve(event.code)));
    const android = await pair(f, "android", "removal source");
    const delivery = await f.app.inject({ method: "POST", url: "/api/v1/deliveries", headers: { authorization: `Bearer ${android.token}` }, payload: { url: "https://example.com/remove", targetDeviceId: removed.deviceId, idempotencyKey: "remove-live" } });
    assert.equal((await f.app.inject({ method: "DELETE", url: `/api/v1/admin/devices/${removed.deviceId}/remove`, headers: { cookie: f.cookie } })).statusCode, 204);
    assert.equal(await removedClosed, 4003);
    const listed = await f.app.inject({ method: "GET", url: "/api/v1/admin/devices", headers: { cookie: f.cookie } });
    assert.equal(listed.json<Array<{ id: string }>>().some((device) => device.id === removed.deviceId), false);
    const history = await f.app.inject({ method: "GET", url: "/api/v1/history", headers: { authorization: `Bearer ${android.token}` } });
    assert.equal(history.json<Array<{ id: string }>>().some((item) => item.id === delivery.json<{ id: string }>().id), true);
    const removedDenied = await connect(removed.token);
    assert.equal(await new Promise<number>((resolve) => removedDenied.addEventListener("close", (event) => resolve(event.code))), 4003);
    removedDenied.close();
    await close(f);
  });
});

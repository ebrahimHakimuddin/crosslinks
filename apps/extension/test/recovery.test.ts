import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

type Store = Record<string, unknown>;
const sync: Store = {};
const local: Store = {};
let syncSetFailures = 0;
let fetchCalls: Array<{ path: string; body?: string }> = [];
let tabsCreated = 0;

function event() {
  return { addListener() {} };
}
function installChrome(): void {
  (globalThis as { WebSocket?: unknown }).WebSocket = undefined;
  const area = (store: Store, quota = 100_000) => ({
    QUOTA_BYTES: quota,
    async get(keys?: string | null | string[]) {
      if (keys == null) return { ...store };
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(
        names
          .map((key) => [key, store[key]])
          .filter(([, value]) => value !== undefined),
      );
    },
    async set(values: Store) {
      if (store === sync && syncSetFailures-- > 0)
        throw new Error("QUOTA_BYTES");
      Object.assign(store, values);
    },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
    },
    async getBytesInUse() {
      return JSON.stringify(store).length;
    },
  });
  const chrome = {
    storage: { sync: area(sync), local: area(local), onChanged: event() },
    runtime: {
      getURL: (value: string) => value,
      onInstalled: event(),
      onStartup: event(),
      onMessage: event(),
      openOptionsPage() {},
    },
    tabs: {
      async create() {
        tabsCreated++;
        return {};
      },
    },
    scripting: {
      async executeScript() {
        return [];
      },
    },
    notifications: { async create() {}, async clear() {}, onClicked: event() },
    contextMenus: { async removeAll() {}, create() {}, onClicked: event() },
    commands: {
      onCommand: event(),
      async getAll() {
        return [];
      },
    },
    alarms: { async create() {}, onAlarm: event() },
    permissions: {
      async request() {
        return true;
      },
      async remove() {},
    },
    action: { async setBadgeText() {} },
  };
  (globalThis as { chrome?: unknown }).chrome = chrome;
}

function article(id: string, url = `https://example.test/${id}`) {
  return {
    id,
    url,
    title: id,
    list: "Reading list",
    snippet: "",
    progress: 0,
    savedAt: 1,
  };
}

describe("library recovery behavior", () => {
  beforeEach(() => {
    for (const key of Object.keys(sync)) delete sync[key];
    for (const key of Object.keys(local)) delete local[key];
    syncSetFailures = 0;
    installChrome();
  });

  it("resumes quota migration and keeps retained articles readable and removable", async () => {
    const { migrateLocalLibrary, getLibrary, removeArticle } = await import(
      "../src/reading.js"
    );
    local.library = {
      lists: ["Reading list"],
      articles: [article("one"), article("two")],
    };
    syncSetFailures = 1;
    const first = await migrateLocalLibrary();
    assert.equal(first.retained, 2);
    assert.equal((await getLibrary()).articles.length, 2);
    await migrateLocalLibrary();
    assert.equal((await getLibrary()).articles.length, 2);
    await removeArticle("one");
    assert.deepEqual(
      (await getLibrary()).articles.map((a) => a.id),
      ["two"],
    );
  });

  it("rejects unsafe backup URLs and merges duplicate URLs without removing existing articles", async () => {
    const { parseImport, importLibrary } = await import("../src/reading.js");
    assert.throws(
      () =>
        parseImport(
          JSON.stringify({
            version: 1,
            lists: [],
            articles: [{ ...article("x"), url: "javascript:alert(1)" }],
          }),
        ),
      /unsafe URLs/,
    );
    sync["a:existing"] = article("existing");
    const report = await importLibrary(
      JSON.stringify({
        version: 1,
        lists: ["Work"],
        articles: [
          article("new", "https://example.test/existing"),
          article("added"),
        ],
      }),
    );
    assert.equal(report.skipped, 1);
    assert.equal(report.imported, 1);
    assert.ok(sync["a:existing"]);
    assert.throws(
      () =>
        parseImport(
          JSON.stringify({
            version: 1,
            lists: [],
            articles: [
              article("same", "https://example.test/a"),
              article("same", "https://example.test/b"),
            ],
          }),
        ),
      /conflicting duplicate/,
    );
    const deduped = await importLibrary(
      JSON.stringify({
        version: 1,
        lists: [],
        articles: [
          article("dupe", "https://example.test/dupe"),
          article("dupe", "https://example.test/dupe"),
          article("other", "https://example.test/dupe"),
        ],
      }),
    );
    assert.equal(deduped.imported, 1);
  });

  it("reports partial import failures honestly", async () => {
    const { importLibrary } = await import("../src/reading.js");
    const originalSet = (globalThis as any).chrome.storage.sync.set;
    let writes = 0;
    (globalThis as any).chrome.storage.sync.set = async (values: Store) => {
      if (
        Object.keys(values).some((key) => key.startsWith("a:")) &&
        writes++ === 1
      )
        throw new Error("temporary write failure");
      Object.assign(sync, values);
    };
    const report = await importLibrary(
      JSON.stringify({
        version: 1,
        lists: [],
        articles: [article("one"), article("two")],
      }),
    );
    assert.equal(report.imported, 2);
    assert.equal(report.failed, 1);
    assert.equal(report.errors.length, 1);
    (globalThis as any).chrome.storage.sync.set = originalSet;
  });
});

describe("delivery replay behavior", () => {
  beforeEach(() => {
    for (const key of Object.keys(sync)) delete sync[key];
    for (const key of Object.keys(local)) delete local[key];
    fetchCalls = [];
    tabsCreated = 0;
    installChrome();
    local.settings = {
      serverUrl: "https://server.test",
      token: "token",
      deviceId: "device",
      deviceName: "Chrome",
      autoOpen: true,
      paused: false,
    };
  });

  it("replays a failed browser operation as failed after an ACK network failure", async () => {
    const { handleDelivery } = await import("../src/background.js");
    let ackAttempts = 0;
    globalThis.fetch = async (input, init) => {
      fetchCalls.push({ path: String(input), body: String(init?.body ?? "") });
      if (++ackAttempts === 1) throw new Error("offline");
      return new Response("{}", { status: 200 });
    };
    (globalThis as any).chrome.tabs.create = async () => {
      throw new Error("tab blocked");
    };
    const delivery = {
      id: "d-fail",
      url: "https://example.test",
      status: "queued",
      created_at: 1,
      expires_at: 2,
    } as any;
    await assert.rejects(() => handleDelivery(delivery), /offline/);
    await handleDelivery(delivery);
    assert.equal(tabsCreated, 0);
    assert.match(fetchCalls.at(-1)?.body ?? "", /failed/);
  });

  it("does not duplicate a successful tab when its delivered ACK is interrupted", async () => {
    const { handleDelivery } = await import("../src/background.js");
    let ackAttempts = 0;
    globalThis.fetch = async () => {
      if (++ackAttempts === 1) throw new Error("offline");
      return new Response("{}", { status: 200 });
    };
    const delivery = {
      id: "d-ok",
      url: "https://example.test",
      status: "queued",
      created_at: 1,
      expires_at: 2,
    } as any;
    await assert.rejects(() => handleDelivery(delivery), /offline/);
    await handleDelivery(delivery);
    assert.equal(tabsCreated, 1);
  });
});

describe("durable server library sync", () => {
  beforeEach(() => {
    for (const key of Object.keys(sync)) delete sync[key];
    for (const key of Object.keys(local)) delete local[key];
    installChrome();
    local.settings = {
      serverUrl: "https://server.test",
      token: "token",
      deviceId: "device",
      deviceName: "Chrome",
      autoOpen: true,
      paused: false,
      sharedSync: true,
    };
  });

  it("keeps failed PUTs queued and skips an already applied revision", async () => {
    const { seedRemoteJournal, syncRemoteLibrary } = await import(
      "../src/reading.js"
    );
    sync["a:one"] = article("one");
    let putAttempts = 0;
    globalThis.fetch = async (input) => {
      const path = String(input);
      if (path.endsWith("/one")) {
        putAttempts++;
        return new Response("{}", { status: putAttempts === 1 ? 503 : 200 });
      }
      return new Response(
        JSON.stringify({
          articles: [{ ...article("remote"), revision: 4, deleted: false }],
        }),
        { status: 200 },
      );
    };
    await seedRemoteJournal();
    const first = await syncRemoteLibrary();
    assert.match(first.error ?? "", /failed/);
    const second = await syncRemoteLibrary();
    assert.equal(second.error, undefined);
    assert.equal(putAttempts, 2);
    const third = await syncRemoteLibrary();
    assert.equal(third.pulled, 0);
  });
});

describe("background-owned library RPC", () => {
  beforeEach(() => {
    for (const key of Object.keys(sync)) delete sync[key];
    for (const key of Object.keys(local)) delete local[key];
    installChrome();
  });

  it("fails closed when the coordinator RPC is unavailable", async () => {
    const { updateArticle } = await import("../src/reading.js");
    sync["a:one"] = article("one");
    (globalThis as any).chrome.runtime.sendMessage = async () => ({
      ok: false,
      message: "worker unavailable",
    });
    await assert.rejects(
      () => updateArticle("one", { title: "changed" }),
      /worker unavailable/,
    );
    assert.equal((sync["a:one"] as any).title, "one");
  });

  it("does not apply a response after the captured account changes", async () => {
    const { apiFetchWithSettings, settingsMatch } = await import(
      "../src/shared.js"
    );
    local.settings = {
      serverUrl: "https://server-a.test",
      token: "a",
      deviceId: "a-device",
      deviceName: "Chrome",
      autoOpen: true,
      paused: false,
      sharedSync: true,
    };
    const snapshot = { ...(local.settings as any) };
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = async () => {
      await paused;
      return new Response("{}", { status: 200 });
    };
    const request = apiFetchWithSettings(snapshot, "/api/v1/articles");
    local.settings = {
      ...snapshot,
      serverUrl: "https://server-b.test",
      token: "b",
      deviceId: "b-device",
    };
    release();
    await request;
    assert.equal(await settingsMatch(snapshot), false);
  });
});

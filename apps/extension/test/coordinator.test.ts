import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

type Store = Record<string, unknown>;
type Listener<T extends (...args: any[]) => any> = T;

const sync: Store = {};
const local: Store = {};
const pendingTasks = new Set<Promise<unknown>>();
const events: Record<
  string,
  {
    addListener(listener: (...args: any[]) => any): void;
    dispatch(...args: any[]): void;
  }
> = {};
const calls: Array<{ url: string; method: string; body?: string }> = [];
let fetchImpl: (
  url: string,
  init?: RequestInit,
) => Promise<Response> = async () => new Response("{}", { status: 200 });
let syncSetError: Error | undefined;
let syncSetErrorWhen: ((values: Store) => boolean) | undefined;
let syncSetAlwaysError: Error | undefined;
let syncRemoveError: Error | undefined;
let localSetError: Error | undefined;
let tabCreated = 0;
let menuClicks: Array<{ info: any; tab: any }> = [];

function track<T>(promise: Promise<T>): Promise<T> {
  pendingTasks.add(promise);
  void promise.finally(() => pendingTasks.delete(promise));
  return promise;
}

function event(name: string) {
  const listeners: Array<(...args: any[]) => any> = [];
  const value = {
    addListener(listener: (...args: any[]) => any) {
      listeners.push(listener);
    },
    dispatch(...args: any[]) {
      for (const listener of [...listeners])
        track(Promise.resolve(listener(...args)));
    },
  };
  events[name] = value;
  return value;
}

function area(store: Store, name: "sync" | "local", quota = 100_000) {
  return {
    QUOTA_BYTES: quota,
    async get(keys?: string | string[] | null) {
      if (keys == null) return { ...store };
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(
        names.filter((key) => key in store).map((key) => [key, store[key]]),
      );
    },
    async set(values: Store) {
      if (name === "local" && localSetError) {
        const error = localSetError;
        localSetError = undefined;
        throw error;
      }
      if (
        name === "sync" &&
        syncSetAlwaysError &&
        (!syncSetErrorWhen || syncSetErrorWhen(values))
      ) {
        throw syncSetAlwaysError;
      }
      if (
        name === "sync" &&
        syncSetError &&
        (!syncSetErrorWhen || syncSetErrorWhen(values))
      ) {
        const error = syncSetError;
        syncSetError = undefined;
        syncSetErrorWhen = undefined;
        throw error;
      }
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const [key, value] of Object.entries(values))
        changes[key] = { oldValue: store[key], newValue: value };
      Object.assign(store, values);
      queueMicrotask(() => events[`${name}Changed`]?.dispatch(changes, name));
    },
    async remove(keys: string | string[]) {
      if (name === "sync" && syncRemoveError) {
        const error = syncRemoveError;
        syncRemoveError = undefined;
        throw error;
      }
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (!(key in store)) continue;
        changes[key] = { oldValue: store[key], newValue: undefined };
        delete store[key];
      }
      if (Object.keys(changes).length)
        queueMicrotask(() => events[`${name}Changed`]?.dispatch(changes, name));
    },
    async getBytesInUse() {
      return JSON.stringify(store).length;
    },
  };
}

function installChrome(): void {
  (globalThis as any).WebSocket = undefined;
  for (const key of [
    "syncChanged",
    "localChanged",
    "runtimeMessage",
    "commands",
    "contextMenus",
    "notifications",
    "alarms",
    "onInstalled",
    "onStartup",
  ])
    event(key);
  const menus: any[] = [];
  const chrome = {
    storage: {
      sync: area(sync, "sync"),
      local: area(local, "local"),
      onChanged: events.syncChanged,
    },
    runtime: {
      getURL: (value: string) => value,
      onInstalled: events.onInstalled,
      onStartup: events.onStartup,
      onMessage: events.runtimeMessage,
      openOptionsPage() {},
      sendMessage(message: unknown) {
        return new Promise((resolve) => {
          let settled = false;
          const sendResponse = (response: unknown) => {
            if (!settled) {
              settled = true;
              resolve(response);
            }
          };
          for (const listener of (events.runtimeMessage as any).listeners ?? [])
            listener(message, {}, sendResponse);
          // The background listener returns true and resolves this promise later.
        });
      },
    },
    tabs: {
      async create() {
        tabCreated++;
        return {};
      },
    },
    scripting: {
      async executeScript() {
        return [{ result: { snippet: "", progress: 0 } }];
      },
    },
    notifications: {
      async create() {},
      async clear() {},
      onClicked: events.notifications,
    },
    contextMenus: {
      async removeAll() {
        menus.length = 0;
      },
      create(value: any) {
        menus.push(value);
      },
      onClicked: events.contextMenus,
    },
    commands: {
      onCommand: events.commands,
      async getAll() {
        return [];
      },
    },
    alarms: { async create() {}, onAlarm: events.alarms },
    permissions: {
      async request() {
        return true;
      },
      async remove() {},
    },
    action: { async setBadgeText() {} },
  };
  // Keep listener lists available to the runtime promise bridge.
  for (const value of Object.values(events))
    Object.defineProperty(value, "listeners", { value: [], writable: true });
  for (const name of [
    "runtimeMessage",
    "commands",
    "contextMenus",
    "notifications",
    "alarms",
    "onInstalled",
    "onStartup",
  ]) {
    const target = events[name]!;
    const original = target.addListener;
    target.addListener = (listener) => {
      (target as any).listeners.push(listener);
      original.call(target, listener);
    };
  }
  (globalThis as any).chrome = chrome;
}

function article(id: string, title = id) {
  return {
    id,
    url: `https://example.test/${id}`,
    title,
    list: "Reading list",
    snippet: "",
    progress: 0,
    savedAt: Date.now(),
  };
}
function settings(account = "a", sharedSync = true) {
  return {
    serverUrl: `https://${account}.example.test`,
    token: account,
    deviceId: `device-${account}`,
    deviceName: "Chrome",
    autoOpen: false,
    paused: false,
    sharedSync,
  };
}
async function flush(): Promise<void> {
  for (let pass = 0; pass < 30; pass++) {
    await Promise.resolve();
    if (!pendingTasks.size) return;
    await Promise.allSettled([...pendingTasks]);
  }
  throw new Error("coordinator tasks did not settle");
}
async function waitUntil(check: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

installChrome();
const reading = await import("../src/reading.js");
await import("../src/background.js");

beforeEach(() => {
  for (const key of Object.keys(sync)) delete sync[key];
  for (const key of Object.keys(local)) delete local[key];
  calls.length = 0;
  tabCreated = 0;
  menuClicks = [];
  syncSetError = undefined;
  syncRemoveError = undefined;
  syncSetAlwaysError = undefined;
  localSetError = undefined;
  syncSetErrorWhen = undefined;
  fetchImpl = async () => new Response("{}", { status: 200 });
  (globalThis as any).fetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push(
      body === undefined
        ? { url, method: init?.method ?? "GET" }
        : { url, method: init?.method ?? "GET", body },
    );
    return fetchImpl(url, init);
  };
});

describe("Chrome coordinator RPC and event regressions", () => {
  it("runs save, update, read, remove and export through the real runtime listener", async () => {
    local.settings = settings("a", false);
    const saved = await reading.saveTab(
      {
        id: 7,
        url: "https://example.test/page",
        title: "Page",
      } as chrome.tabs.Tab,
      "Reading list",
    );
    await reading.updateArticle(saved.id, { title: "Changed" });
    assert.equal((await reading.getLibrary()).articles[0]?.title, "Changed");
    const backup = JSON.parse(await reading.exportLibrary()) as {
      articles: unknown[];
    };
    assert.equal(backup.articles.length, 1);
    await reading.removeArticle(saved.id);
    assert.equal((await reading.getLibrary()).articles.length, 0);
  });

  it("preserves a newer local edit when an older blocked GET completes", async () => {
    local.settings = settings("a");
    sync["a:one"] = article("one", "old");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    fetchImpl = async (url) => {
      if (url.endsWith("/api/v1/articles")) {
        await blocked;
        return new Response(
          JSON.stringify({
            articles: [{ ...article("one", "remote"), revision: 1 }],
          }),
        );
      }
      return new Response("{}", { status: 200 });
    };
    const remote = reading.syncRemoteLibrary();
    await Promise.resolve();
    await reading.updateArticle("one", { title: "local" });
    release();
    await remote;
    assert.equal(
      (await reading.getLibrary()).articles.find((a) => a.id === "one")?.title,
      "local",
    );
  });

  it("does not apply blocked sync body after disable and forget recreate account", async () => {
    local.settings = settings("a");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    fetchImpl = async () => {
      await blocked;
      return new Response(
        JSON.stringify({ articles: [{ ...article("remote"), revision: 9 }] }),
      );
    };
    const request = reading.syncRemoteLibrary();
    await reading.updateArticle("local", { title: "ignored" });
    local.settings = settings("b");
    await new Promise<void>((resolve, reject) =>
      (globalThis as any).chrome.runtime
        .sendMessage({ type: "library-forget" })
        .then(() => resolve(), reject),
    );
    local.settings = settings("b");
    release();
    await request;
    assert.equal(sync["a:remote"], undefined);
    assert.equal(sync["a:local"], undefined);
  });

  it("does not send account A's queued article to account B", async () => {
    local.settings = settings("a");
    sync["a:one"] = article("one");
    await reading.enqueueRemoteMutation({
      kind: "put",
      article: sync["a:one"] as any,
    });
    local.settings = settings("b");
    fetchImpl = async () =>
      new Response(JSON.stringify({ id: "one", revision: 2 }), { status: 200 });
    await reading.syncRemoteLibrary();
    assert.equal(
      calls.some((call) => call.url.includes("a.example.test")),
      false,
    );
    assert.equal(
      calls
        .filter((call) => call.method === "PUT")
        .some((call) => call.url.includes("b.example.test")),
      false,
    );
  });

  it("keeps canonical state and pending mutation intact when a storage write fails", async () => {
    local.settings = settings("a");
    sync["a:one"] = article("one");
    const before = JSON.stringify(sync["a:one"]);
    localSetError = new Error("temporary storage failure");
    await assert.rejects(
      () => reading.updateArticle("one", { title: "new" }),
      /temporary storage failure/,
    );
    assert.equal(JSON.stringify(sync["a:one"]), before);
    assert.equal(calls.length, 0);
  });

  it("retains local data and export/delete controls after mirror quota failure", async () => {
    local.settings = settings("a", false);
    sync["a:one"] = article("one");
    syncSetError = new Error("QUOTA_BYTES");
    await reading.updateArticle("one", { title: "new" });
    await flush();
    assert.equal((await reading.exportLibrary()).includes("one"), true);
    await reading.removeArticle("one");
    assert.equal((await reading.getLibrary()).articles.length, 0);
    const disabled = await (globalThis as any).chrome.runtime.sendMessage({
      type: "library-enable-sync",
      action: "disable",
    });
    assert.equal(disabled.ok, true);
  });

  it("completes a successful runtime import without coordinator deadlock", async () => {
    local.settings = settings("a", false);
    const raw = JSON.stringify({
      version: 1,
      exportedAt: 1,
      lists: ["Imported"],
      articles: [article("imported")],
    });
    const report = await Promise.race([
      reading.importLibrary(raw),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("successful import RPC timeout")), 500),
      ),
    ]);
    assert.equal(report.imported, 1);
    assert.equal((await reading.getLibrary()).articles[0]?.id, "imported");
  });

  it("allows recovery and an in-flight import to share the coordinator", async () => {
    local.settings = settings("a", false);
    local.libraryState = {
      version: 2,
      library: { lists: ["Reading list"], articles: [article("retry")] },
      pending: [],
      watermarks: {},
      mirrorRetryIntents: [{ kind: "article", id: "retry", article: article("retry") }],
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { withLibraryLock } = await import("../src/library-lock.js");
    const raw = JSON.stringify({ version: 1, lists: [], articles: [article("imported")] });
    const request = withLibraryLock(async () => {
      await gate;
      return reading.importLibrary(raw, true);
    });
    await reading.recoverLibraryTransaction();
    release();
    const report = await Promise.race([
      request,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("recovery/import deadlock")), 500)),
    ]);
    assert.equal(report.imported, 1);
  });

  it("retains separate article and list mirror retries and replays them", async () => {
    local.settings = settings("a", false);
    sync["a:retry"] = article("retry", "old");
    await flush();
    let failedArticleMirrorAttempts = 0;
    syncSetAlwaysError = new Error("QUOTA_BYTES");
    syncSetErrorWhen = (values) => {
      const keys = Object.keys(values);
      if (keys.includes("a:retry")) failedArticleMirrorAttempts++;
      return keys.includes("a:retry") || keys.includes("lists");
    };
    await reading.updateArticle("retry", { title: "retry" });
    await flush();
    await waitUntil(
      () => failedArticleMirrorAttempts >= 1,
      "article mirror write did not fail under persistent quota error",
    );
    await waitUntil(
      () => (local.libraryState as any).mirrorRetryIntents?.some(
        (intent: any) => intent.kind === "article" && intent.id === "retry",
      ),
      "failed article mirror retry was not persisted",
    );
    const failedState = (local.libraryState as any);
    const articleIntent = failedState.mirrorRetryIntents?.find(
      (intent: any) => intent.kind === "article" && intent.id === "retry",
    );
    const canonicalArticle = failedState.library.articles.find((item: any) => item.id === "retry");
    assert.deepEqual(articleIntent, {
      kind: "article",
      id: "retry",
      article: canonicalArticle,
    });
    assert.equal(canonicalArticle?.title, "retry");
    syncSetAlwaysError = undefined;
    await reading.recoverLibraryTransaction();
    await waitUntil(
      () => (sync["a:retry"] as any)?.title === "retry" &&
        !(local.libraryState as any).mirrorRetryIntents?.some(
          (intent: any) => intent.kind === "article" && intent.id === "retry",
        ),
      "article mirror retry did not complete",
    );
    assert.equal((sync["a:retry"] as any).title, "retry");
    assert.equal(
      (local.libraryState as any).mirrorRetryIntents?.some(
        (intent: any) => intent.kind === "article" && intent.id === "retry",
      ),
      false,
    );
    syncSetAlwaysError = new Error("QUOTA_BYTES");
    await (await import("../src/reading.js")).addList("Retry list");
    await flush();
    assert.deepEqual(
      (local.libraryState as any).mirrorRetryIntents?.find((intent: any) => intent.kind === "lists"),
      { kind: "lists", lists: ["Reading list", "Retry list"] },
    );
    syncSetAlwaysError = undefined;
    await reading.recoverLibraryTransaction();
    await waitUntil(
      () => JSON.stringify(sync.lists) === JSON.stringify(["Reading list", "Retry list"]) &&
        !(local.libraryState as any).mirrorRetryIntents?.some((intent: any) => intent.kind === "lists"),
      "list mirror retry did not complete",
    );
    assert.deepEqual(sync.lists, ["Reading list", "Retry list"]);
    syncRemoveError = new Error("QUOTA_BYTES");
    await reading.removeArticle("retry");
    await flush();
    await reading.recoverLibraryTransaction();
    await waitUntil(() => sync["a:retry"] === undefined, "article delete mirror retry did not complete");
    assert.equal(sync["a:retry"], undefined);
  });

  it("supersedes a stale mirror retry when an external profile update arrives", async () => {
    local.settings = settings("a", true);
    sync["a:one"] = article("one", "old");
    syncSetError = new Error("QUOTA_BYTES");
    await reading.updateArticle("one", { title: "stale" });
    await flush();
    syncSetError = undefined;
    await reading.handleExternalSyncChanges({
      "a:one": { oldValue: article("one", "stale"), newValue: article("one", "fresh") } as any,
    });
    sync["a:one"] = article("one", "fresh");
    await reading.syncRemoteLibrary();
    await reading.recoverLibraryTransaction();
    await flush();
    assert.equal((await reading.getLibrary()).articles[0]?.title, "fresh");
    assert.equal((sync["a:one"] as any).title, "fresh");
  });

  it("keeps startup and alarm sync alive while list mirror quota is exhausted", async () => {
    local.settings = settings("a", true);
    local.libraryState = {
      version: 2,
      library: { lists: ["Reading list", "Retry list"], articles: [] },
      pending: [],
      watermarks: {},
      mirrorRetryIntents: [{ kind: "lists", lists: ["Reading list", "Retry list"] }],
    };
    sync.lists = ["Reading list"];
    let failedMirrorAttempts = 0;
    syncSetAlwaysError = new Error("QUOTA_BYTES");
    syncSetErrorWhen = (values) => {
      if (Object.keys(values).includes("lists")) {
        failedMirrorAttempts++;
        return true;
      }
      return false;
    };
    (events.onStartup as any).dispatch();
    await waitUntil(() => failedMirrorAttempts >= 1, "startup did not attempt list mirror retry");
    const startupGets = calls.filter((call) => call.url.endsWith("/api/v1/articles")).length;
    assert.equal(startupGets >= 1, true);
    assert.equal((local.libraryState as any).mirrorRetryIntents.length, 1);
    (events.alarms as any).dispatch({ name: "poll-library" });
    await waitUntil(() => failedMirrorAttempts >= 2, "alarm did not attempt list mirror retry");
    const alarmGets = calls.filter((call) => call.url.endsWith("/api/v1/articles")).length;
    assert.equal(alarmGets >= startupGets + 1, true);
    assert.equal((local.libraryState as any).mirrorRetryIntents.length, 1);
    syncSetAlwaysError = undefined;
    syncSetErrorWhen = undefined;
    (events.alarms as any).dispatch({ name: "poll-library" });
    await waitUntil(
      () => JSON.stringify(sync.lists) === JSON.stringify(["Reading list", "Retry list"]),
      "alarm did not replay list mirror",
    );
    await waitUntil(() => !(local.libraryState as any).mirrorRetryIntents?.length, "list retry marker was not cleared");
    assert.deepEqual(sync.lists, ["Reading list", "Retry list"]);
  });

  it("replays a prepared transaction after worker reconstruction exactly once", async () => {
    local.settings = settings("a");
    local.libraryPreparedTransaction = {
      id: "tx",
      phase: "prepared",
      syncSet: { "a:one": article("one") },
      pending: [{ kind: "put", article: article("one") }],
    };
    await reading.recoverLibraryTransaction();
    await reading.recoverLibraryTransaction();
    assert.equal((await reading.getLibrary()).articles.length, 0);
    assert.equal(local.libraryPreparedTransaction, undefined);
  });

  it("reports imported data when list mirror write fails", async () => {
    local.settings = settings("a", false);
    const raw = JSON.stringify({
      version: 1,
      exportedAt: 1,
      lists: ["Imported"],
      articles: [article("imported")],
    });
    syncSetError = new Error("mirror failure");
    let injected = false;
    syncSetErrorWhen = (values) => {
      injected = Object.keys(values).some((key) => key.startsWith("a:"));
      return injected;
    };
    const report = await Promise.race([
      reading.importLibrary(raw),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("import RPC timeout")), 500),
      ),
    ]);
    assert.equal(injected, true);
    assert.equal(report.imported, 1);
    assert.equal((await reading.getLibrary()).articles[0]?.id, "imported");
  });

  it("routes external profile article changes through one HTTP mutation and mirrors without echo", async () => {
    local.settings = settings("a");
    await reading.handleExternalSyncChanges({
      "a:external": {
        oldValue: undefined,
        newValue: article("external"),
      } as any,
    });
    await reading.syncRemoteLibrary();
    await flush();
    assert.equal(calls.filter((call) => call.method === "PUT").length, 1);
    const before = calls.length;
    await reading.handleExternalSyncChanges({
      "a:external": {
        oldValue: article("external"),
        newValue: article("external"),
      } as any,
    });
    await flush();
    assert.equal(calls.length, before);
  });

  it("coalesces overlapping sync alarms into one pull", async () => {
    local.settings = settings("a");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    fetchImpl = async (url) => {
      if (url.endsWith("/api/v1/articles")) await blocked;
      return new Response(JSON.stringify({ articles: [] }));
    };
    const first = reading.syncRemoteLibrary();
    const second = reading.syncRemoteLibrary();
    await Promise.resolve();
    release();
    await Promise.all([first, second]);
    assert.equal(
      calls.filter((call) => call.url.endsWith("/api/v1/articles")).length,
      1,
    );
  });

  it("does not mirror a pull when its canonical commit fails", async () => {
    local.settings = settings("a");
    sync["a:one"] = article("one", "local");
    await reading.getLibrary(true);
    const before = JSON.stringify(sync["a:one"]);
    fetchImpl = async () =>
      new Response(JSON.stringify({ articles: [{ ...article("one", "remote"), revision: 2 }] }));
    localSetError = new Error("canonical pull write failed");
    await reading.syncRemoteLibrary();
    localSetError = undefined;
    assert.equal(JSON.stringify(sync["a:one"]), before);
    assert.equal((await reading.getLibrary(true)).articles[0]?.title, "local");
  });

  it("removes a pulled tombstone from canonical state and profile mirror", async () => {
    local.settings = settings("a");
    sync["a:gone"] = article("gone");
    await reading.getLibrary(true);
    fetchImpl = async () =>
      new Response(JSON.stringify({ articles: [{ id: "gone", revision: 3, deleted: true }] }));
    await reading.syncRemoteLibrary();
    await flush();
    assert.equal((await reading.getLibrary(true)).articles.some((a) => a.id === "gone"), false);
    assert.equal(sync["a:gone"], undefined);
  });

  it("invokes command and context-menu saves through actual background callbacks", async () => {
    local.settings = settings("a", false);
    (events.commands as any).dispatch("save-position", {
      id: 3,
      url: "https://example.test/command",
      title: "Command",
    });
    await flush();
    (events.contextMenus as any).dispatch(
      { menuItemId: "save:Reading list", selectionText: "selected words" },
      { id: 4, url: "https://example.test/menu", title: "Menu" },
    );
    await flush();
    assert.equal((await reading.getLibrary()).articles.length, 2);
    assert.equal(tabCreated, 0);
  });
});

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  ARTICLE_PREFIX,
  LIBRARY_STATE_KEY,
  exportLibrary,
  getLibrary,
  handleExternalSyncChanges,
  importLibrary,
  removeArticle,
  updateArticle,
} from "../src/reading.js";

type Bag = Record<string, unknown>;
let local: Bag;
let sync: Bag;
let localFailure = false;
let mirrorFailure = false;
const listeners: Array<
  (changes: Record<string, chrome.storage.StorageChange>, area: string) => void
> = [];
function area(which: "local" | "sync") {
  const bag = () => (which === "local" ? local : sync);
  return {
    async get(key?: string | string[] | null) {
      const value = bag();
      if (key == null) return { ...value };
      if (typeof key === "string") return { [key]: value[key] };
      return Object.fromEntries(key.map((k) => [k, value[k]]));
    },
    async set(values: Bag) {
      if (which === "local" && localFailure)
        throw new Error("canonical write failed");
      if (which === "sync" && mirrorFailure) throw new Error("QUOTA_BYTES");
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const [key, value] of Object.entries(values)) {
        changes[key] = { oldValue: bag()[key], newValue: value };
        bag()[key] = value;
      }
      listeners.forEach((listener) => listener(changes, which));
    },
    async remove(keys: string | string[]) {
      for (const key of typeof keys === "string" ? [keys] : keys)
        delete bag()[key];
    },
    async getBytesInUse() {
      return 0;
    },
    QUOTA_BYTES: 102400,
  };
}
beforeEach(() => {
  local = {};
  sync = {};
  localFailure = false;
  mirrorFailure = false;
  (globalThis as any).chrome = {
    storage: {
      local: area("local"),
      sync: area("sync"),
      onChanged: {
        addListener: (f: (typeof listeners)[number]) => listeners.push(f),
      },
    },
    runtime: {},
    scripting: {
      executeScript: async () => [{ result: { snippet: "", progress: 0 } }],
    },
  };
});
afterEach(() => {
  listeners.length = 0;
});
const article = (id: string) => ({
  id,
  url: `https://example.test/${id}`,
  title: id,
  list: "Reading list",
  snippet: "",
  progress: 0,
  savedAt: 1,
});

describe("canonical library persistence", () => {
  it("commits local canonical state before mirror and keeps it readable when mirror quota fails", async () => {
    sync[ARTICLE_PREFIX + "a"] = article("a");
    mirrorFailure = true;
    assert.equal((await getLibrary(true)).articles.length, 1);
    await updateArticle("a", { title: "edited" }, true);
    assert.equal((await getLibrary(true)).articles[0]?.title, "edited");
    assert.match(
      String((local[LIBRARY_STATE_KEY] as any).mirrorRetry),
      /QUOTA/,
    );
    assert.equal(
      JSON.parse(await exportLibrary(true)).articles[0].title,
      "edited",
    );
  });

  it("leaves existing canonical data and mirror untouched when canonical write fails", async () => {
    sync[ARTICLE_PREFIX + "a"] = article("a");
    await getLibrary(true);
    const before = JSON.stringify(local[LIBRARY_STATE_KEY]);
    localFailure = true;
    await assert.rejects(
      () => updateArticle("a", { title: "must fail" }, true),
      /canonical write failed/,
    );
    assert.equal(JSON.stringify(local[LIBRARY_STATE_KEY]), before);
    assert.deepEqual(sync[ARTICLE_PREFIX + "a"], article("a"));
  });

  it("persists pending deletes across a restart and removes the article locally", async () => {
    sync[ARTICLE_PREFIX + "a"] = article("a");
    await getLibrary(true);
    (local.settings as any) = {
      serverUrl: "https://s.test",
      deviceId: "d",
      token: "t",
      sharedSync: true,
    };
    await removeArticle("a", true);
    const pending = (local[LIBRARY_STATE_KEY] as any).pending;
    assert.equal(pending[0].kind, "delete");
    assert.equal((await getLibrary(true)).articles.length, 0);
  });

  it("does not publish a failed import when canonical storage rejects it", async () => {
    await getLibrary(true);
    localFailure = true;
    const raw = JSON.stringify({
      version: 1,
      exportedAt: 1,
      lists: ["Reading list"],
      articles: [article("new")],
    });
    await assert.rejects(
      () => importLibrary(raw, true),
      /canonical write failed/,
    );
    assert.equal((await getLibrary(true)).articles.length, 0);
  });

  it("bootstraps sync and retained legacy data into one canonical state", async () => {
    sync[ARTICLE_PREFIX + "sync"] = article("sync");
    local.library = { lists: ["Old"], articles: [article("legacy")] };
    const library = await getLibrary(true);
    assert.deepEqual(
      new Set(library.articles.map((a) => a.id)),
      new Set(["sync", "legacy"]),
    );
    assert.equal(local.library, undefined);
    assert.equal((local[LIBRARY_STATE_KEY] as any).version, 2);
  });

  it("ingests external add, edit, and delete exactly once without own mirror echo", async () => {
    await getLibrary(true);
    (local.settings as any) = {
      serverUrl: "https://s.test",
      deviceId: "d",
      token: "t",
      sharedSync: true,
    };
    const incoming = article("external");
    await handleExternalSyncChanges({
      [ARTICLE_PREFIX + "external"]: { newValue: incoming },
    });
    assert.equal((await getLibrary(true)).articles.length, 1);
    const pending = (local[LIBRARY_STATE_KEY] as any).pending;
    assert.equal(pending.length, 1);
    assert.equal(pending[0].kind, "put");
    await handleExternalSyncChanges({
      [ARTICLE_PREFIX + "external"]: {
        oldValue: incoming,
        newValue: { ...incoming, title: "changed" },
      },
    });
    assert.equal((await getLibrary(true)).articles[0]?.title, "changed");
    assert.equal((local[LIBRARY_STATE_KEY] as any).pending.length, 1);
    await handleExternalSyncChanges({
      [ARTICLE_PREFIX + "external"]: {
        oldValue: incoming,
        newValue: undefined,
      },
    });
    assert.equal((await getLibrary(true)).articles.length, 0);
    assert.equal((local[LIBRARY_STATE_KEY] as any).pending[0].kind, "delete");
  });

  it("adds an externally received article list to navigation", async () => {
    await getLibrary(true);
    (local.settings as any) = {
      serverUrl: "https://s.test",
      deviceId: "d",
      token: "t",
      sharedSync: true,
    };
    await handleExternalSyncChanges({
      [ARTICLE_PREFIX + "work"]: {
        newValue: { ...article("work"), list: "Work" },
      },
    });
    assert.equal((await getLibrary(true)).lists.includes("Work"), true);
  });

  it("mirrors list mutations after canonical list commits", async () => {
    await getLibrary(true);
    const { addList, renameList, deleteList } = await import(
      "../src/reading.js"
    );
    await addList("Work", true);
    await renameList("Work", "Done", true);
    await deleteList("Done", true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(sync.lists, ["Reading list"]);
  });
});

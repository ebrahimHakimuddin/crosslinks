import {
  getSettings,
  apiFetchWithSettings,
  settingsMatch,
  type ExtensionSettings,
} from "./shared.js";
import { withLibraryLock } from "./library-lock.js";
export interface SavedArticle {
  id: string;
  url: string;
  title: string;
  list: string;
  snippet: string;
  progress: number;
  savedAt: number;
  readAt?: number;
  revision?: number;
}
export interface Library {
  lists: string[];
  articles: SavedArticle[];
}
export interface LibraryExport {
  version: 1;
  exportedAt: number;
  articles: SavedArticle[];
  lists: string[];
}
export type ImportReport = {
  imported: number;
  skipped: number;
  failed: number;
  errors: string[];
};
export const LISTS_KEY = "lists",
  ARTICLE_PREFIX = "a:",
  LEGACY_LIBRARY_KEY = "library",
  DEFAULT_LIST = "Reading list",
  LEGACY_MIGRATION_KEY = "libraryMigration",
  LIBRARY_STATE_KEY = "libraryState";
const OLD_TX_KEY = "libraryPreparedTransaction";
const MAX = { id: 128, title: 300, list: 60, snippet: 500 };
const expectedMirror = new Map<string, string | undefined>();
let expectedLists: string | undefined;
type Scope = {
  origin: string;
  deviceId: string;
  token: string;
  consentEpoch: number;
};
type PendingInput =
  | { kind: "put"; article: SavedArticle }
  | { kind: "delete"; id: string };
type Pending = { opId: string; scope: Scope } & PendingInput;
export type LibraryState = {
  version: 2;
  library: Library;
  pending: Pending[];
  watermarks: Record<string, number>;
  mirrorRetry?: unknown;
  mirrorRetryIntent?: unknown;
  mirrorRetryIntents?: MirrorRetryIntent[];
};
type MirrorRetryIntent =
  | { kind: "article"; id: string; article: SavedArticle | undefined }
  | { kind: "lists"; lists: string[] };
const empty = (): LibraryState => ({
  version: 2,
  library: { lists: [DEFAULT_LIST], articles: [] },
  pending: [],
  watermarks: {},
});
let boot: Promise<LibraryState> | undefined;
let mirrors = Promise.resolve();
export function stripTextDirective(url: string): string {
  const h = url.indexOf("#");
  if (h < 0) return url;
  const d = url.indexOf(":~:", h);
  return d < 0 ? url : url.slice(0, d === h + 1 ? h : d);
}
export function restoreUrl(a: Pick<SavedArticle, "url" | "snippet">): string {
  if (!a.snippet) return a.url;
  return `${a.url}${a.url.includes("#") ? "" : "#"}:~:text=${encodeURIComponent(a.snippet).replace(/-/g, "%2D")}`;
}
export function snippetFrom(text: string): string {
  return text.trim().split(/\s+/).slice(0, 8).join(" ");
}
function valid(v: unknown): v is SavedArticle {
  if (!v || typeof v !== "object") return false;
  const a = v as Partial<SavedArticle>;
  try {
    const u = new URL(String(a.url));
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
      return false;
  } catch {
    return false;
  }
  return (
    typeof a.id === "string" &&
    a.id.length > 0 &&
    a.id.length <= MAX.id &&
    typeof a.title === "string" &&
    a.title.length <= MAX.title &&
    typeof a.list === "string" &&
    a.list.length <= MAX.list &&
    typeof a.snippet === "string" &&
    a.snippet.length <= MAX.snippet &&
    Number.isFinite(a.progress) &&
    Number(a.progress) >= 0 &&
    Number(a.progress) <= 1 &&
    Number.isSafeInteger(a.savedAt) &&
    Number(a.savedAt) >= 0 &&
    (a.readAt === undefined ||
      (Number.isSafeInteger(a.readAt) && Number(a.readAt) >= 0))
  );
}
export function toLibrary(stored: Record<string, unknown>): Library {
  const articles = Object.entries(stored)
    .filter(([k, v]) => k.startsWith(ARTICLE_PREFIX) && valid(v))
    .map(([, v]) => v as SavedArticle)
    .sort((a, b) => b.savedAt - a.savedAt);
  return {
    lists: [
      ...new Set([
        ...((stored[LISTS_KEY] as string[] | undefined) ?? [DEFAULT_LIST]),
        ...articles.map((a) => a.list),
      ]),
    ],
    articles,
  };
}
function scope(
  s?: ExtensionSettings,
  allowDisabled = false,
): Scope | undefined {
  return s?.serverUrl &&
    s.deviceId &&
    s.token &&
    (allowDisabled || s.sharedSync)
    ? {
        origin: s.serverUrl,
        deviceId: s.deviceId,
        token: s.token,
        consentEpoch: s.consentEpoch ?? 0,
      }
    : undefined;
}
function same(a: Scope | undefined, b: Scope | undefined) {
  return (
    !!a &&
    !!b &&
    a.origin === b.origin &&
    a.deviceId === b.deviceId &&
    a.token === b.token &&
    a.consentEpoch === b.consentEpoch
  );
}
async function state(): Promise<LibraryState> {
  const r = await chrome.storage.local.get(LIBRARY_STATE_KEY);
  const s = r[LIBRARY_STATE_KEY] as LibraryState | undefined;
  return s?.version === 2 && s.library && Array.isArray(s.library.articles)
    ? s
    : empty();
}
async function bootstrap(): Promise<LibraryState> {
  const found = await chrome.storage.local.get(LIBRARY_STATE_KEY);
  if (found[LIBRARY_STATE_KEY]) return state();
  const sync = await chrome.storage.sync.get(null);
  const old = (await chrome.storage.local.get(LEGACY_LIBRARY_KEY))[
    LEGACY_LIBRARY_KEY
  ] as Library | undefined;
  const base = toLibrary(sync);
  const ids = new Set(base.articles.map((a) => a.id));
  const articles = [...base.articles];
  for (const a of old?.articles ?? [])
    if (valid(a) && !ids.has(a.id)) {
      articles.push(a);
      ids.add(a.id);
    }
  const s: LibraryState = {
    version: 2,
    library: {
      lists: [...new Set([...base.lists, ...(old?.lists ?? [])])],
      articles: articles.sort((a, b) => b.savedAt - a.savedAt),
    },
    pending: [],
    watermarks: {},
  };
  await chrome.storage.local.set({ [LIBRARY_STATE_KEY]: s });
  await chrome.storage.local.remove([LEGACY_LIBRARY_KEY, LEGACY_MIGRATION_KEY]);
  return s;
}
async function ensure(): Promise<LibraryState> {
  boot ??= bootstrap().finally(() => {
    boot = undefined;
  });
  return boot;
}
export async function migrateLocalLibrary() {
  const legacy = await getRetainedLegacy();
  const stateValue = await ensure();
  return {
    migrated: stateValue.library.articles.length,
    retained: legacy?.articles.length ?? 0,
  };
}
export async function getRetainedLegacy() {
  return (await chrome.storage.local.get(LEGACY_LIBRARY_KEY))[
    LEGACY_LIBRARY_KEY
  ] as Library | undefined;
}
async function mirror(
  article: SavedArticle | undefined,
  id: string,
  recordFailure = true,
): Promise<boolean> {
  const key = ARTICLE_PREFIX + id;
  try {
    if (article) {
      expectedMirror.set(key, JSON.stringify(article));
      while (expectedMirror.size > 256)
        expectedMirror.delete(expectedMirror.keys().next().value as string);
      await chrome.storage.sync.set({ [key]: article });
    } else {
      const old = await chrome.storage.sync.get(key);
      if (old[key] !== undefined) {
        expectedMirror.set(key, undefined);
        while (expectedMirror.size > 256)
          expectedMirror.delete(expectedMirror.keys().next().value as string);
        await chrome.storage.sync.remove(key);
      }
    }
    void clearMirrorRetry({ kind: "article", id, article });
    return true;
  } catch (e) {
    expectedMirror.delete(key);
    if (recordFailure)
      void recordMirrorRetry(
        { kind: "article", id, article },
        e instanceof Error ? e.message : "Chrome sync mirror failed.",
      );
    return false;
  }
}
function queueMirror<T>(f: () => Promise<T>): Promise<T> {
  const n = mirrors.then(f, f);
  mirrors = n.then(
    () => undefined,
    () => undefined,
  );
  return n;
}
function retryIntents(s: LibraryState): MirrorRetryIntent[] {
  const many = Array.isArray(s.mirrorRetryIntents)
    ? s.mirrorRetryIntents
    : [];
  const old = s.mirrorRetryIntent as MirrorRetryIntent | undefined;
  return old && !many.some((x) => retryKey(x) === retryKey(old))
    ? [...many, old]
    : many;
}
function retryKey(intent: MirrorRetryIntent): string {
  return intent.kind === "article"
    ? `article:${intent.id}`
    : "lists";
}
function withMirrorRetry(
  s: LibraryState,
  intent: MirrorRetryIntent,
): LibraryState {
  return {
    ...s,
    mirrorRetryIntent: undefined,
    mirrorRetryIntents: [
      ...retryIntents(s).filter((x) => retryKey(x) !== retryKey(intent)),
      intent,
    ],
  };
}
async function recordMirrorRetry(intent: MirrorRetryIntent, message: string) {
  await withLibraryLock(async () => {
    const latest = await state();
    const current = retryIntents(latest).find(
      (x) => retryKey(x) === retryKey(intent),
    );
    if (!current || JSON.stringify(current) !== JSON.stringify(intent)) return;
    await chrome.storage.local.set({
      [LIBRARY_STATE_KEY]: {
        ...latest,
        mirrorRetry: message,
        mirrorRetryIntent: undefined,
        mirrorRetryIntents: retryIntents(latest),
      },
    });
  });
}
async function clearMirrorRetry(intent: MirrorRetryIntent) {
  await withLibraryLock(async () => {
    const latest = await state();
    const intents = retryIntents(latest).filter((x) => {
      if (retryKey(x) !== retryKey(intent)) return true;
      if (intent.kind === "article" && x.kind === "article")
        return JSON.stringify(x.article) !== JSON.stringify(intent.article);
      if (intent.kind === "lists" && x.kind === "lists")
        return JSON.stringify(x.lists) !== JSON.stringify(intent.lists);
      return false;
    });
    await chrome.storage.local.set({
      [LIBRARY_STATE_KEY]: {
        ...latest,
        mirrorRetry: intents.length ? latest.mirrorRetry : undefined,
        mirrorRetryIntent: undefined,
        mirrorRetryIntents: intents,
      },
    });
  });
}
function mirrorLists(lists: string[]) {
  void queueMirror(async () => {
    try {
      expectedLists = JSON.stringify(lists);
      await chrome.storage.sync.set({ [LISTS_KEY]: lists });
      void clearMirrorRetry({ kind: "lists", lists });
    } catch {
      expectedLists = undefined;
      void recordMirrorRetry(
        { kind: "lists", lists },
        "Could not mirror reading lists.",
      );
    }
  });
}
function pending(
  s: LibraryState,
  sc: Scope | undefined,
  m: PendingInput,
): Pending[] {
  if (!sc) return s.pending;
  const id = m.kind === "put" ? m.article.id : m.id;
  return [
    ...s.pending.filter(
      (p) =>
        !(same(p.scope, sc) && (p.kind === "put" ? p.article.id : p.id) === id),
    ),
    { ...m, opId: crypto.randomUUID(), scope: sc } as Pending,
  ];
}
async function rpc<T>(m: Record<string, unknown>): Promise<T> {
  const r = (await chrome.runtime.sendMessage(m)) as {
    ok?: boolean;
    value?: T;
    message?: string;
  };
  if (!r?.ok) throw new Error(r?.message ?? "Library service is unavailable.");
  return r.value as T;
}
export async function getLibrary(internal = false) {
  if (!internal && typeof chrome.runtime?.sendMessage === "function")
    return rpc<Library>({ type: "library-read" });
  return (await ensure()).library;
}
export function exportJson(l: Library) {
  return JSON.stringify(
    {
      version: 1,
      exportedAt: Date.now(),
      lists: l.lists,
      articles: l.articles,
    } satisfies LibraryExport,
    null,
    2,
  );
}
export async function exportLibrary(internal = false) {
  if (!internal && typeof chrome.runtime?.sendMessage === "function")
    return rpc<string>({ type: "library-export" });
  return exportJson((await ensure()).library);
}
export function parseImport(raw: string): LibraryExport {
  const p = JSON.parse(raw) as Partial<LibraryExport>;
  if (p.version !== 1 || !Array.isArray(p.articles) || !Array.isArray(p.lists))
    throw new Error("Unsupported or invalid library backup.");
  for (const article of p.articles) {
    if (!valid(article)) {
      throw new Error("Backup contains unsafe URLs or invalid articles.");
    }
  }
  const ids = new Map<string, string>();
  for (const article of p.articles as SavedArticle[]) {
    const previous = ids.get(article.id);
    if (previous && previous !== article.url)
      throw new Error("Backup contains conflicting duplicate article IDs.");
    ids.set(article.id, article.url);
  }
  if (p.lists.some((l) => typeof l !== "string" || l.length > MAX.list))
    throw new Error("Unsupported or invalid library backup.");
  return {
    version: 1,
    exportedAt: Number(p.exportedAt) || Date.now(),
    articles: p.articles as SavedArticle[],
    lists: p.lists as string[],
  };
}
export async function importLibrary(
  raw: string,
  internal = false,
): Promise<ImportReport> {
  if (!internal && typeof chrome.runtime?.sendMessage === "function")
    return rpc<ImportReport>({ type: "library-import", raw });
  const b = parseImport(raw),
    s = await ensure(),
    ids = new Set(s.library.articles.map((a) => a.id)),
    urls = new Set(s.library.articles.map((a) => a.url)),
    incoming: SavedArticle[] = [];
  for (const article of b.articles) {
    if (!ids.has(article.id) && !urls.has(article.url)) {
      ids.add(article.id);
      urls.add(article.url);
      incoming.push(article);
    }
  }
  const sc = scope(await getSettings());
  let next = {
    ...s,
    library: {
      lists: [
        ...new Set([
          ...s.library.lists,
          ...b.lists,
          ...incoming.map((a) => a.list),
        ]),
      ],
      articles: [...s.library.articles, ...incoming],
    },
    pending: s.pending,
  };
  for (const a of incoming)
    next.pending = pending(next, sc, { kind: "put", article: a });
  for (const a of incoming)
    next = withMirrorRetry(next, { kind: "article", id: a.id, article: a });
  next = withMirrorRetry(next, { kind: "lists", lists: next.library.lists });
  await chrome.storage.local.set({ [LIBRARY_STATE_KEY]: next });
  mirrorLists(next.library.lists);
  let failed = 0;
  const errors: string[] = [];
  const mirrorTasks = incoming.map((a) => queueMirror(() => mirror(a, a.id)));
  if (internal) void Promise.all(mirrorTasks);
  else {
    for (const task of mirrorTasks) {
      if (!(await task)) {
        failed++;
        errors.push("Could not mirror imported article.");
      }
    }
  }
  return {
    imported: incoming.length,
    skipped: b.articles.length - incoming.length,
    failed,
    errors,
  };
}
export async function updateArticle(
  id: string,
  patch: Partial<SavedArticle>,
  internal = false,
) {
  if (!internal && typeof chrome.runtime?.sendMessage === "function") {
    await rpc({ type: "library-action", action: "update", id, patch });
    return;
  }
  const s = await ensure(),
    a = s.library.articles.find((x) => x.id === id);
  if (!a) return;
  const article = { ...a, ...patch },
    sc = scope(await getSettings());
  await chrome.storage.local.set({
    [LIBRARY_STATE_KEY]: {
      ...s,
      library: {
        ...s.library,
        articles: s.library.articles.map((x) => (x.id === id ? article : x)),
      },
      pending: pending(s, sc, { kind: "put", article }),
      mirrorRetryIntents: withMirrorRetry(s, {
        kind: "article",
        id,
        article,
      }).mirrorRetryIntents,
    },
  });
  void queueMirror(() => mirror(article, id));
}
export async function removeArticle(id: string, internal = false) {
  if (!internal && typeof chrome.runtime?.sendMessage === "function") {
    await rpc({ type: "library-action", action: "remove", id });
    return;
  }
  const s = await ensure(),
    sc = scope(await getSettings());
  await chrome.storage.local.set({
    [LIBRARY_STATE_KEY]: {
      ...s,
      library: {
        ...s.library,
        articles: s.library.articles.filter((a) => a.id !== id),
      },
      pending: pending(s, sc, { kind: "delete", id }),
      mirrorRetryIntents: withMirrorRetry(s, {
        kind: "article",
        id,
        article: undefined,
      }).mirrorRetryIntents,
    },
  });
  void queueMirror(() => mirror(undefined, id));
}
export async function addList(name: string, internal = false) {
  if (!internal && typeof chrome.runtime?.sendMessage === "function") {
    await rpc({ type: "library-action", action: "add-list", name });
    return;
  }
  const s = await ensure();
  if (!s.library.lists.includes(name))
    await chrome.storage.local.set({
      [LIBRARY_STATE_KEY]: withMirrorRetry({
        ...s,
        library: { ...s.library, lists: [...s.library.lists, name] },
      }, { kind: "lists", lists: [...s.library.lists, name] }),
    });
  if (!s.library.lists.includes(name)) mirrorLists([...s.library.lists, name]);
}
export async function renameList(from: string, to: string, internal = false) {
  if (!internal && typeof chrome.runtime?.sendMessage === "function") {
    await rpc({ type: "library-action", action: "rename-list", from, to });
    return;
  }
  const s = await ensure(),
    sc = scope(await getSettings()),
    articles = s.library.articles.map((a) =>
      a.list === from ? { ...a, list: to } : a,
    );
  let next = {
    ...s,
    library: {
      lists: [...new Set(s.library.lists.map((l) => (l === from ? to : l)))],
      articles,
    },
    pending: s.pending,
  };
  for (const a of articles.filter((a) => a.list === to))
    next.pending = pending(next, sc, { kind: "put", article: a });
  next = withMirrorRetry(next, { kind: "lists", lists: next.library.lists });
  for (const a of articles.filter((a) => a.list === to))
    next = withMirrorRetry(next, { kind: "article", id: a.id, article: a });
  await chrome.storage.local.set({ [LIBRARY_STATE_KEY]: next });
  mirrorLists(next.library.lists);
  for (const a of articles.filter((a) => a.list === to))
    void queueMirror(() => mirror(a, a.id));
}
export async function deleteList(name: string, internal = false) {
  if (!internal && typeof chrome.runtime?.sendMessage === "function") {
    await rpc({ type: "library-action", action: "delete-list", name });
    return;
  }
  const s = await ensure(),
    sc = scope(await getSettings()),
    removed = s.library.articles.filter((a) => a.list === name);
  let next = {
    ...s,
    library: {
      lists: s.library.lists.filter((l) => l !== name),
      articles: s.library.articles.filter((a) => a.list !== name),
    },
    pending: s.pending,
  };
  for (const a of removed)
    next.pending = pending(next, sc, { kind: "delete", id: a.id });
  next = withMirrorRetry(next, { kind: "lists", lists: next.library.lists });
  for (const a of removed)
    next = withMirrorRetry(next, { kind: "article", id: a.id, article: undefined });
  await chrome.storage.local.set({ [LIBRARY_STATE_KEY]: next });
  mirrorLists(next.library.lists);
  for (const a of removed) void queueMirror(() => mirror(undefined, a.id));
}
type RemoteMutationInput =
  | { kind: "put"; article: SavedArticle }
  | { kind: "delete"; id: string };
export async function enqueueRemoteMutation(m: RemoteMutationInput) {
  const s = await ensure(),
    sc = scope(await getSettings());
  if (sc)
    await chrome.storage.local.set({
      [LIBRARY_STATE_KEY]: { ...s, pending: pending(s, sc, m) },
    });
}
export async function handleExternalSyncChanges(
  changes: Record<string, chrome.storage.StorageChange>,
) {
  let s = await ensure(),
    articles = [...s.library.articles],
    sc = scope(await getSettings());
  for (const [k, c] of Object.entries(changes)) {
    if (k === LISTS_KEY && expectedLists === JSON.stringify(c.newValue)) {
      expectedLists = undefined;
      continue;
    }
    if (k === LISTS_KEY && Array.isArray(c.newValue)) {
      s = {
        ...s,
        library: {
          ...s.library,
          lists: [
            ...new Set([
              ...(c.newValue as string[]),
              ...articles.map((a) => a.list),
            ]),
          ],
        },
        mirrorRetryIntents: retryIntents(s).filter((x) => x.kind !== "lists"),
        mirrorRetryIntent: undefined,
      };
      continue;
    }
    if (!k.startsWith(ARTICLE_PREFIX)) continue;
    const expected = expectedMirror.get(k);
    if (
      expectedMirror.has(k) &&
      expected ===
        (c.newValue === undefined ? undefined : JSON.stringify(c.newValue))
    ) {
      expectedMirror.delete(k);
      continue;
    }
    const id = k.slice(ARTICLE_PREFIX.length);
    if (c.newValue === undefined) {
      articles = articles.filter((a) => a.id !== id);
      s = {
        ...s,
        library: { ...s.library, articles },
        pending: pending(s, sc, { kind: "delete", id }),
        mirrorRetryIntents: retryIntents(s).filter(
          (x) => !(x.kind === "article" && x.id === id),
        ),
        mirrorRetryIntent: undefined,
      };
      continue;
    }
    if (!valid(c.newValue)) continue;
    const a = c.newValue,
      i = articles.findIndex((x) => x.id === a.id);
    if (i < 0) articles.push(a);
    else articles[i] = a;
    s = {
      ...s,
      library: {
        ...s.library,
        lists: [...new Set([...s.library.lists, a.list])],
        articles,
      },
      pending: pending(s, sc, { kind: "put", article: a }),
      mirrorRetryIntents: retryIntents(s).filter(
        (x) => !(x.kind === "article" && x.id === a.id),
      ),
      mirrorRetryIntent: undefined,
    };
  }
  await chrome.storage.local.set({ [LIBRARY_STATE_KEY]: s });
}
export async function seedRemoteJournal(seedSettings?: ExtensionSettings) {
  const set = seedSettings ?? (await getSettings());
  if (!set?.sharedSync) return;
  let s = await ensure(),
    sc = scope(set, true);
  for (const a of s.library.articles)
    s = { ...s, pending: pending(s, sc, { kind: "put", article: a }) };
  await chrome.storage.local.set({ [LIBRARY_STATE_KEY]: s });
}
export async function clearRemoteOutbox() {
  const s = await ensure();
  await chrome.storage.local.set({
    [LIBRARY_STATE_KEY]: { ...s, pending: [], watermarks: {} },
  });
}
export async function recoverLibraryTransaction() {
  const current = await state();
  const tasks: Promise<unknown>[] = [];
  for (const retry of retryIntents(current)) {
    tasks.push(queueMirror(async () => {
      const latest = await state();
      const fresh = retryIntents(latest).find(
        (x) => retryKey(x) === retryKey(retry),
      );
      if (!fresh) return;
      if (fresh.kind === "article") await mirror(fresh.article, fresh.id);
      else {
        expectedLists = JSON.stringify(fresh.lists);
        try {
          await chrome.storage.sync.set({ [LISTS_KEY]: fresh.lists });
          void clearMirrorRetry(fresh);
        } catch (error) {
          expectedLists = undefined;
          await recordMirrorRetry(
            fresh,
            error instanceof Error ? error.message : "Could not mirror reading lists.",
          );
        }
      }
    }));
  }
  await Promise.all(tasks);
  const stored = await chrome.storage.local.get(OLD_TX_KEY),
    tx = stored[OLD_TX_KEY] as
      | { syncSet?: Record<string, unknown>; pending?: PendingInput[] }
      | undefined;
  if (!tx) {
    await ensure();
    return;
  }
  await ensure();
  await chrome.storage.local.set({ libraryRecoveryBackup: tx });
  await chrome.storage.local.remove(OLD_TX_KEY);
}
async function syncRemoteLibraryInner() {
  const snapshot = await withLibraryLock(async () => {
    const set = await getSettings();
    if (!set?.sharedSync) return undefined;
    const s = await ensure();
    const sc = scope(set);
    return sc
      ? { set, sc, pending: s.pending.filter((op) => same(op.scope, sc)) }
      : undefined;
  });
  if (!snapshot) return { pushed: 0, pulled: 0 };
  let pushed = 0;
  try {
    for (const op of snapshot.pending) {
      if (!(await settingsMatch(snapshot.set)))
        return {
          pushed,
          pulled: 0,
          error: "Library sync settings changed; request discarded.",
        };
      const response =
        op.kind === "put"
          ? await apiFetchWithSettings(
              snapshot.set,
              `/api/v1/articles/${encodeURIComponent(op.article.id)}`,
              { method: "PUT", body: JSON.stringify(op.article) },
            )
          : await apiFetchWithSettings(
              snapshot.set,
              `/api/v1/articles/${encodeURIComponent(op.id)}`,
              { method: "DELETE" },
            );
      if (!response.ok)
        throw new Error(`Library sync failed (${response.status})`);
      let ackRevision: number | undefined;
      try {
        const ack = (await response.clone().json()) as { revision?: unknown };
        if (Number.isSafeInteger(ack.revision))
          ackRevision = Number(ack.revision);
      } catch {}
      const accepted = await withLibraryLock(async () => {
        if (!(await settingsMatch(snapshot.set))) return false;
        const latest = await ensure();
        const id = op.kind === "put" ? op.article.id : op.id;
        await chrome.storage.local.set({
          [LIBRARY_STATE_KEY]: {
            ...latest,
            pending: latest.pending.filter((p) => p.opId !== op.opId),
            watermarks:
              ackRevision === undefined
                ? latest.watermarks
                : {
                    ...latest.watermarks,
                    [id]: Math.max(latest.watermarks[id] ?? 0, ackRevision),
                  },
          },
        });
        return true;
      });
      if (!accepted)
        return {
          pushed,
          pulled: 0,
          error: "Library sync settings changed; response discarded.",
        };
      pushed++;
    }
    if (!(await settingsMatch(snapshot.set)))
      return {
        pushed,
        pulled: 0,
        error: "Library sync settings changed; request discarded.",
      };
    const response = await apiFetchWithSettings(
      snapshot.set,
      "/api/v1/articles",
    );
    if (!response.ok)
      throw new Error(`Library download failed (${response.status})`);
    const body = (await response.json()) as {
      articles?: Array<SavedArticle & { revision?: number; deleted?: boolean }>;
    };
    let pulled = 0;
    const mirrorOps: Array<{ article: SavedArticle | undefined; id: string }> =
      [];
    const accepted = await withLibraryLock(async () => {
      if (!(await settingsMatch(snapshot.set))) return false;
      let latest = await ensure();
      for (const x of body.articles ?? []) {
        const current = latest.watermarks[x.id] ?? 0;
        if (
          !x.id ||
          latest.pending.some(
            (p) =>
              same(p.scope, snapshot.sc) &&
              (p.kind === "put" ? p.article.id : p.id) === x.id,
          ) ||
          (x.revision !== undefined && current >= x.revision)
        )
          continue;
        const articles = latest.library.articles.filter((a) => a.id !== x.id);
        if (!x.deleted && valid(x)) articles.push(x);
        latest = {
          ...latest,
          library: {
            lists: x.list
              ? [...new Set([...latest.library.lists, x.list])]
              : latest.library.lists,
            articles,
          },
          watermarks: {
            ...latest.watermarks,
            ...(x.revision === undefined
              ? {}
              : { [x.id]: Math.max(current, x.revision) }),
          },
        };
        latest = withMirrorRetry(latest, {
          kind: "article",
          id: x.id,
          article: !x.deleted && valid(x) ? x : undefined,
        });
        if (x.list)
          latest = withMirrorRetry(latest, {
            kind: "lists",
            lists: latest.library.lists,
          });
        mirrorOps.push({
          article: !x.deleted && valid(x) ? x : undefined,
          id: x.id,
        });
        pulled++;
      }
      await chrome.storage.local.set({ [LIBRARY_STATE_KEY]: latest });
      return true;
    });
    if (accepted)
      for (const op of mirrorOps)
        void queueMirror(() => mirror(op.article, op.id));
    return accepted
      ? { pushed, pulled }
      : {
          pushed,
          pulled: 0,
          error: "Library sync settings changed; pulled data was discarded.",
        };
  } catch (e) {
    return {
      pushed,
      pulled: 0,
      error: e instanceof Error ? e.message : "Library sync failed.",
    };
  }
}
let syncRun: ReturnType<typeof syncRemoteLibraryInner> | undefined;
// Network reads happen outside the worker coordinator lock.  The canonical
// state is reloaded before each commit so a concurrent RPC edit remains in the
// pending journal and cannot be overwritten by a stale response.
export function syncRemoteLibrary() {
  syncRun ??= syncRemoteLibraryInner().finally(() => {
    syncRun = undefined;
  });
  return syncRun;
}
function capturePosition() {
  const scroller = document.scrollingElement ?? document.documentElement;
  const range = scroller.scrollHeight - window.innerHeight;
  const progress =
    range > 0 ? Math.min(1, Math.max(0, scroller.scrollTop / range)) : 0;
  const pinned = (node: Element | null): boolean => {
    for (; node && node !== document.body; node = node.parentElement) {
      const position = getComputedStyle(node).position;
      if (position === "fixed" || position === "sticky") return true;
    }
    return false;
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const probe = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const words = node.textContent?.trim().split(/\s+/) ?? [];
    if (
      words.length < 4 ||
      node.parentElement?.closest("script, style, noscript, textarea")
    )
      continue;
    probe.selectNodeContents(node);
    const rect = probe.getBoundingClientRect();
    if (rect.width === 0 || rect.bottom <= 0) continue;
    if (rect.top >= window.innerHeight) break;
    if (pinned(node.parentElement)) continue;
    return { snippet: words.slice(0, 8).join(" "), progress };
  }
  return { snippet: "", progress: 0 };
}
export async function saveTab(
  tab: chrome.tabs.Tab | undefined,
  list: string,
  selection?: string,
  internal = false,
): Promise<SavedArticle> {
  if (!internal && typeof chrome.runtime?.sendMessage === "function")
    return rpc<SavedArticle>({
      type: "library-save-tab",
      tab,
      list,
      selection,
    });
  if (!tab?.id || !tab.url || !/^https?:/.test(tab.url))
    throw new Error("Only web pages can be saved.");
  let pos = { snippet: "", progress: 0 };
  try {
    const [x] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: capturePosition,
    });
    if (x?.result) pos = x.result;
  } catch {}
  if (selection?.trim()) pos.snippet = snippetFrom(selection);
  const url = stripTextDirective(tab.url),
    l = await getLibrary(true),
    a: SavedArticle = {
      id: l.articles.find((x) => x.url === url)?.id ?? crypto.randomUUID(),
      url,
      title: (tab.title || url).slice(0, 300),
      list,
      ...pos,
      savedAt: Date.now(),
    },
    s = await ensure(),
    sc = scope(await getSettings());
  await chrome.storage.local.set({
    [LIBRARY_STATE_KEY]: {
      ...s,
      library: {
        lists: l.lists.includes(list) ? l.lists : [...l.lists, list],
        articles: [a, ...l.articles.filter((x) => x.id !== a.id)],
      },
      pending: pending(s, sc, { kind: "put", article: a }),
      mirrorRetryIntents: (l.lists.includes(list)
        ? withMirrorRetry(s, { kind: "article", id: a.id, article: a })
        : withMirrorRetry(
            withMirrorRetry(s, { kind: "article", id: a.id, article: a }),
            { kind: "lists", lists: [...l.lists, list] },
          )
      ).mirrorRetryIntents,
    },
  });
  if (!l.lists.includes(list)) mirrorLists([...l.lists, list]);
  void queueMirror(() => mirror(a, a.id));
  return a;
}

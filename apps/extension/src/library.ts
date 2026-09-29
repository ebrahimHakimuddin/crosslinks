import { type SavedArticle, addList, deleteList, exportLibrary, getLibrary, importLibrary, removeArticle, renameList, restoreUrl, updateArticle } from "./reading.js";
import { displayHost, faviconUrl, icon } from "./shared.js";

type Filter = "unread" | "read" | "all";

const listsNav = document.querySelector<HTMLElement>("#lists")!;
const newListForm = document.querySelector<HTMLFormElement>("#new-list")!;
const newListName = document.querySelector<HTMLInputElement>("#new-list-name")!;
const listTitle = document.querySelector<HTMLElement>("#list-title")!;
const listMeta = document.querySelector<HTMLElement>("#list-meta")!;
const renameButton = document.querySelector<HTMLButtonElement>("#rename-list")!;
const renameForm = document.querySelector<HTMLFormElement>("#rename-form")!;
const renameInput = document.querySelector<HTMLInputElement>("#rename-input")!;
const deleteButton = document.querySelector<HTMLButtonElement>("#delete-list")!;
const filters = document.querySelector<HTMLElement>("#filters")!;
const search = document.querySelector<HTMLInputElement>("#search")!;
const articlesList = document.querySelector<HTMLOListElement>("#articles")!;
const libraryStatus = document.querySelector<HTMLElement>("#library-status")!;
let current: string | undefined;
let filter: Filter = "unread";

function iconButton(name: Parameters<typeof icon>[0], label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-btn";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(icon(name));
  button.addEventListener("click", onClick);
  return button;
}

function articleRow(article: SavedArticle, lists: string[]): HTMLLIElement {
  const item = document.createElement("li");
  item.className = `article${article.readAt ? " is-read" : ""}`;
  const favicon = document.createElement("img");
  favicon.className = "favicon";
  favicon.src = faviconUrl(article.url);
  favicon.alt = "";

  const body = document.createElement("div");
  body.className = "article-body";
  const link = document.createElement("a");
  link.className = "article-title";
  link.href = restoreUrl(article);
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = article.title;
  const meta = document.createElement("p");
  meta.className = "article-meta";
  const status = article.readAt ? "Read" : article.snippet ? `${Math.round(article.progress * 100)}% read` : "Not started";
  meta.textContent = `${displayHost(article.url)} · ${status} · Saved ${new Date(article.savedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}${current ? "" : ` · ${article.list}`}`;
  body.append(link, meta);
  if (article.snippet && !article.readAt) {
    const bar = document.createElement("div");
    bar.className = "progress";
    const fill = document.createElement("span");
    fill.style.width = `${Math.round(article.progress * 100)}%`;
    bar.append(fill);
    const snippet = document.createElement("p");
    snippet.className = "snippet";
    snippet.textContent = `Resume at “${article.snippet}…”`;
    body.append(bar, snippet);
  }

  const actions = document.createElement("div");
  actions.className = "article-actions";
  // readAt 0 means unread; updateArticle merges, so the field can't simply be omitted.
  const read = iconButton("check", article.readAt ? "Mark as unread" : "Mark as read",
    () => void updateArticle(article.id, { readAt: article.readAt ? 0 : Date.now() }).then(render).catch(showError));
  read.setAttribute("aria-pressed", String(Boolean(article.readAt)));
  const move = document.createElement("select");
  move.className = "compact";
  move.setAttribute("aria-label", "Move to list");
  move.append(...lists.map((name) => new Option(name, name, false, name === article.list)));
  move.addEventListener("change", () => void updateArticle(article.id, { list: move.value }).then(render).catch(showError));
  actions.append(read, move, iconButton("trash", "Remove", () => void removeArticle(article.id).then(render).catch(showError)));
  actions.lastElementChild!.classList.add("danger");

  item.append(favicon, body, actions);
  return item;
}

function emptyState(title: string, detail: string): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "empty-state";
  const strong = document.createElement("strong");
  strong.textContent = title;
  const text = document.createElement("span");
  text.textContent = detail;
  item.append(icon("book"), strong, text);
  return item;
}

function showError(error: unknown): void { libraryStatus.textContent = error instanceof Error ? error.message : "Could not update the library."; libraryStatus.classList.add("error"); }

async function render(): Promise<void> {
  const library = await getLibrary();
  if (current && !library.lists.includes(current)) current = undefined;
  listsNav.replaceChildren(...[undefined, ...library.lists].map((name) => {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-pressed", String(name === current));
    const label = document.createElement("span");
    label.textContent = name ?? "All articles";
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = String(library.articles.filter((a) => !a.readAt && (!name || a.list === name)).length);
    button.append(label, count);
    button.addEventListener("click", () => {
      current = name;
      renameForm.hidden = true;
      listTitle.hidden = false;
      void render();
    });
    return button;
  }));

  const inList = library.articles.filter((a) => !current || a.list === current);
  const unreadCount = inList.filter((a) => !a.readAt).length;
  listTitle.textContent = current ?? "All articles";
  listMeta.textContent = `${unreadCount} unread · ${inList.length - unreadCount} read`;
  renameButton.hidden = !current;
  deleteButton.hidden = !current || library.lists.length < 2;
  for (const button of filters.querySelectorAll<HTMLButtonElement>("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.filter === filter));
  }

  const query = search.value.trim().toLowerCase();
  const articles = inList.filter((a) =>
    (filter === "all" || (filter === "read") === Boolean(a.readAt)) &&
    (!query || `${a.title} ${a.url}`.toLowerCase().includes(query))
  );
  articlesList.replaceChildren(...articles.map((article) => articleRow(article, library.lists)));
  if (articles.length > 0) return;
  if (query) articlesList.append(emptyState("No matches", "Try a different search."));
  else if (filter === "unread" && inList.length > 0) articlesList.append(emptyState("All caught up", "Everything in this list is marked as read."));
  else articlesList.append(emptyState("Nothing saved yet", "Right-click any article, press Alt+Shift+S, or use Save position in the toolbar popup."));
}

newListForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = newListName.value.trim();
  if (!name) return;
  current = name;
  newListName.value = "";
  void addList(name).then(render).catch(showError);
});

renameButton.addEventListener("click", () => {
  renameInput.value = current ?? "";
  listTitle.hidden = true;
  renameForm.hidden = false;
  renameInput.select();
});
document.querySelector("#rename-cancel")!.addEventListener("click", () => {
  renameForm.hidden = true;
  listTitle.hidden = false;
});
renameForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const from = current;
  const to = renameInput.value.trim();
  renameForm.hidden = true;
  listTitle.hidden = false;
  if (!from || !to || to === from) return;
  current = to;
  void renameList(from, to).then(render).catch(showError);
});

deleteButton.addEventListener("click", () => {
  const name = current;
  if (!name) return;
  void (async () => {
    const count = (await getLibrary()).articles.filter((a) => a.list === name).length;
    if (!confirm(`Delete "${name}" and its ${count} saved article${count === 1 ? "" : "s"}?`)) return;
    current = undefined;
    try { await deleteList(name); await render(); } catch (error) { showError(error); }
  })();
});

filters.addEventListener("click", (event) => {
  const value = (event.target as HTMLElement).closest<HTMLButtonElement>("button")?.dataset.filter as Filter | undefined;
  if (!value) return;
  filter = value;
  void render();
});
search.addEventListener("input", () => void render());
document.querySelector("#add-list")!.append(icon("plus"));
document.querySelector("#sync-note")!.prepend(icon("cloud"));
document.querySelector<HTMLButtonElement>("#export-library")!.addEventListener("click", () => void exportLibrary().then((text) => { const url = URL.createObjectURL(new Blob([text], { type: "application/json" })); const link = document.createElement("a"); link.href = url; link.download = `crosslinks-library-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(url); }).catch(showError));
const importFile = document.querySelector<HTMLInputElement>("#import-file")!;
document.querySelector<HTMLButtonElement>("#import-library")!.addEventListener("click", () => importFile.click());
importFile.addEventListener("change", () => { const file = importFile.files?.[0]; if (!file) return; void file.text().then(importLibrary).then((report) => { libraryStatus.textContent = report.failed || report.errors.length ? `Imported ${report.imported}; ${report.failed} failed. ${report.errors.join(" ")}` : `Imported ${report.imported} articles.`; return render(); }).catch(showError).finally(() => { importFile.value = ""; }); });
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "sync") void render();
});
void render().catch(showError);

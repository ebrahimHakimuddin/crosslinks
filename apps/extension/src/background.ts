import {
  ACTIVITY_KEY,
  CONNECTION_KEY,
  DELIVERY_STATES_KEY,
  type ActivityItem,
  type Delivery,
  type DeliveryState,
  apiFetch,
  apiFetchWithSettings,
  settingsMatch,
  getSettings,
  websocketUrl,
} from "./shared.js";
import type { ConnectionStatus } from "./shared.js";
import {
  ARTICLE_PREFIX,
  DEFAULT_LIST,
  LISTS_KEY,
  enqueueRemoteMutation,
  getLibrary,
  saveTab,
  syncRemoteLibrary,
  updateArticle,
  removeArticle,
  addList,
  renameList,
  deleteList,
  importLibrary,
  exportLibrary,
  seedRemoteJournal,
  handleExternalSyncChanges,
  recoverLibraryTransaction,
  clearRemoteOutbox,
} from "./reading.js";
import { withLibraryLock } from "./library-lock.js";

const POLL_ALARM = "poll-deliveries";
const LIBRARY_ALARM = "poll-library";
const NOTIFICATION_PREFIX = "linksync:";
let liveSocket: WebSocket | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let draining = false;
async function setConnection(
  state: ConnectionStatus["state"],
  message?: string,
): Promise<void> {
  await chrome.storage.local.set({
    [CONNECTION_KEY]: {
      state,
      ...(message ? { message } : {}),
      at: Date.now(),
    } satisfies ConnectionStatus,
  });
}

async function addActivity(item: ActivityItem): Promise<void> {
  const stored = await chrome.storage.local.get(ACTIVITY_KEY);
  const activity = (stored[ACTIVITY_KEY] as ActivityItem[] | undefined) ?? [];
  await chrome.storage.local.set({
    [ACTIVITY_KEY]: [item, ...activity].slice(0, 25),
  });
}

async function deliveryStates(): Promise<Record<string, DeliveryState>> {
  const stored = await chrome.storage.local.get(DELIVERY_STATES_KEY);
  return (
    (stored[DELIVERY_STATES_KEY] as
      | Record<string, DeliveryState>
      | undefined) ?? {}
  );
}

async function setDeliveryState(
  id: string,
  state: DeliveryState,
): Promise<void> {
  const states = await deliveryStates();
  states[id] = state;
  const entries = Object.entries(states)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, 500);
  await chrome.storage.local.set({
    [DELIVERY_STATES_KEY]: Object.fromEntries(entries),
  });
}

async function acknowledge(
  settings: Awaited<ReturnType<typeof getSettings>>,
  id: string,
  status: "delivered" | "failed",
  reason?: string,
): Promise<void> {
  if (!settings || !(await settingsMatch(settings)))
    throw new Error("Pairing settings changed; acknowledgement was not sent.");
  const response = await apiFetchWithSettings(
    settings,
    `/api/v1/deliveries/${encodeURIComponent(id)}/ack`,
    {
      method: "POST",
      body: JSON.stringify({ status, ...(reason ? { reason } : {}) }),
    },
  );
  if (!(await settingsMatch(settings)))
    throw new Error("Pairing settings changed; acknowledgement was discarded.");
  if (!response.ok && response.status !== 409)
    throw new Error(`Acknowledgement failed (${response.status})`);
}

export async function handleDelivery(delivery: Delivery): Promise<void> {
  const settings = await getSettings();
  if (!settings || settings.paused) return;
  const states = await deliveryStates();
  const known = states[delivery.id];
  if (known?.phase === "handled") {
    await acknowledge(
      settings,
      delivery.id,
      known.outcome ?? "delivered",
      known.reason,
    );
    return;
  }
  if (known?.phase === "opening") {
    await acknowledge(
      settings,
      delivery.id,
      "failed",
      "Browser restarted while tab creation was in progress",
    );
    await setDeliveryState(delivery.id, {
      phase: "handled",
      url: delivery.url,
      at: Date.now(),
      outcome: "failed",
      reason: "Browser restarted while tab creation was in progress",
    });
    return;
  }

  await setDeliveryState(delivery.id, {
    phase: "opening",
    url: delivery.url,
    at: Date.now(),
  });
  try {
    if (settings.autoOpen) {
      await chrome.tabs.create({ url: delivery.url, active: true });
      await addActivity({
        deliveryId: delivery.id,
        url: delivery.url,
        outcome: "opened",
        at: Date.now(),
      });
    } else {
      await chrome.notifications.create(
        `${NOTIFICATION_PREFIX}${delivery.id}`,
        {
          type: "basic",
          iconUrl: "icons/icon-128.png",
          title: "Link received",
          message: delivery.url,
          contextMessage: "Click to open in a new tab",
          priority: 1,
        },
      );
      await chrome.storage.local.set({
        [`pending:${delivery.id}`]: delivery.url,
      });
      await addActivity({
        deliveryId: delivery.id,
        url: delivery.url,
        outcome: "notified",
        at: Date.now(),
      });
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown browser error";
    await addActivity({
      deliveryId: delivery.id,
      url: delivery.url,
      outcome: "failed",
      at: Date.now(),
    });
    await setDeliveryState(delivery.id, {
      phase: "handled",
      url: delivery.url,
      at: Date.now(),
      outcome: "failed",
      reason: message,
    });
    await acknowledge(settings, delivery.id, "failed", message);
    return;
  }
  // Outside the try: a network error here must not report an opened tab as failed.
  await setDeliveryState(delivery.id, {
    phase: "handled",
    url: delivery.url,
    at: Date.now(),
    outcome: "delivered",
  });
  await acknowledge(settings, delivery.id, "delivered");
}

async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    const settings = await getSettings();
    if (!settings || settings.paused) return;
    for (let count = 0; count < 50; count += 1) {
      const response = await apiFetchWithSettings(
        settings,
        "/api/v1/deliveries/next",
      );
      if (!(await settingsMatch(settings)))
        throw new Error(
          "Pairing settings changed; queued delivery was discarded.",
        );
      if (!response.ok)
        throw new Error(`Queue fetch failed (${response.status})`);
      const delivery = (await response.json()) as Delivery | null;
      if (!delivery) break;
      await handleDelivery(delivery);
    }
  } catch (error) {
    await setConnection(
      "offline",
      error instanceof Error ? error.message : "Server is unavailable",
    );
  } finally {
    draining = false;
  }
}

function closeLiveSocket(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  reconnectTimer = undefined;
  heartbeatTimer = undefined;
  liveSocket?.close();
  liveSocket = undefined;
}

async function connectLive(): Promise<void> {
  closeLiveSocket();
  if (typeof WebSocket === "undefined") return;
  const settings = await getSettings();
  if (!settings || settings.paused) return;
  await setConnection("connecting");
  const socket = new WebSocket(websocketUrl(settings.serverUrl));
  liveSocket = socket;
  socket.addEventListener("open", () =>
    socket.send(
      JSON.stringify({ type: "authenticate", token: settings.token }),
    ),
  );
  socket.addEventListener("message", (event) => {
    let message: { type?: string };
    try {
      message = JSON.parse(String(event.data)) as { type?: string };
    } catch {
      return;
    }
    if (message.type === "authenticated") {
      void setConnection("online");
      void drainQueue();
    } else if (message.type === "delivery_available") void drainQueue();
  });
  socket.addEventListener(
    "error",
    () =>
      void setConnection("offline", "Could not reach the CrossLinks server"),
  );
  socket.addEventListener("close", () => {
    if (liveSocket !== socket) return;
    liveSocket = undefined;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    void setConnection("offline", "Server connection lost — retrying");
    reconnectTimer = setTimeout(() => void connectLive(), 5_000);
  });
  heartbeatTimer = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ type: "heartbeat" }));
  }, 20_000);
}

chrome.runtime.onInstalled.addListener(() => {
  void rebuildMenus();
  void chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 });
  void chrome.alarms.create(LIBRARY_ALARM, { periodInMinutes: 5 });
  void recoverLibraryTransaction().then(() =>
    Promise.all([connectLive(), syncRemoteLibrary()]),
  );
});
chrome.runtime.onStartup.addListener(() => {
  void rebuildMenus();
  void recoverLibraryTransaction().then(() =>
    Promise.all([connectLive(), syncRemoteLibrary()]),
  );
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) void drainQueue();
  if (alarm.name === LIBRARY_ALARM)
    void recoverLibraryTransaction().then(() => syncRemoteLibrary());
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) void connectLive();
  if (area === "local" && changes.settings) void syncRemoteLibrary();
  if (
    area === "sync" &&
    Object.keys(changes).some(
      (key) => key === LISTS_KEY || key.startsWith(ARTICLE_PREFIX),
    )
  ) {
    void withLibraryLock(() => handleExternalSyncChanges(changes)).then(() =>
      syncRemoteLibrary(),
    );
  }
});
chrome.runtime.onMessage.addListener(
  (
    message: {
      type?: string;
      mutation?: unknown;
      action?: string;
      id?: string;
      name?: string;
      from?: string;
      to?: string;
      patch?: unknown;
      tab?: chrome.tabs.Tab;
      list?: string;
      selection?: string;
      raw?: string;
    },
    _sender,
    sendResponse,
  ) => {
    if (message.type === "library-read") {
      void withLibraryLock(() => getLibrary(true))
        .then((value) => sendResponse({ ok: true, value }))
        .catch((error) =>
          sendResponse({
            ok: false,
            message:
              error instanceof Error
                ? error.message
                : "Could not read the library.",
          }),
        );
      return true;
    }
    if (message.type === "library-save-tab" && message.tab && message.list) {
      void withLibraryLock(() =>
        saveTab(message.tab, message.list!, message.selection, true),
      )
        .then((value) => sendResponse({ ok: true, value }))
        .catch((error) =>
          sendResponse({
            ok: false,
            message:
              error instanceof Error
                ? error.message
                : "Could not save this page.",
          }),
        );
      return true;
    }
    if (message.type === "library-import" && typeof message.raw === "string") {
      void withLibraryLock(() => importLibrary(message.raw!, true))
        .then((value) => sendResponse({ ok: true, value }))
        .catch((error) =>
          sendResponse({
            ok: false,
            message:
              error instanceof Error
                ? error.message
                : "Could not import the library.",
          }),
        );
      return true;
    }
    if (message.type === "library-export") {
      void withLibraryLock(() => exportLibrary(true))
        .then((value) => sendResponse({ ok: true, value }))
        .catch((error) =>
          sendResponse({
            ok: false,
            message:
              error instanceof Error
                ? error.message
                : "Could not export the library.",
          }),
        );
      return true;
    }
    if (message.type === "library-enable-sync") {
      void withLibraryLock(async () => {
        const settings = await getSettings();
        if (!settings) throw new Error("LinkSync is not paired");
        const consentEpoch = (settings.consentEpoch ?? 0) + 1;
        if (message.action === "enable") {
          // Seed while the old scope is still active, then atomically advance the
          // epoch. Requests created before this point can never commit afterwards.
          await clearRemoteOutbox();
          await seedRemoteJournal({
            ...settings,
            sharedSync: true,
            consentEpoch,
          });
          await chrome.storage.local.set({
            settings: { ...settings, sharedSync: true, consentEpoch },
          });
        } else
          await chrome.storage.local.set({
            settings: { ...settings, sharedSync: false, consentEpoch },
          });
      })
        .then(() => sendResponse({ ok: true }))
        .catch((error) =>
          sendResponse({
            ok: false,
            message:
              error instanceof Error
                ? error.message
                : "Could not change library sync.",
          }),
        );
      return true;
    }
    if (message.type === "library-forget") {
      void withLibraryLock(async () => {
        const settings = await getSettings();
        // Retain the epoch marker briefly so a blocked response cannot be
        // accepted after a later account is paired (the next pairing increments
        // it again).
        await chrome.storage.local.set({
          consentEpoch: (settings?.consentEpoch ?? 0) + 1,
        });
        await clearRemoteOutbox();
        await chrome.storage.local.remove([
          "settings",
          "libraryRemoteJournal",
          "libraryRemoteState",
          "libraryRemoteError",
        ]);
      })
        .then(() => sendResponse({ ok: true }))
        .catch((error) =>
          sendResponse({
            ok: false,
            message:
              error instanceof Error
                ? error.message
                : "Could not forget this browser.",
          }),
        );
      return true;
    }
    if (message.type === "library-mutation" && message.mutation) {
      void withLibraryLock(() =>
        enqueueRemoteMutation(
          message.mutation as Parameters<typeof enqueueRemoteMutation>[0],
        ),
      )
        .then(() => sendResponse({ ok: true }))
        .catch((error) =>
          sendResponse({
            ok: false,
            message:
              error instanceof Error
                ? error.message
                : "Could not queue library change.",
          }),
        );
      return true;
    }
    if (message.type === "library-action") {
      const action = message.action as string;
      const done = withLibraryLock(() =>
        action === "update"
          ? updateArticle(
              String(message.id),
              (message.patch ?? {}) as Record<string, unknown>,
              true,
            )
          : action === "remove"
            ? removeArticle(String(message.id), true)
            : action === "add-list"
              ? addList(String(message.name), true)
              : action === "rename-list"
                ? renameList(String(message.from), String(message.to), true)
                : action === "delete-list"
                  ? deleteList(String(message.name), true)
                  : Promise.reject(new Error("Unknown library action")),
      );
      void done
        .then(() => sendResponse({ ok: true }))
        .catch((error) =>
          sendResponse({
            ok: false,
            message:
              error instanceof Error ? error.message : "Library update failed.",
          }),
        );
      return true;
    }
    if (message.type !== "sync-now") return;
    void Promise.all([drainQueue(), syncRemoteLibrary()])
      .then(([, library]) =>
        sendResponse({ ok: !library.error, message: library.error }),
      )
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          message:
            error instanceof Error
              ? error.message
              : "Could not check for links",
        });
      });
    return true;
  },
);
const MENU_PREFIX = "save:";

let menuQueue = Promise.resolve();

// Serialized: overlapping removeAll/create runs would collide on duplicate menu ids.
function rebuildMenus(): Promise<void> {
  menuQueue = menuQueue.then(buildMenus, buildMenus);
  return menuQueue;
}

async function buildMenus(): Promise<void> {
  const { lists } = await getLibrary(true);
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: "save",
    title: "Save reading position to",
    contexts: ["page", "selection"],
  });
  for (const list of lists)
    chrome.contextMenus.create({
      id: MENU_PREFIX + list,
      parentId: "save",
      title: list,
      contexts: ["page", "selection"],
    });
}

function saveWithBadge(
  tab: chrome.tabs.Tab | undefined,
  list: string,
  selection?: string,
): Promise<void> {
  if (!tab?.id) return Promise.resolve();
  const tabId = tab.id;
  return saveTab(tab, list, selection, true)
    .then(() => chrome.action.setBadgeText({ tabId, text: "✓" }))
    .catch(() => chrome.action.setBadgeText({ tabId, text: "!" }));
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "save-position") return saveWithBadge(tab, DEFAULT_LIST);
  return undefined;
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  const id = String(info.menuItemId);
  if (id.startsWith(MENU_PREFIX))
    return saveWithBadge(tab, id.slice(MENU_PREFIX.length), info.selectionText);
  return undefined;
});
chrome.storage.onChanged.addListener((changes, area) => {
  // Article keys matter too: saving to a list another device created adds it to the menu.
  if (
    area === "sync" &&
    Object.keys(changes).some(
      (key) => key === LISTS_KEY || key.startsWith(ARTICLE_PREFIX),
    )
  )
    void rebuildMenus();
});
chrome.notifications.onClicked.addListener((notificationId) => {
  if (!notificationId.startsWith(NOTIFICATION_PREFIX)) return;
  const deliveryId = notificationId.slice(NOTIFICATION_PREFIX.length);
  void (async () => {
    const key = `pending:${deliveryId}`;
    const stored = await chrome.storage.local.get(key);
    const url = stored[key] as string | undefined;
    if (url) await chrome.tabs.create({ url, active: true });
    await chrome.storage.local.remove(key);
    await chrome.notifications.clear(notificationId);
  })();
});

void chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 });
void chrome.alarms.create(LIBRARY_ALARM, { periodInMinutes: 5 });
void recoverLibraryTransaction().then(() => connectLive());

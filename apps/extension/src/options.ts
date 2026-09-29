import { apiFetch, SETTINGS_KEY, getSettings, normalizeServerUrl, originPermission } from "./shared.js";
import { exportLibrary, getLibrary, importLibrary } from "./reading.js";

const form = document.querySelector<HTMLFormElement>("#pair-form")!;
const serverInput = document.querySelector<HTMLInputElement>("#server-url")!;
const codeInput = document.querySelector<HTMLInputElement>("#pairing-code")!;
const nameInput = document.querySelector<HTMLInputElement>("#device-name")!;
const autoOpenInput = document.querySelector<HTMLInputElement>("#auto-open")!;
const pairPanel = document.querySelector<HTMLElement>("#pair-panel")!;
const pairedSection = document.querySelector<HTMLElement>("#paired")!;
const pairedCopy = document.querySelector<HTMLElement>("#paired-copy")!;
const pairedAutoOpen = document.querySelector<HTMLInputElement>("#paired-auto-open")!;
const sharedSyncInput = document.querySelector<HTMLInputElement>("#shared-sync")!;
const unpair = document.querySelector<HTMLButtonElement>("#unpair")!;
const status = document.querySelector<HTMLElement>("#status")!;
const versionsCopy = document.querySelector<HTMLElement>("#versions-copy")!;
const checkVersions = document.querySelector<HTMLButtonElement>("#check-versions")!;

function setStatus(message: string, error = false): void {
  status.textContent = message;
  status.classList.toggle("error", error);
}

async function render(): Promise<void> {
  const settings = await getSettings();
  pairPanel.hidden = Boolean(settings);
  pairedSection.hidden = !settings;
  if (settings) {
    pairedCopy.textContent = `${settings.deviceName} is connected to ${settings.serverUrl}.`;
    pairedAutoOpen.checked = settings.autoOpen;
    sharedSyncInput.checked = Boolean(settings.sharedSync);
  } else {
    nameInput.value ||= `${navigator.platform || "Chrome"} browser`;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void (async () => {
    const button = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
    button.disabled = true;
    try {
      const serverUrl = normalizeServerUrl(serverInput.value);
      const permission = originPermission(serverUrl);
      const granted = await chrome.permissions.request({ origins: [permission] });
      if (!granted) throw new Error("Server access permission was not granted.");
      const response = await fetch(new URL("/api/v1/pair", serverUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: codeInput.value.trim().toUpperCase(),
          name: nameInput.value.trim(),
          deviceKind: "chrome",
          autoOpen: autoOpenInput.checked
        })
      });
      const result = await response.json() as { deviceId?: string; token?: string; error?: string };
      if (!response.ok || !result.deviceId || !result.token) throw new Error(result.error ?? `Pairing failed (${response.status})`);
      await chrome.storage.local.set({
        [SETTINGS_KEY]: {
          serverUrl,
          token: result.token,
          deviceId: result.deviceId,
          deviceName: nameInput.value.trim(),
          autoOpen: autoOpenInput.checked,
          paused: false,
          sharedSync: false,
          consentEpoch: ((await chrome.storage.local.get("consentEpoch")).consentEpoch as number | undefined ?? 0) + 1
        }
      });
      setStatus("Browser paired successfully.");
      await render();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Pairing failed.", true);
    } finally {
      button.disabled = false;
    }
  })();
});

pairedAutoOpen.addEventListener("change", () => {
  void (async () => {
    const settings = await getSettings();
    if (!settings) return;
    await chrome.storage.local.set({ [SETTINGS_KEY]: { ...settings, autoOpen: pairedAutoOpen.checked } });
    setStatus("Preference saved.");
  })();
});

sharedSyncInput.addEventListener("change", () => {
  void (async () => {
    const settings = await getSettings();
    if (!settings) { sharedSyncInput.checked = false; setStatus("Pair this browser before enabling library sync.", true); return; }
    if (sharedSyncInput.checked && !confirm("Share article metadata with this server and paired devices?")) { sharedSyncInput.checked = false; return; }
    const response = await chrome.runtime.sendMessage({ type: "library-enable-sync", action: sharedSyncInput.checked ? "enable" : "disable" }) as { ok?: boolean; message?: string };
    if (!response?.ok) throw new Error(response?.message ?? "Could not change library sync.");
    setStatus(sharedSyncInput.checked ? "Server library sync enabled." : "Server library sync disabled.");
  })().catch((error) => setStatus(error instanceof Error ? error.message : "Could not change library sync.", true));
});

unpair.addEventListener("click", () => {
  void (async () => {
    const settings = await getSettings();
    // Keep the Chrome library and retained legacy data; reset only scoped remote state.
    const forgotten = await chrome.runtime.sendMessage({ type: "library-forget" }) as { ok?: boolean; message?: string };
    if (!forgotten?.ok) throw new Error(forgotten?.message ?? "Could not forget this browser.");
    if (settings) await chrome.permissions.remove({ origins: [originPermission(settings.serverUrl)] });
    setStatus("Local credentials removed. Revoke this browser in the server admin page as well.");
    await render();
  })();
});

checkVersions.addEventListener("click", () => {
  void (async () => {
    checkVersions.disabled = true;
    versionsCopy.textContent = "Checking…";
    try {
      const response = await apiFetch("/api/v1/version");
      if (!response.ok) throw new Error(`Version check failed (${response.status})`);
      const versions = await response.json() as { server: string; android: string; extension: string };
      const extension = chrome.runtime.getManifest().version;
      const health = extension === versions.extension && versions.extension === versions.android ? "All components match" : "A component update may be available";
      versionsCopy.textContent = `${health} · extension ${extension} · server ${versions.server} · Android ${versions.android}`;
    } catch (error) {
      versionsCopy.textContent = error instanceof Error ? error.message : "Version check failed.";
    } finally {
      checkVersions.disabled = false;
    }
  })();
});

async function renderLibrary(): Promise<void> {
  const { articles } = await getLibrary();
  const used = await chrome.storage.sync.getBytesInUse(null);
  const share = used / chrome.storage.sync.QUOTA_BYTES;
  document.querySelector("#library-count")!.textContent = `${articles.length} saved article${articles.length === 1 ? "" : "s"}`;
  document.querySelector("#library-usage")!.textContent = `${Math.round(share * 100)}% of Chrome sync storage used`;
  document.querySelector<HTMLElement>("#usage-bar")!.style.width = `${Math.max(2, Math.round(share * 100))}%`;
  const [command] = (await chrome.commands.getAll()).filter((c) => c.name === "save-position");
  document.querySelector("#shortcut")!.textContent = command?.shortcut || "Not set";
}

document.querySelector("#open-library")!.addEventListener("click", () => void chrome.tabs.create({ url: "library.html" }));
document.querySelector("#shortcuts")!.addEventListener("click", () => void chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));
document.querySelector<HTMLButtonElement>("#export-library")!.addEventListener("click", () => {
  void exportLibrary().then((text) => {
    const blob = new Blob([text], { type: "application/json" }); const url = URL.createObjectURL(blob); const link = document.createElement("a");
    link.href = url; link.download = `crosslinks-library-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(url); setStatus("Library backup downloaded.");
  }).catch((error) => setStatus(error instanceof Error ? error.message : "Could not export library.", true));
});
const importFile = document.querySelector<HTMLInputElement>("#import-file")!;
document.querySelector<HTMLButtonElement>("#import-library")!.addEventListener("click", () => importFile.click());
importFile.addEventListener("change", () => {
  const file = importFile.files?.[0]; if (!file) return;
  void file.text().then(importLibrary).then((report) => setStatus(report.failed || report.errors.length ? `Imported ${report.imported}; ${report.failed} failed. ${report.errors.join(" ")}` : `Imported ${report.imported} article${report.imported === 1 ? "" : "s"}; ${report.skipped} already existed.`)).catch((error) => setStatus(error instanceof Error ? error.message : "Could not import library.", true)).finally(() => { importFile.value = ""; });
});
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "sync") void renderLibrary();
});
void render();
void renderLibrary();

export interface ExtensionSettings {
  serverUrl: string;
  token: string;
  deviceId: string;
  deviceName: string;
  autoOpen: boolean;
  paused: boolean;
  sharedSync?: boolean;
  /** Monotonically changes whenever sync consent or account scope changes. */
  consentEpoch?: number;
}

export interface Delivery {
  id: string;
  url: string;
  status: "queued";
  created_at: number;
  expires_at: number;
}

export interface ActivityItem {
  deliveryId: string;
  url: string;
  outcome: "opened" | "notified" | "failed";
  at: number;
}

export interface DeliveryState {
  phase: "opening" | "handled";
  url: string;
  at: number;
  outcome?: "delivered" | "failed";
  reason?: string;
}

export const SETTINGS_KEY = "settings";
export const ACTIVITY_KEY = "activity";
export const DELIVERY_STATES_KEY = "deliveryStates";
export const CONNECTION_KEY = "connection";
export const LIBRARY_SYNC_KEY = "librarySync";

export type ConnectionStatus = {
  state: "connecting" | "online" | "offline";
  message?: string;
  at: number;
};

export function normalizeServerUrl(raw: string): string {
  const url = new URL(raw.trim());
  const loopback = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  if (url.protocol !== "https:" && !loopback) throw new Error("Use HTTPS. HTTP is allowed only for local development.");
  if (url.username || url.password || url.search || url.hash) throw new Error("Enter the server origin without credentials, a query, or a fragment.");
  return url.origin;
}

export function originPermission(serverUrl: string): string {
  return `${new URL(serverUrl).origin}/*`;
}

export function websocketUrl(serverUrl: string): string {
  const url = new URL("/api/v1/live", serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export async function getSettings(): Promise<ExtensionSettings | undefined> {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return result[SETTINGS_KEY] as ExtensionSettings | undefined;
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const settings = await getSettings();
  if (!settings) throw new Error("LinkSync is not paired");
  const response = await apiFetchWithSettings(settings, path, init);
  if (!(await settingsMatch(settings))) throw new Error("Pairing settings changed; response was discarded.");
  return response;
}

export type ApiSettingsSnapshot = ExtensionSettings;

export async function apiFetchWithSettings(settings: ApiSettingsSnapshot, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${settings.token}`);
  if (init.body) headers.set("Content-Type", "application/json");
  return fetch(new URL(path, settings.serverUrl), { ...init, headers });
}

export async function settingsMatch(snapshot: ApiSettingsSnapshot): Promise<boolean> {
  const current = await getSettings();
  return Boolean(current && current.serverUrl === snapshot.serverUrl && current.deviceId === snapshot.deviceId && current.token === snapshot.token && current.sharedSync === snapshot.sharedSync && (current.consentEpoch ?? 0) === (snapshot.consentEpoch ?? 0));
}

export function displayHost(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

const ICON_PATHS = {
  check: "M20 6 9 17l-5-5",
  trash: "M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14",
  plus: "M12 5v14M5 12h14",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z",
  cloud: "M17.5 19a4.5 4.5 0 1 0-1.4-8.8A6 6 0 0 0 4.5 12.5 3.5 3.5 0 0 0 6 19Z",
  book: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5v14ZM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"
} as const;

export function icon(name: keyof typeof ICON_PATHS): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICON_PATHS[name]);
  svg.append(path);
  return svg;
}

export function faviconUrl(pageUrl: string): string {
  return chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(pageUrl)}&size=32`);
}

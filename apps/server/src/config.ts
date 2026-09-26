import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

export interface Config {
  host: string;
  port: number;
  databasePath: string;
  publicUrl: string;
  lanUrl?: string;
  setupToken?: string;
  secureCookies: boolean;
  deliveryTtlMs: number;
  historyTtlMs: number;
  pairingTtlMs: number;
  /** Reverse proxies allowed to provide the left-most untrusted X-Forwarded-For address. */
  trustedProxyCidrs?: string[];
}

function normalizedUrl(value: string, name: string): string {
  const url = new URL(value);
  const developmentLoopback = url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  if (url.protocol !== "https:" && !developmentLoopback) {
    throw new Error(`${name} must use HTTPS (HTTP is allowed only on loopback)`);
  }
  return url.toString().replace(/\/$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = resolve(env.LINKSYNC_DATA_DIR ?? "./data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const publicUrl = normalizedUrl(env.LINKSYNC_PUBLIC_URL ?? "http://localhost:8787", "LINKSYNC_PUBLIC_URL");
  const lanUrl = env.LINKSYNC_LAN_URL
    ? normalizedUrl(env.LINKSYNC_LAN_URL, "LINKSYNC_LAN_URL")
    : undefined;
  const trustedProxyCidrs = (env.LINKSYNC_TRUSTED_PROXY_CIDRS ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean);

  return {
    host: env.LINKSYNC_HOST ?? "127.0.0.1",
    port: Number.parseInt(env.LINKSYNC_PORT ?? "8787", 10),
    databasePath: resolve(dataDir, "linksync.db"),
    publicUrl,
    ...(lanUrl ? { lanUrl } : {}),
    ...(env.LINKSYNC_SETUP_TOKEN ? { setupToken: env.LINKSYNC_SETUP_TOKEN } : {}),
    secureCookies: publicUrl.startsWith("https://"),
    deliveryTtlMs: 7 * 24 * 60 * 60 * 1_000,
    historyTtlMs: 30 * 24 * 60 * 60 * 1_000,
    pairingTtlMs: 5 * 60 * 1_000,
    trustedProxyCidrs
  };
}

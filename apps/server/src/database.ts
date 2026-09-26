import Database from "better-sqlite3";

export type DeviceKind = "android" | "chrome";
export type DeliveryStatus = "queued" | "delivered" | "expired" | "failed";

export interface DeviceRow {
  id: string;
  name: string;
  kind: DeviceKind;
  auto_open: number;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
  removed_at?: number | null;
}

export interface DeliveryRow {
  id: string;
  url: string;
  source_device_id: string;
  target_device_id: string;
  status: DeliveryStatus;
  created_at: number;
  expires_at: number;
  delivered_at: number | null;
  failure_reason: string | null;
}

export class LinkSyncDatabase {
  readonly raw: Database.Database;

  constructor(path: string) {
    this.raw = new Database(path);
    this.raw.pragma("journal_mode = WAL");
    this.raw.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS owner (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admin_sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pairing_grants (
        id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        device_kind TEXT NOT NULL CHECK (device_kind IN ('android', 'chrome')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('android', 'chrome')),
        token_hash TEXT NOT NULL UNIQUE,
        auto_open INTEGER NOT NULL DEFAULT 0 CHECK (auto_open IN (0, 1)),
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        revoked_at INTEGER,
        removed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS devices_token_hash_idx ON devices(token_hash);
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL,
        url TEXT NOT NULL,
        source_device_id TEXT NOT NULL REFERENCES devices(id),
        target_device_id TEXT NOT NULL REFERENCES devices(id),
        status TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'expired', 'failed')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        delivered_at INTEGER,
        failure_reason TEXT,
        UNIQUE(source_device_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS deliveries_target_status_idx
        ON deliveries(target_device_id, status, created_at);
      CREATE TABLE IF NOT EXISTS delivery_receipts (
        source_device_id TEXT NOT NULL REFERENCES devices(id),
        idempotency_key TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        url TEXT,
        target_device_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'expired', 'failed')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        delivered_at INTEGER,
        failure_reason TEXT,
        PRIMARY KEY(source_device_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS delivery_receipts_created_idx ON delivery_receipts(created_at);
      CREATE TABLE IF NOT EXISTS articles (
        id TEXT PRIMARY KEY,
        url TEXT,
        title TEXT,
        list_name TEXT,
        snippet TEXT,
        progress REAL,
        saved_at INTEGER,
        read_at INTEGER,
        revision INTEGER NOT NULL,
        deleted INTEGER NOT NULL CHECK (deleted IN (0, 1))
      );
      CREATE INDEX IF NOT EXISTS articles_revision_idx ON articles(revision);
      INSERT OR IGNORE INTO metadata(key, value) VALUES ('article_revision', '0');
    `);
    this.raw.exec(`
      INSERT OR IGNORE INTO delivery_receipts(source_device_id, idempotency_key, delivery_id, url, target_device_id, status, created_at, expires_at, delivered_at, failure_reason)
      SELECT source_device_id, idempotency_key, id, url, target_device_id, status, created_at, expires_at, delivered_at, failure_reason FROM deliveries;
      UPDATE delivery_receipts
      SET delivery_id = (SELECT d.id FROM deliveries d WHERE d.source_device_id = delivery_receipts.source_device_id AND d.idempotency_key = delivery_receipts.idempotency_key),
          target_device_id = (SELECT d.target_device_id FROM deliveries d WHERE d.id = delivery_receipts.delivery_id),
          status = (SELECT d.status FROM deliveries d WHERE d.id = delivery_receipts.delivery_id),
          url = (SELECT d.url FROM deliveries d WHERE d.id = delivery_receipts.delivery_id),
          created_at = (SELECT d.created_at FROM deliveries d WHERE d.id = delivery_receipts.delivery_id),
          expires_at = (SELECT d.expires_at FROM deliveries d WHERE d.id = delivery_receipts.delivery_id),
          delivered_at = (SELECT d.delivered_at FROM deliveries d WHERE d.id = delivery_receipts.delivery_id),
          failure_reason = (SELECT d.failure_reason FROM deliveries d WHERE d.id = delivery_receipts.delivery_id)
      WHERE delivery_id IN (SELECT id FROM deliveries);
    `);
    // Additive migration for databases created before device removal existed.
    const columns = this.raw.prepare("PRAGMA table_info(devices)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "removed_at")) {
      this.raw.exec("ALTER TABLE devices ADD COLUMN removed_at INTEGER");
    }
  }

  close(): void {
    this.raw.close();
  }
}

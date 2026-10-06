import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

export function openDb(dbPath: string): DatabaseSync {
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS ledgers (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      multiplier TEXT NOT NULL,
      margin_rate_bp TEXT NOT NULL,
      init_equity TEXT NOT NULL,
      equity TEXT NOT NULL,
      position TEXT NOT NULL,
      settle_price TEXT NOT NULL,
      next_seq INTEGER NOT NULL,
      current_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS days (
      ledger_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      version INTEGER NOT NULL,
      payload TEXT NOT NULL,
      result TEXT NOT NULL,
      idempotency_key TEXT,
      payload_hash TEXT,
      superseded INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      PRIMARY KEY (ledger_id, seq, version)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_days_idem
      ON days (ledger_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS trades (
      ledger_id TEXT NOT NULL,
      trade_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      version INTEGER NOT NULL,
      PRIMARY KEY (ledger_id, trade_id)
    );
  `);
  return db;
}

export function defaultDbPath(): string {
  return process.env.LEDGER_DB ?? path.join(process.cwd(), "data", "ledger.db");
}

import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS venues (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  currency_symbol TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tables (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('public','private')),
  device_id TEXT,
  price_per_use INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS queue_entries (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL,
  table_id TEXT NOT NULL,
  song_title TEXT NOT NULL,
  song_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','playing','done','cancelled')),
  queued_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS background_playlist_tracks (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  song_ref TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS venue_playlist_state (
  venue_id TEXT PRIMARY KEY,
  cursor INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pairing_tokens (
  token TEXT PRIMARY KEY,
  table_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS player_tokens (
  token TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export function openDatabase(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

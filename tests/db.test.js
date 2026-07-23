import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";

test("openDatabase creates all expected tables", () => {
  const db = openDatabase();
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);

  assert.deepEqual(rows, [
    "background_playlist_tracks",
    "pairing_tokens",
    "player_tokens",
    "queue_entries",
    "tables",
    "venue_playlist_state",
    "venues",
  ]);
  db.close();
});

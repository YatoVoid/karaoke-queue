import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";
import { createPairing, resolveToken } from "../src/pairing.js";

const VENUE = "venue-1";

function seedTable(db, id, kind = "public") {
  db.prepare(
    "INSERT INTO tables (id, venue_id, label, kind, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, VENUE, id, kind, new Date().toISOString());
}

test("createPairing then resolveToken returns the right table/venue", () => {
  const db = openDatabase();
  seedTable(db, "table-1", "private");

  const token = createPairing(db, "table-1");
  const resolved = resolveToken(db, token);

  assert.ok(token.length > 10);
  assert.equal(resolved.tableId, "table-1");
  assert.equal(resolved.venueId, VENUE);
  assert.equal(resolved.kind, "private");
});

test("resolveToken returns null for an unknown token", () => {
  const db = openDatabase();
  assert.equal(resolveToken(db, "not-a-real-token"), null);
});

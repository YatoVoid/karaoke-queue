import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";
import { createPlayerPairing, resolvePlayerToken } from "../src/playerPairing.js";

test("createPlayerPairing then resolvePlayerToken returns the right venue", () => {
  const db = openDatabase();
  const token = createPlayerPairing(db, "venue-1");
  const resolved = resolvePlayerToken(db, token);

  assert.ok(token.length > 10);
  assert.equal(resolved.venueId, "venue-1");
});

test("resolvePlayerToken returns null for an unknown token", () => {
  const db = openDatabase();
  assert.equal(resolvePlayerToken(db, "not-a-real-token"), null);
});

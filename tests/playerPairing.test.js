import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";
import { createPlayerPairing, resolvePlayerToken } from "../src/playerPairing.js";

test("createPlayerPairing then resolvePlayerToken returns the right venue", () => {
  const db = openDatabase();
  const token = createPlayerPairing(db, "venue-1");
  const resolved = resolvePlayerToken(db, token);

  assert.equal(token.length, 6);
  assert.equal(resolved.venueId, "venue-1");
});

test("createPlayerPairing tokens are typeable on a TV remote (no ambiguous characters)", () => {
  const db = openDatabase();
  const token = createPlayerPairing(db, "venue-1");

  assert.match(token, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]+$/);
});

test("resolvePlayerToken is case-insensitive", () => {
  const db = openDatabase();
  const token = createPlayerPairing(db, "venue-1");
  const resolved = resolvePlayerToken(db, token.toLowerCase());

  assert.equal(resolved.venueId, "venue-1");
});

test("resolvePlayerToken returns null for an unknown token", () => {
  const db = openDatabase();
  assert.equal(resolvePlayerToken(db, "not-a-real-token"), null);
});

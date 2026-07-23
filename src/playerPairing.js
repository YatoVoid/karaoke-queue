import { randomUUID } from "node:crypto";

export function createPlayerPairing(db, venueId) {
  const token = randomUUID();
  db.prepare(
    "INSERT INTO player_tokens (token, venue_id, created_at) VALUES (?, ?, ?)",
  ).run(token, venueId, new Date().toISOString());
  return token;
}

export function resolvePlayerToken(db, token) {
  const row = db.prepare("SELECT venue_id AS venueId FROM player_tokens WHERE token = ?").get(token);
  return row ?? null;
}

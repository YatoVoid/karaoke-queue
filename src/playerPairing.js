import { generateShortCode } from "./shortCode.js";

export function createPlayerPairing(db, venueId) {
  let token;
  do {
    token = generateShortCode();
  } while (resolvePlayerToken(db, token));

  db.prepare(
    "INSERT INTO player_tokens (token, venue_id, created_at) VALUES (?, ?, ?)",
  ).run(token, venueId, new Date().toISOString());
  return token;
}

export function resolvePlayerToken(db, token) {
  // NOCASE so short codes are forgiving of case, without breaking old UUID tokens.
  const row = db
    .prepare("SELECT venue_id AS venueId FROM player_tokens WHERE token = ? COLLATE NOCASE")
    .get(token);
  return row ?? null;
}

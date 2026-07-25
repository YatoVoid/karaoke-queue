import { randomBytes } from "node:crypto";

// Excludes 0/O/1/I/L so it's less likely to be misread on a TV screen.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 6;

function generateShortCode() {
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

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

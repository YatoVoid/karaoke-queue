import { generateShortCode } from "./shortCode.js";

function tokenExists(db, token) {
  return !!db.prepare("SELECT 1 FROM pairing_tokens WHERE token = ?").get(token);
}

export function createPairing(db, tableId) {
  let token;
  do {
    token = generateShortCode();
  } while (tokenExists(db, token));

  db.prepare(
    "INSERT INTO pairing_tokens (token, table_id, created_at) VALUES (?, ?, ?)",
  ).run(token, tableId, new Date().toISOString());
  return token;
}

export function resolveToken(db, token) {
  const row = db
    .prepare(
      `SELECT tables.id AS tableId, tables.venue_id AS venueId, tables.kind AS kind,
              tables.price_per_use AS pricePerUse,
              COALESCE(venues.currency_symbol, '') AS currencySymbol
       FROM pairing_tokens
       JOIN tables ON tables.id = pairing_tokens.table_id
       LEFT JOIN venues ON venues.id = tables.venue_id
       WHERE pairing_tokens.token = ? COLLATE NOCASE`,
    )
    .get(token);
  return row ?? null;
}

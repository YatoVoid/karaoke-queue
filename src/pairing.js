import { randomUUID } from "node:crypto";

export function createPairing(db, tableId) {
  const token = randomUUID();
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
       WHERE pairing_tokens.token = ?`,
    )
    .get(token);
  return row ?? null;
}

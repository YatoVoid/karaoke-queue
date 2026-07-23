import { randomUUID } from "node:crypto";

export class TableAlreadyQueuedError extends Error {
  constructor(tableId) {
    super(`Table ${tableId} already has an active queue entry`);
    this.name = "TableAlreadyQueuedError";
    this.tableId = tableId;
  }
}

function hasActiveEntry(db, tableId) {
  const row = db
    .prepare(
      "SELECT id FROM queue_entries WHERE table_id = ? AND status IN ('queued','playing') LIMIT 1",
    )
    .get(tableId);
  return !!row;
}

export function enqueue(db, { venueId, tableId, songTitle, songRef }) {
  if (hasActiveEntry(db, tableId)) {
    throw new TableAlreadyQueuedError(tableId);
  }
  const id = randomUUID();
  const queuedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO queue_entries (id, venue_id, table_id, song_title, song_ref, status, queued_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?)`,
  ).run(id, venueId, tableId, songTitle, songRef, queuedAt);
  return { id, venueId, tableId, songTitle, songRef, status: "queued", queuedAt };
}

export function cancel(db, { tableId, entryId }) {
  const result = db
    .prepare(
      "UPDATE queue_entries SET status = 'cancelled' WHERE id = ? AND table_id = ? AND status = 'queued'",
    )
    .run(entryId, tableId);
  return result.changes > 0;
}

export function nowPlaying(db, venueId) {
  return (
    db
      .prepare("SELECT * FROM queue_entries WHERE venue_id = ? AND status = 'playing' LIMIT 1")
      .get(venueId) ?? null
  );
}

export function peekNext(db, venueId) {
  return (
    db
      .prepare(
        "SELECT * FROM queue_entries WHERE venue_id = ? AND status = 'queued' ORDER BY queued_at ASC LIMIT 1",
      )
      .get(venueId) ?? null
  );
}

function nextPlaylistTrack(db, venueId) {
  const tracks = db
    .prepare(
      "SELECT * FROM background_playlist_tracks WHERE venue_id = ? ORDER BY position ASC",
    )
    .all(venueId);
  if (tracks.length === 0) return null;

  const state = db
    .prepare("SELECT cursor FROM venue_playlist_state WHERE venue_id = ?")
    .get(venueId);
  const cursor = state?.cursor ?? 0;
  const index = cursor % tracks.length;

  db.prepare(
    `INSERT INTO venue_playlist_state (venue_id, cursor) VALUES (?, ?)
     ON CONFLICT(venue_id) DO UPDATE SET cursor = excluded.cursor`,
  ).run(venueId, cursor + 1);

  return tracks[index];
}

export function advance(db, venueId) {
  const current = nowPlaying(db, venueId);
  if (current) {
    db.prepare("UPDATE queue_entries SET status = 'done', ended_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      current.id,
    );
  }

  const next = peekNext(db, venueId);
  if (next) {
    db.prepare("UPDATE queue_entries SET status = 'playing', started_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      next.id,
    );
    return { type: "request", entry: { ...next, status: "playing" } };
  }

  const track = nextPlaylistTrack(db, venueId);
  if (track) {
    return { type: "playlist", track };
  }

  return { type: "empty" };
}

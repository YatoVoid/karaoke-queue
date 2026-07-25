import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";
import {
  enqueue,
  cancel,
  nowPlaying,
  peekNext,
  advance,
  skipPlaying,
  TableAlreadyQueuedError,
} from "../src/queueEngine.js";

const VENUE = "venue-1";

function seedTable(db, id, kind = "public") {
  db.prepare(
    "INSERT INTO tables (id, venue_id, label, kind, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, VENUE, id, kind, new Date().toISOString());
}

function seedPlaylist(db, tracks) {
  tracks.forEach((title, i) => {
    db.prepare(
      "INSERT INTO background_playlist_tracks (id, venue_id, position, title, song_ref) VALUES (?, ?, ?, ?, ?)",
    ).run(`track-${i}`, VENUE, i, title, `ref-${i}`);
  });
}

function freshDb() {
  const db = openDatabase();
  seedTable(db, "table-1");
  seedTable(db, "table-2");
  return db;
}

test("enqueue succeeds and creates a queued entry", () => {
  const db = freshDb();
  const entry = enqueue(db, {
    venueId: VENUE,
    tableId: "table-1",
    songTitle: "Song A",
    songRef: "yt:aaa",
  });
  assert.equal(entry.status, "queued");
  assert.equal(peekNext(db, VENUE).id, entry.id);
});

test("enqueue rejects a second request from a table with a queued entry", () => {
  const db = freshDb();
  enqueue(db, { venueId: VENUE, tableId: "table-1", songTitle: "A", songRef: "yt:a" });
  assert.throws(
    () => enqueue(db, { venueId: VENUE, tableId: "table-1", songTitle: "B", songRef: "yt:b" }),
    TableAlreadyQueuedError,
  );
});

test("enqueue rejects a second request from a table with a playing entry", () => {
  const db = freshDb();
  enqueue(db, { venueId: VENUE, tableId: "table-1", songTitle: "A", songRef: "yt:a" });
  advance(db, VENUE); // promotes table-1's entry to playing
  assert.throws(
    () => enqueue(db, { venueId: VENUE, tableId: "table-1", songTitle: "B", songRef: "yt:b" }),
    TableAlreadyQueuedError,
  );
});

test("FIFO ordering across multiple tables", async () => {
  const db = freshDb();
  const first = enqueue(db, { venueId: VENUE, tableId: "table-1", songTitle: "A", songRef: "yt:a" });
  // ensure a distinguishable queued_at ordering
  await new Promise((r) => setTimeout(r, 2));
  enqueue(db, { venueId: VENUE, tableId: "table-2", songTitle: "B", songRef: "yt:b" });

  assert.equal(peekNext(db, VENUE).id, first.id);
});

test("cancel removes only the requesting table's own entry", () => {
  const db = freshDb();
  const mine = enqueue(db, { venueId: VENUE, tableId: "table-1", songTitle: "A", songRef: "yt:a" });
  const theirs = enqueue(db, { venueId: VENUE, tableId: "table-2", songTitle: "B", songRef: "yt:b" });

  const cancelledOthers = cancel(db, { tableId: "table-1", entryId: theirs.id });
  assert.equal(cancelledOthers, false);

  const cancelledMine = cancel(db, { tableId: "table-1", entryId: mine.id });
  assert.equal(cancelledMine, true);
  assert.equal(peekNext(db, VENUE).id, theirs.id);
});

test("advance promotes the next queued entry to playing", () => {
  const db = freshDb();
  const entry = enqueue(db, { venueId: VENUE, tableId: "table-1", songTitle: "A", songRef: "yt:a" });

  const result = advance(db, VENUE);
  assert.equal(result.type, "request");
  assert.equal(result.entry.id, entry.id);
  assert.equal(nowPlaying(db, VENUE).id, entry.id);
  assert.equal(peekNext(db, VENUE), null);
});

test("advance falls back to background playlist when queue is empty", () => {
  const db = freshDb();
  seedPlaylist(db, ["Ambient 1", "Ambient 2"]);

  const result = advance(db, VENUE);
  assert.equal(result.type, "playlist");
  assert.equal(result.track.title, "Ambient 1");
});

test("background playlist wraps around instead of dead-ending", () => {
  const db = freshDb();
  seedPlaylist(db, ["Ambient 1", "Ambient 2"]);

  const r1 = advance(db, VENUE);
  const r2 = advance(db, VENUE);
  const r3 = advance(db, VENUE);

  assert.equal(r1.track.title, "Ambient 1");
  assert.equal(r2.track.title, "Ambient 2");
  assert.equal(r3.track.title, "Ambient 1");
});

test("advance returns empty when there is no queue and no playlist", () => {
  const db = freshDb();
  const result = advance(db, VENUE);
  assert.equal(result.type, "empty");
});

test("advance marks the previously playing entry done before promoting the next", () => {
  const db = freshDb();
  const first = enqueue(db, { venueId: VENUE, tableId: "table-1", songTitle: "A", songRef: "yt:a" });
  enqueue(db, { venueId: VENUE, tableId: "table-2", songTitle: "B", songRef: "yt:b" });

  advance(db, VENUE); // first -> playing
  advance(db, VENUE); // first -> done, second -> playing

  const firstRow = db.prepare("SELECT status FROM queue_entries WHERE id = ?").get(first.id);
  assert.equal(firstRow.status, "done");
});

test("advance with billable:false marks the previously playing entry cancelled, not done", () => {
  const db = freshDb();
  const first = enqueue(db, { venueId: VENUE, tableId: "table-1", songTitle: "A", songRef: "yt:a" });
  enqueue(db, { venueId: VENUE, tableId: "table-2", songTitle: "B", songRef: "yt:b" });

  advance(db, VENUE); // first -> playing
  advance(db, VENUE, { billable: false }); // first -> cancelled (e.g. playback error), second -> playing

  const firstRow = db.prepare("SELECT status FROM queue_entries WHERE id = ?").get(first.id);
  assert.equal(firstRow.status, "cancelled");
});

test("skipPlaying within the grace window marks the entry cancelled, not billable", () => {
  const db = freshDb();
  const entry = enqueue(db, { venueId: VENUE, tableId: "table-1", songTitle: "A", songRef: "yt:a" });
  advance(db, VENUE);

  const result = skipPlaying(db, { tableId: "table-1", entryId: entry.id, graceMs: 60000 });
  assert.equal(result.billable, false);

  const row = db.prepare("SELECT status FROM queue_entries WHERE id = ?").get(entry.id);
  assert.equal(row.status, "cancelled");
});

test("skipPlaying past the grace window marks the entry done and billable", async () => {
  const db = freshDb();
  const entry = enqueue(db, { venueId: VENUE, tableId: "table-1", songTitle: "A", songRef: "yt:a" });
  advance(db, VENUE);
  await new Promise((r) => setTimeout(r, 5));

  const result = skipPlaying(db, { tableId: "table-1", entryId: entry.id, graceMs: 1 });
  assert.equal(result.billable, true);

  const row = db.prepare("SELECT status FROM queue_entries WHERE id = ?").get(entry.id);
  assert.equal(row.status, "done");
});

test("skipPlaying returns null for an entry that isn't currently playing", () => {
  const db = freshDb();
  const entry = enqueue(db, { venueId: VENUE, tableId: "table-1", songTitle: "A", songRef: "yt:a" });

  // Still queued, never advanced to playing.
  const result = skipPlaying(db, { tableId: "table-1", entryId: entry.id, graceMs: 60000 });
  assert.equal(result, null);
});

test("skipPlaying returns null for a different table's playing entry", () => {
  const db = freshDb();
  const entry = enqueue(db, { venueId: VENUE, tableId: "table-1", songTitle: "A", songRef: "yt:a" });
  advance(db, VENUE);

  const result = skipPlaying(db, { tableId: "table-2", entryId: entry.id, graceMs: 60000 });
  assert.equal(result, null);

  const row = db.prepare("SELECT status FROM queue_entries WHERE id = ?").get(entry.id);
  assert.equal(row.status, "playing");
});

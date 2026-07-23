import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { openDatabase } from "../src/db.js";
import { createServer, broadcastQueueState } from "../src/server.js";
import { enqueue } from "../src/queueEngine.js";

const VENUE = "venue-1";

function listen(httpServer) {
  return new Promise((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => resolve(httpServer.address().port));
  });
}

function closeAll(httpServer, wss, ws) {
  return new Promise((resolve) => {
    ws.close();
    wss.close(() => {
      httpServer.close(() => resolve());
    });
  });
}

async function createAndPairTable(port, label = "Table 1", kind = "public", pricePerUse) {
  const createRes = await fetch(`http://127.0.0.1:${port}/admin/venues/${VENUE}/tables`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label, kind, ...(pricePerUse !== undefined ? { pricePerUse } : {}) }),
  });
  const table = await createRes.json();

  const pairRes = await fetch(
    `http://127.0.0.1:${port}/admin/venues/${VENUE}/tables/${table.id}/pair`,
    { method: "POST" },
  );
  const pairing = await pairRes.json();

  return { tableId: table.id, token: pairing.token };
}

test("GET /healthz returns ok", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);

  const res = await fetch(`http://127.0.0.1:${port}/healthz`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, { ok: true });

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("broadcastQueueState pushes queue state to connected WS clients", async () => {
  const db = openDatabase();
  db.prepare(
    "INSERT INTO tables (id, venue_id, label, kind, created_at) VALUES ('table-1', ?, 'Table 1', 'public', ?)",
  ).run(VENUE, new Date().toISOString());

  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve) => ws.on("open", resolve));

  const entry = enqueue(db, {
    venueId: VENUE,
    tableId: "table-1",
    songTitle: "Test Song",
    songRef: "yt:test",
  });

  const messagePromise = new Promise((resolve) => {
    ws.on("message", (data) => resolve(JSON.parse(data.toString())));
  });
  broadcastQueueState(wss, db, VENUE);
  const message = await messagePromise;

  assert.equal(message.type, "queue-state");
  assert.equal(message.venueId, VENUE);
  assert.equal(message.queued.length, 1);
  assert.equal(message.queued[0].id, entry.id);

  await closeAll(httpServer, wss, ws);
});

test("POST /admin/venues/:venueId/tables creates a table", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);

  const res = await fetch(`http://127.0.0.1:${port}/admin/venues/${VENUE}/tables`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "Table 7", kind: "public" }),
  });
  const body = await res.json();

  assert.equal(res.status, 201);
  assert.equal(body.label, "Table 7");
  assert.equal(body.kind, "public");
  assert.equal(body.venueId, VENUE);

  const row = db.prepare("SELECT * FROM tables WHERE id = ?").get(body.id);
  assert.ok(row);

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("POST /admin/.../tables rejects an invalid kind", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);

  const res = await fetch(`http://127.0.0.1:${port}/admin/venues/${VENUE}/tables`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "Table 7", kind: "vip-lounge" }),
  });
  assert.equal(res.status, 400);

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("POST /admin/.../tables accepts and returns pricePerUse for a public table", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);

  const res = await fetch(`http://127.0.0.1:${port}/admin/venues/${VENUE}/tables`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "Table 7", kind: "public", pricePerUse: 1 }),
  });
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.equal(body.pricePerUse, 1);

  const row = db.prepare("SELECT price_per_use FROM tables WHERE id = ?").get(body.id);
  assert.equal(row.price_per_use, 1);

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("POST /admin/.../tables forces price to 0 for a private table even if one was sent", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);

  const res = await fetch(`http://127.0.0.1:${port}/admin/venues/${VENUE}/tables`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "VIP Room", kind: "private", pricePerUse: 5 }),
  });
  const body = await res.json();
  assert.equal(body.pricePerUse, 0);

  const row = db.prepare("SELECT price_per_use FROM tables WHERE id = ?").get(body.id);
  assert.equal(row.price_per_use, 0);

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("POST /admin/.../tables rejects a negative pricePerUse", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);

  const res = await fetch(`http://127.0.0.1:${port}/admin/venues/${VENUE}/tables`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "Table 7", kind: "public", pricePerUse: -1 }),
  });
  assert.equal(res.status, 400);

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("PATCH /admin/.../tables/:tableId edits label, kind, and price", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);

  const created = await (
    await fetch(`http://127.0.0.1:${port}/admin/venues/${VENUE}/tables`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Table 7", kind: "public", pricePerUse: 1 }),
    })
  ).json();

  const res = await fetch(`http://127.0.0.1:${port}/admin/venues/${VENUE}/tables/${created.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "Table Seven", kind: "public", pricePerUse: 5 }),
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.label, "Table Seven");
  assert.equal(body.pricePerUse, 5);

  const row = db.prepare("SELECT label, price_per_use FROM tables WHERE id = ?").get(created.id);
  assert.equal(row.label, "Table Seven");
  assert.equal(row.price_per_use, 5);

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("PATCH /admin/.../tables/:tableId forces price to 0 when switched to private", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);

  const created = await (
    await fetch(`http://127.0.0.1:${port}/admin/venues/${VENUE}/tables`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Table 7", kind: "public", pricePerUse: 4 }),
    })
  ).json();

  const res = await fetch(`http://127.0.0.1:${port}/admin/venues/${VENUE}/tables/${created.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "Table 7", kind: "private", pricePerUse: 4 }),
  });
  const body = await res.json();

  assert.equal(body.pricePerUse, 0);
  const row = db.prepare("SELECT price_per_use FROM tables WHERE id = ?").get(created.id);
  assert.equal(row.price_per_use, 0);

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("PATCH /admin/.../tables/:tableId rejects an invalid kind", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);

  const created = await (
    await fetch(`http://127.0.0.1:${port}/admin/venues/${VENUE}/tables`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Table 7", kind: "public" }),
    })
  ).json();

  const res = await fetch(`http://127.0.0.1:${port}/admin/venues/${VENUE}/tables/${created.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "Table 7", kind: "vip-lounge" }),
  });
  assert.equal(res.status, 400);

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("PATCH /admin/.../tables/:tableId rejects a negative pricePerUse", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);

  const created = await (
    await fetch(`http://127.0.0.1:${port}/admin/venues/${VENUE}/tables`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Table 7", kind: "public" }),
    })
  ).json();

  const res = await fetch(`http://127.0.0.1:${port}/admin/venues/${VENUE}/tables/${created.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "Table 7", kind: "public", pricePerUse: -3 }),
  });
  assert.equal(res.status, 400);

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("PATCH /admin/.../tables/:tableId 404s for an unknown tableId", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);

  const res = await fetch(`http://127.0.0.1:${port}/admin/venues/${VENUE}/tables/does-not-exist`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "Table 7", kind: "public" }),
  });
  assert.equal(res.status, 404);

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("DELETE /admin/.../tables/:tableId removes the table and reports deleted:true", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);

  const created = await (
    await fetch(`http://127.0.0.1:${port}/admin/venues/${VENUE}/tables`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Table 7", kind: "public" }),
    })
  ).json();

  const res = await fetch(`http://127.0.0.1:${port}/admin/venues/${VENUE}/tables/${created.id}`, {
    method: "DELETE",
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.deleted, true);

  const row = db.prepare("SELECT * FROM tables WHERE id = ?").get(created.id);
  assert.equal(row, undefined);

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("DELETE /admin/.../tables/:tableId reports deleted:false for an unknown tableId", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);

  const res = await fetch(
    `http://127.0.0.1:${port}/admin/venues/${VENUE}/tables/does-not-exist`,
    { method: "DELETE" },
  );
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.deleted, false);

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("DELETE /admin/.../tables/:tableId invalidates its pairing token and cancels its queued entry, without affecting another table", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);

  const { tableId, token } = await createAndPairTable(port, "Doomed Table", "public", 2);
  const other = await createAndPairTable(port, "Other Table", "public", 2);

  await fetch(`http://127.0.0.1:${port}/t/${token}/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Doomed Song", songRef: "jNQXAC9IVRw" }),
  });
  const otherEntryRes = await fetch(`http://127.0.0.1:${port}/t/${other.token}/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Safe Song", songRef: "dQw4w9WgXcQ" }),
  });
  const otherEntry = await otherEntryRes.json();

  const deleteRes = await fetch(
    `http://127.0.0.1:${port}/admin/venues/${VENUE}/tables/${tableId}`,
    { method: "DELETE" },
  );
  assert.equal((await deleteRes.json()).deleted, true);

  // The deleted table's own paired URL must stop resolving.
  const staleRes = await fetch(`http://127.0.0.1:${port}/t/${token}`);
  assert.equal(staleRes.status, 404);

  // Its queued entry must no longer be live in the venue's queue.
  const state = await (
    await fetch(`http://127.0.0.1:${port}/t/${other.token}/state`)
  ).json();
  assert.ok(!state.queued.some((e) => e.tableId === tableId));

  // The OTHER table's own queued entry must be untouched (isolation).
  assert.ok(state.queued.some((e) => e.id === otherEntry.id && e.status === "queued"));

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("GET /admin/venues/:venueId/tables lists tables with pairing status", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);

  const unpaired = await (
    await fetch(`http://127.0.0.1:${port}/admin/venues/${VENUE}/tables`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Unpaired", kind: "public", pricePerUse: 2 }),
    })
  ).json();

  const { token: pairedToken } = await createAndPairTable(port, "Paired", "private");

  const listRes = await fetch(`http://127.0.0.1:${port}/admin/venues/${VENUE}/tables`);
  const list = await listRes.json();

  const unpairedRow = list.find((t) => t.id === unpaired.id);
  assert.equal(unpairedRow.pairingUrl, null);
  assert.equal(unpairedRow.pricePerUse, 2);

  const pairedRow = list.find((t) => t.label === "Paired");
  assert.equal(pairedRow.pairingUrl, `/t/${pairedToken}`);
  assert.equal(pairedRow.pricePerUse, 0);

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("GET /t/:token/state includes pricePerUse", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);
  const { token } = await createAndPairTable(port, "Table 1", "public", 3);

  const state = await (await fetch(`http://127.0.0.1:${port}/t/${token}/state`)).json();
  assert.equal(state.pricePerUse, 3);

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("POST /admin/.../tables/:tableId/pair issues a working token", async () => {
  const db = openDatabase();
  db.prepare(
    "INSERT INTO tables (id, venue_id, label, kind, created_at) VALUES ('table-9', ?, 'Table 9', 'private', ?)",
  ).run(VENUE, new Date().toISOString());

  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);

  const res = await fetch(
    `http://127.0.0.1:${port}/admin/venues/${VENUE}/tables/table-9/pair`,
    { method: "POST" },
  );
  const body = await res.json();

  assert.equal(res.status, 201);
  assert.ok(body.token);
  assert.equal(body.url, `/t/${body.token}`);

  const row = db.prepare("SELECT table_id FROM pairing_tokens WHERE token = ?").get(body.token);
  assert.equal(row.table_id, "table-9");

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("POST /admin/.../tables/:tableId/pair 404s for an unknown table", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);

  const res = await fetch(
    `http://127.0.0.1:${port}/admin/venues/${VENUE}/tables/does-not-exist/pair`,
    { method: "POST" },
  );
  assert.equal(res.status, 404);

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("GET /t/:token/state returns 404 for an unknown token", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);

  const res = await fetch(`http://127.0.0.1:${port}/t/not-a-real-token/state`);
  assert.equal(res.status, 404);

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("GET /t/:token serves the table HTML page for a valid token", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);
  const { token } = await createAndPairTable(port);

  const res = await fetch(`http://127.0.0.1:${port}/t/${token}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("GET /t/:token 404s for an unknown token", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);

  const res = await fetch(`http://127.0.0.1:${port}/t/not-a-real-token`);
  assert.equal(res.status, 404);

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("GET /youtube.js serves the video-ID extractor as JS", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);

  const res = await fetch(`http://127.0.0.1:${port}/youtube.js`);
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /javascript/);
  assert.match(body, /extractVideoId/);

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("POST /t/:token/queue enqueues, and GET /t/:token/state reflects it", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);
  const { token } = await createAndPairTable(port);

  const enqueueRes = await fetch(`http://127.0.0.1:${port}/t/${token}/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Song A", songRef: "aaaaaaaaaaa" }),
  });
  assert.equal(enqueueRes.status, 201);

  const stateRes = await fetch(`http://127.0.0.1:${port}/t/${token}/state`);
  const state = await stateRes.json();
  assert.equal(state.queued.length, 1);
  assert.equal(state.queued[0].songTitle, "Song A");

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("POST /t/:token/queue rejects a non-YouTube songRef, even calling the API directly", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);
  const { token } = await createAndPairTable(port);

  const res = await fetch(`http://127.0.0.1:${port}/t/${token}/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Not a song", songRef: "this is not a video link" }),
  });
  assert.equal(res.status, 400);

  const state = await (await fetch(`http://127.0.0.1:${port}/t/${token}/state`)).json();
  assert.equal(state.queued.length, 0);

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("POST /t/:token/queue stores the extracted bare video ID, not the full pasted URL", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);
  const { token } = await createAndPairTable(port);

  await fetch(`http://127.0.0.1:${port}/t/${token}/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Song A",
      songRef: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
    }),
  });

  const state = await (await fetch(`http://127.0.0.1:${port}/t/${token}/state`)).json();
  assert.equal(state.queued[0].songRef, "aaaaaaaaaaa");

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

// Real network call to the real oEmbed endpoint — matches this project's
// established precedent (KR4/KR11 Task 1) of verifying real
// YouTube-dependent behavior rather than mocking it.
test("POST /t/:token/queue uses the real YouTube title over a wrong client-supplied one", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);
  const { token } = await createAndPairTable(port);

  await fetch(`http://127.0.0.1:${port}/t/${token}/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "this is not the real title",
      songRef: "jNQXAC9IVRw", // "Me at the zoo"
    }),
  });

  const state = await (await fetch(`http://127.0.0.1:${port}/t/${token}/state`)).json();
  assert.equal(state.queued[0].songTitle, "Me at the zoo");

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("GET /t/:token/state returns nowPlaying in camelCase, matching the enqueue response shape", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);
  const { tableId, token } = await createAndPairTable(port);

  await fetch(`http://127.0.0.1:${port}/t/${token}/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Song A", songRef: "aaaaaaaaaaa" }),
  });
  // advance() has no HTTP route yet (future KR) — call the engine directly
  // to move the entry into 'playing', matching how a future player-page
  // KR will drive this.
  const { advance } = await import("../src/queueEngine.js");
  advance(db, VENUE);

  const state = await (await fetch(`http://127.0.0.1:${port}/t/${token}/state`)).json();
  assert.equal(state.nowPlaying.songTitle, "Song A");
  assert.equal(state.nowPlaying.tableId, tableId);
  assert.equal(state.nowPlaying.songRef, "aaaaaaaaaaa");
  // confirm no snake_case leakage
  assert.equal(state.nowPlaying.song_title, undefined);

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("POST /t/:token/queue rejects a second active request with 409", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);
  const { token } = await createAndPairTable(port);

  await fetch(`http://127.0.0.1:${port}/t/${token}/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Song A", songRef: "aaaaaaaaaaa" }),
  });
  const secondRes = await fetch(`http://127.0.0.1:${port}/t/${token}/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Song B", songRef: "bbbbbbbbbbb" }),
  });
  assert.equal(secondRes.status, 409);

  const state = await (await fetch(`http://127.0.0.1:${port}/t/${token}/state`)).json();
  assert.equal(state.queued.length, 1);

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("DELETE /t/:token/queue/:entryId cancels the table's own entry", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);
  const { token } = await createAndPairTable(port);

  const entry = await (
    await fetch(`http://127.0.0.1:${port}/t/${token}/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Song A", songRef: "aaaaaaaaaaa" }),
    })
  ).json();

  const cancelRes = await fetch(`http://127.0.0.1:${port}/t/${token}/queue/${entry.id}`, {
    method: "DELETE",
  });
  const cancelBody = await cancelRes.json();
  assert.equal(cancelBody.cancelled, true);

  const state = await (await fetch(`http://127.0.0.1:${port}/t/${token}/state`)).json();
  assert.equal(state.queued.length, 0);

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("a table's token cannot cancel a different table's entry (impersonation)", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);
  const tableA = await createAndPairTable(port, "Table A");
  const tableB = await createAndPairTable(port, "Table B");

  const entryA = await (
    await fetch(`http://127.0.0.1:${port}/t/${tableA.token}/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "A's Song", songRef: "aaaaaaaaaaa" }),
    })
  ).json();

  // Table B tries to cancel table A's entry using its OWN token.
  const cancelRes = await fetch(
    `http://127.0.0.1:${port}/t/${tableB.token}/queue/${entryA.id}`,
    { method: "DELETE" },
  );
  const cancelBody = await cancelRes.json();
  assert.equal(cancelBody.cancelled, false);

  // A's entry must still be queued — not silently cancelled by B.
  const stateA = await (await fetch(`http://127.0.0.1:${port}/t/${tableA.token}/state`)).json();
  assert.equal(stateA.queued.length, 1);
  assert.equal(stateA.queued[0].id, entryA.id);

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("one table already having an active entry does not block a different table's enqueue", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);
  const tableA = await createAndPairTable(port, "Table A");
  const tableB = await createAndPairTable(port, "Table B");

  await fetch(`http://127.0.0.1:${port}/t/${tableA.token}/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "A's Song", songRef: "aaaaaaaaaaa" }),
  });

  // Table B enqueues independently — the one-active-entry rule must be
  // scoped per-table, not accidentally global across the whole venue.
  const bRes = await fetch(`http://127.0.0.1:${port}/t/${tableB.token}/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "B's Song", songRef: "bbbbbbbbbbb" }),
  });
  assert.equal(bRes.status, 201);

  const stateB = await (await fetch(`http://127.0.0.1:${port}/t/${tableB.token}/state`)).json();
  assert.equal(stateB.queued.length, 2); // both A's and B's entries are venue-wide visible

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

async function createPlayerToken(port) {
  const res = await fetch(`http://127.0.0.1:${port}/admin/venues/${VENUE}/player-token`, {
    method: "POST",
  });
  return (await res.json()).token;
}

test("POST /player/:token/advance with nothing queued returns empty", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);
  const playerToken = await createPlayerToken(port);

  const res = await fetch(`http://127.0.0.1:${port}/player/${playerToken}/advance`, {
    method: "POST",
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.type, "empty");

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("POST /player/:token/advance promotes a queued request, GET .../state reflects it", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);
  const playerToken = await createPlayerToken(port);
  const { token } = await createAndPairTable(port);

  await fetch(`http://127.0.0.1:${port}/t/${token}/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Song A", songRef: "aaaaaaaaaaa" }),
  });

  const advanceRes = await fetch(`http://127.0.0.1:${port}/player/${playerToken}/advance`, {
    method: "POST",
  });
  const advanceBody = await advanceRes.json();
  assert.equal(advanceBody.type, "request");
  assert.equal(advanceBody.entry.songTitle, "Song A");
  assert.equal(advanceBody.entry.status, "playing");

  const state = await (
    await fetch(`http://127.0.0.1:${port}/player/${playerToken}/state`)
  ).json();
  assert.equal(state.nowPlaying.songTitle, "Song A");

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("a second advance with nothing behind it marks the entry done and returns empty", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);
  const playerToken = await createPlayerToken(port);
  const { token } = await createAndPairTable(port);

  await fetch(`http://127.0.0.1:${port}/t/${token}/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Song A", songRef: "aaaaaaaaaaa" }),
  });

  await fetch(`http://127.0.0.1:${port}/player/${playerToken}/advance`, { method: "POST" });
  const secondRes = await fetch(`http://127.0.0.1:${port}/player/${playerToken}/advance`, {
    method: "POST",
  });
  const secondBody = await secondRes.json();
  assert.equal(secondBody.type, "empty");

  const state = await (
    await fetch(`http://127.0.0.1:${port}/player/${playerToken}/state`)
  ).json();
  assert.equal(state.nowPlaying, null);

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("player routes 404 for an unknown token", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);

  const advanceRes = await fetch(`http://127.0.0.1:${port}/player/nope/advance`, {
    method: "POST",
  });
  const stateRes = await fetch(`http://127.0.0.1:${port}/player/nope/state`);
  assert.equal(advanceRes.status, 404);
  assert.equal(stateRes.status, 404);

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("GET /player/:token serves the player HTML page for a valid token", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);
  const playerToken = await createPlayerToken(port);

  const res = await fetch(`http://127.0.0.1:${port}/player/${playerToken}`);
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.match(body, /iframe_api/);

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("GET /player/:token 404s for an unknown token", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);

  const res = await fetch(`http://127.0.0.1:${port}/player/nope`);
  assert.equal(res.status, 404);

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

async function addPlaylistTrack(port, venueId, title, songRef) {
  const res = await fetch(`http://127.0.0.1:${port}/admin/venues/${venueId}/playlist-tracks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, songRef }),
  });
  return { status: res.status, body: await res.json() };
}

test("adding a playlist track uses the real YouTube title over a wrong client-supplied one", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);

  const result = await addPlaylistTrack(
    port,
    VENUE,
    "this is not the real title",
    "jNQXAC9IVRw",
  );
  assert.equal(result.body.title, "Me at the zoo");

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("playlist tracks are appended at increasing positions starting from 0", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);

  const first = await addPlaylistTrack(port, VENUE, "Ambient 1", "aaaaaaaaaaa");
  const second = await addPlaylistTrack(port, VENUE, "Ambient 2", "bbbbbbbbbbb");

  assert.equal(first.body.position, 0);
  assert.equal(second.body.position, 1);

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("adding a playlist track rejects an invalid songRef", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);

  const result = await addPlaylistTrack(port, VENUE, "Bad", "not a link");
  assert.equal(result.status, 400);

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("GET playlist-tracks lists in position order", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);

  await addPlaylistTrack(port, VENUE, "Ambient 1", "aaaaaaaaaaa");
  await addPlaylistTrack(port, VENUE, "Ambient 2", "bbbbbbbbbbb");

  const list = await (
    await fetch(`http://127.0.0.1:${port}/admin/venues/${VENUE}/playlist-tracks`)
  ).json();
  assert.equal(list.length, 2);
  assert.equal(list[0].title, "Ambient 1");
  assert.equal(list[1].title, "Ambient 2");

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("DELETE playlist-tracks removes only the targeted venue's track", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);

  const { body: track } = await addPlaylistTrack(port, VENUE, "Ambient 1", "aaaaaaaaaaa");

  // A different venue's URL cannot delete this track.
  const wrongVenueRes = await fetch(
    `http://127.0.0.1:${port}/admin/venues/other-venue/playlist-tracks/${track.id}`,
    { method: "DELETE" },
  );
  const wrongVenueBody = await wrongVenueRes.json();
  assert.equal(wrongVenueBody.deleted, false);

  const stillThere = await (
    await fetch(`http://127.0.0.1:${port}/admin/venues/${VENUE}/playlist-tracks`)
  ).json();
  assert.equal(stillThere.length, 1);

  const correctRes = await fetch(
    `http://127.0.0.1:${port}/admin/venues/${VENUE}/playlist-tracks/${track.id}`,
    { method: "DELETE" },
  );
  const correctBody = await correctRes.json();
  assert.equal(correctBody.deleted, true);

  const afterDelete = await (
    await fetch(`http://127.0.0.1:${port}/admin/venues/${VENUE}/playlist-tracks`)
  ).json();
  assert.equal(afterDelete.length, 0);

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("advance() correctly reads playlist tracks created through the new routes (not just hand-seeded rows)", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);

  await addPlaylistTrack(port, VENUE, "Ambient 1", "aaaaaaaaaaa");
  await addPlaylistTrack(port, VENUE, "Ambient 2", "bbbbbbbbbbb");

  const { advance } = await import("../src/queueEngine.js");
  const result = advance(db, VENUE);
  assert.equal(result.type, "playlist");
  assert.equal(result.track.title, "Ambient 1");

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

// The objective's real-world context is Azerbaijan; non-ASCII table
// labels and song titles (Azerbaijani Latin-script special characters,
// or Cyrillic, widely used/understood there too) are ordinary expected
// input, never exercised anywhere else in this suite.
test("table labels with Azerbaijani special characters round-trip exactly", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);

  const label = "Zərif zal";
  const createRes = await fetch(`http://127.0.0.1:${port}/admin/venues/${VENUE}/tables`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label, kind: "public" }),
  });
  const created = await createRes.json();
  assert.equal(created.label, label);

  const list = await (
    await fetch(`http://127.0.0.1:${port}/admin/venues/${VENUE}/tables`)
  ).json();
  assert.equal(list.find((t) => t.id === created.id).label, label);

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("a Cyrillic song title survives the full round trip when oEmbed can't override it", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);
  const { token } = await createAndPairTable(port);

  const title = "Комбинация — Русский стиль";
  // A syntactically-valid but nonexistent ID (confirmed to 404 at
  // oEmbed in KR11's own tests) — isolates that THIS test is checking
  // client-supplied text survival, not YouTube's own real title winning.
  await fetch(`http://127.0.0.1:${port}/t/${token}/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, songRef: "00000000000" }),
  });

  const state = await (await fetch(`http://127.0.0.1:${port}/t/${token}/state`)).json();
  assert.equal(state.queued[0].songTitle, title);

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("a venue id containing Cyrillic characters works correctly in the URL path", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);
  const cyrillicVenue = "venue-рестуран";

  const createRes = await fetch(
    `http://127.0.0.1:${port}/admin/venues/${encodeURIComponent(cyrillicVenue)}/tables`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Table 1", kind: "public" }),
    },
  );
  const created = await createRes.json();
  assert.equal(created.venueId, cyrillicVenue);

  const list = await (
    await fetch(`http://127.0.0.1:${port}/admin/venues/${encodeURIComponent(cyrillicVenue)}/tables`)
  ).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, created.id);

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

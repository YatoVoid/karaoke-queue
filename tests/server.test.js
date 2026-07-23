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

async function createAndPairTable(port, label = "Table 1", kind = "public") {
  const createRes = await fetch(`http://127.0.0.1:${port}/admin/venues/${VENUE}/tables`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label, kind }),
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
    body: JSON.stringify({ title: "Song A", songRef: "yt:aaa" }),
  });
  assert.equal(enqueueRes.status, 201);

  const stateRes = await fetch(`http://127.0.0.1:${port}/t/${token}/state`);
  const state = await stateRes.json();
  assert.equal(state.queued.length, 1);
  assert.equal(state.queued[0].songTitle, "Song A");

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
    body: JSON.stringify({ title: "Song A", songRef: "yt:aaa" }),
  });
  // advance() has no HTTP route yet (future KR) — call the engine directly
  // to move the entry into 'playing', matching how a future player-page
  // KR will drive this.
  const { advance } = await import("../src/queueEngine.js");
  advance(db, VENUE);

  const state = await (await fetch(`http://127.0.0.1:${port}/t/${token}/state`)).json();
  assert.equal(state.nowPlaying.songTitle, "Song A");
  assert.equal(state.nowPlaying.tableId, tableId);
  assert.equal(state.nowPlaying.songRef, "yt:aaa");
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
    body: JSON.stringify({ title: "Song A", songRef: "yt:aaa" }),
  });
  const secondRes = await fetch(`http://127.0.0.1:${port}/t/${token}/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Song B", songRef: "yt:bbb" }),
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
      body: JSON.stringify({ title: "Song A", songRef: "yt:aaa" }),
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
      body: JSON.stringify({ title: "A's Song", songRef: "yt:a" }),
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
    body: JSON.stringify({ title: "A's Song", songRef: "yt:a" }),
  });

  // Table B enqueues independently — the one-active-entry rule must be
  // scoped per-table, not accidentally global across the whole venue.
  const bRes = await fetch(`http://127.0.0.1:${port}/t/${tableB.token}/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "B's Song", songRef: "yt:b" }),
  });
  assert.equal(bRes.status, 201);

  const stateB = await (await fetch(`http://127.0.0.1:${port}/t/${tableB.token}/state`)).json();
  assert.equal(stateB.queued.length, 2); // both A's and B's entries are venue-wide visible

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

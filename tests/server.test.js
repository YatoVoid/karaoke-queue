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

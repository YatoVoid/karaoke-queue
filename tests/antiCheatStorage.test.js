import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";
import { createServer } from "../src/server.js";

const VENUE = "venue-1";

function listen(httpServer) {
  return new Promise((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => resolve(httpServer.address().port));
  });
}

async function pairTable(port) {
  const table = await (
    await fetch(`http://127.0.0.1:${port}/admin/venues/${VENUE}/tables`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Table 1", kind: "public" }),
    })
  ).json();
  const pairing = await (
    await fetch(`http://127.0.0.1:${port}/admin/venues/${VENUE}/tables/${table.id}/pair`, {
      method: "POST",
    })
  ).json();
  return pairing.token;
}

// Models a full client-storage wipe: no cookies, no shared state.
test("a fresh, storage-free request to the same table URL cannot bypass the one-active-request limit", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);
  const token = await pairTable(port);

  // Something already playing, so this table's entry stays queued instead of auto-starting.
  const filler = await pairTable(port);
  await fetch(`http://127.0.0.1:${port}/t/${filler}/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Filler Song", songRef: "ffffffffff0" }),
  });

  // Original guest submits a request.
  const firstRes = await fetch(`http://127.0.0.1:${port}/t/${token}/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Song A", songRef: "aaaaaaaaaaa" }),
  });
  assert.equal(firstRes.status, 201);

  // Independent call, sharing no state with the first.
  const secondRes = await fetch(`http://127.0.0.1:${port}/t/${token}/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Song B", songRef: "bbbbbbbbbbb" }),
  });
  assert.equal(secondRes.status, 409);

  const state = await (await fetch(`http://127.0.0.1:${port}/t/${token}/state`)).json();
  assert.equal(state.queued.length, 1);
  assert.equal(state.queued[0].songTitle, "Song A");

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

test("after the active request is cancelled, the same table URL can request again (not a permanent lockout)", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);
  const token = await pairTable(port);

  // Something already playing, so this table's entry stays queued (and thus cancellable).
  const filler = await pairTable(port);
  await fetch(`http://127.0.0.1:${port}/t/${filler}/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Filler Song", songRef: "ffffffffff0" }),
  });

  const first = await (
    await fetch(`http://127.0.0.1:${port}/t/${token}/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Song A", songRef: "aaaaaaaaaaa" }),
    })
  ).json();

  await fetch(`http://127.0.0.1:${port}/t/${token}/queue/${first.id}`, { method: "DELETE" });

  const secondRes = await fetch(`http://127.0.0.1:${port}/t/${token}/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Song B", songRef: "bbbbbbbbbbb" }),
  });
  assert.equal(secondRes.status, 201);

  const state = await (await fetch(`http://127.0.0.1:${port}/t/${token}/state`)).json();
  assert.equal(state.queued.length, 1);
  assert.equal(state.queued[0].songTitle, "Song B");

  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
});

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

// The literal scenario the objective names: "not allow the user to do
// cheats like refreshing the webpage or deleting cookies". This project
// never uses cookies or localStorage anywhere (confirmed by direct
// grep before writing this test) — table identity lives entirely in the
// opaque token embedded in the URL path (KR2). A plain, independent
// fetch() call to that same URL, sharing nothing with a prior call, is
// therefore the practical equivalent of a fully wiped/fresh incognito
// browser window hitting the same paired URL: there is no client-side
// state for either scenario to reset.
test("a fresh, storage-free request to the same table URL cannot bypass the one-active-request limit", async () => {
  const db = openDatabase();
  const { httpServer, wss } = createServer({ db });
  const port = await listen(httpServer);
  const token = await pairTable(port);

  // "Sequence A" — the original guest submits a request.
  const firstRes = await fetch(`http://127.0.0.1:${port}/t/${token}/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Song A", songRef: "aaaaaaaaaaa" }),
  });
  assert.equal(firstRes.status, 201);

  // "Sequence B" — modeling a full client-storage wipe (refresh, clear
  // cookies, fresh private window): an entirely independent call,
  // sharing no state whatsoever with sequence A, hitting the exact same
  // URL.
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

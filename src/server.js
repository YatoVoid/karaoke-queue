import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WebSocketServer } from "ws";
import { nowPlaying, enqueue, cancel, advance, TableAlreadyQueuedError } from "./queueEngine.js";
import { createPairing, resolveToken } from "./pairing.js";
import { createPlayerPairing, resolvePlayerToken } from "./playerPairing.js";
import { Router } from "./router.js";
import { extractVideoId, fetchOembedTitle } from "./youtube.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TABLE_HTML = readFileSync(path.join(__dirname, "..", "public", "table.html"), "utf8");
const PLAYER_HTML = readFileSync(path.join(__dirname, "..", "public", "player.html"), "utf8");
const ADMIN_HTML = readFileSync(path.join(__dirname, "..", "public", "admin.html"), "utf8");
const YOUTUBE_JS = readFileSync(path.join(__dirname, "youtube.js"), "utf8");

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendHtml(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// Normalizes a raw queue_entries DB row (snake_case columns) to the same
// camelCase shape enqueue() already returns — API consumers should never
// see two different field-naming conventions depending on which route
// they called.
function toApiEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    venueId: row.venue_id,
    tableId: row.table_id,
    songTitle: row.song_title,
    songRef: row.song_ref,
    status: row.status,
    queuedAt: row.queued_at,
    startedAt: row.started_at ?? null,
    endedAt: row.ended_at ?? null,
  };
}

function queuedList(db, venueId) {
  return db
    .prepare(
      "SELECT * FROM queue_entries WHERE venue_id = ? AND status = 'queued' ORDER BY queued_at ASC",
    )
    .all(venueId)
    .map(toApiEntry);
}

function queueStatePayload(db, venueId) {
  return {
    venueId,
    nowPlaying: toApiEntry(nowPlaying(db, venueId)),
    queued: queuedList(db, venueId),
  };
}

const VALID_TABLE_KINDS = new Set(["public", "private"]);

// Shared by table creation (POST) and editing (PATCH) so the two routes
// can never drift apart on what counts as a valid table — an edit that
// accepted something creation would reject (or vice versa) would be a
// real, confusing inconsistency.
function validateTableInput({ label, kind, pricePerUse }) {
  if (typeof label !== "string" || !label.trim()) {
    return "label is required";
  }
  if (!VALID_TABLE_KINDS.has(kind)) {
    return "kind must be 'public' or 'private'";
  }
  if (
    pricePerUse !== undefined &&
    (typeof pricePerUse !== "number" || !Number.isInteger(pricePerUse) || pricePerUse < 0)
  ) {
    return "pricePerUse must be a non-negative integer";
  }
  return null;
}

function buildRouter(db, getWss) {
  const router = new Router();

  router.add("GET", "/healthz", async (req, res) => {
    sendJson(res, 200, { ok: true });
  });

  router.add("GET", "/admin/venues/:venueId", async (req, res) => {
    sendHtml(res, 200, ADMIN_HTML);
  });

  router.add("POST", "/admin/venues/:venueId/tables", async (req, res, params) => {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: "invalid JSON body" });
    }
    const { label, kind, pricePerUse } = body;
    const validationError = validateTableInput({ label, kind, pricePerUse });
    if (validationError) {
      return sendJson(res, 400, { error: validationError });
    }

    // Private tables are always free per the objective's business model —
    // enforced here regardless of what the request sends, not left as a
    // client-side convention the admin form merely happens to follow.
    const finalPrice = kind === "private" ? 0 : (pricePerUse ?? 0);

    const id = randomUUID();
    db.prepare(
      "INSERT INTO tables (id, venue_id, label, kind, price_per_use, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, params.venueId, label, kind, finalPrice, new Date().toISOString());

    sendJson(res, 201, { id, venueId: params.venueId, label, kind, pricePerUse: finalPrice });
  });

  router.add("PATCH", "/admin/venues/:venueId/tables/:tableId", async (req, res, params) => {
    const existing = db
      .prepare("SELECT id FROM tables WHERE id = ? AND venue_id = ?")
      .get(params.tableId, params.venueId);
    if (!existing) {
      return sendJson(res, 404, { error: "unknown table" });
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: "invalid JSON body" });
    }
    const { label, kind, pricePerUse } = body;
    const validationError = validateTableInput({ label, kind, pricePerUse });
    if (validationError) {
      return sendJson(res, 400, { error: validationError });
    }

    const finalPrice = kind === "private" ? 0 : (pricePerUse ?? 0);

    db.prepare(
      "UPDATE tables SET label = ?, kind = ?, price_per_use = ? WHERE id = ? AND venue_id = ?",
    ).run(label, kind, finalPrice, params.tableId, params.venueId);

    sendJson(res, 200, { id: params.tableId, venueId: params.venueId, label, kind, pricePerUse: finalPrice });
  });

  router.add("DELETE", "/admin/venues/:venueId/tables/:tableId", async (req, res, params) => {
    const result = db
      .prepare("DELETE FROM tables WHERE id = ? AND venue_id = ?")
      .run(params.tableId, params.venueId);

    // Neither pairing_tokens nor queue_entries has a DB-level foreign
    // key / cascade to tables (see src/db.js — no FOREIGN KEY declared
    // anywhere in this schema), so a deleted table's own rows in both
    // would otherwise linger forever: an orphaned pairing token that
    // still resolves, and a 'queued' entry with no table left to ever
    // cancel or claim it.
    db.prepare("DELETE FROM pairing_tokens WHERE table_id = ?").run(params.tableId);
    db.prepare(
      "UPDATE queue_entries SET status = 'cancelled' WHERE table_id = ? AND status = 'queued'",
    ).run(params.tableId);

    if (result.changes > 0) {
      broadcastToClients(getWss(), db, params.venueId);
    }
    sendJson(res, 200, { deleted: result.changes > 0 });
  });

  router.add("GET", "/admin/venues/:venueId/tables", async (req, res, params) => {
    const rows = db
      .prepare(
        `SELECT tables.id AS id, tables.label AS label, tables.kind AS kind,
                tables.price_per_use AS pricePerUse,
                (SELECT token FROM pairing_tokens WHERE table_id = tables.id ORDER BY created_at DESC LIMIT 1) AS latestToken
         FROM tables WHERE venue_id = ? ORDER BY tables.created_at ASC`,
      )
      .all(params.venueId);

    sendJson(
      res,
      200,
      rows.map((row) => ({
        id: row.id,
        label: row.label,
        kind: row.kind,
        pricePerUse: row.pricePerUse,
        pairingUrl: row.latestToken ? `/t/${row.latestToken}` : null,
      })),
    );
  });

  router.add("GET", "/admin/venues/:venueId/playlist-tracks", async (req, res, params) => {
    const rows = db
      .prepare(
        `SELECT id, position, title, song_ref AS songRef
         FROM background_playlist_tracks WHERE venue_id = ? ORDER BY position ASC`,
      )
      .all(params.venueId);
    sendJson(res, 200, rows);
  });

  router.add("POST", "/admin/venues/:venueId/playlist-tracks", async (req, res, params) => {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: "invalid JSON body" });
    }
    const { title, songRef } = body;
    if (typeof title !== "string" || !title.trim()) {
      return sendJson(res, 400, { error: "title is required" });
    }
    const videoId = extractVideoId(songRef);
    if (!videoId) {
      return sendJson(res, 400, { error: "songRef must be a valid YouTube link or video ID" });
    }
    const realTitle = await fetchOembedTitle(videoId);
    const finalTitle = realTitle ?? title;

    const { nextPosition } = db
      .prepare(
        "SELECT COALESCE(MAX(position), -1) + 1 AS nextPosition FROM background_playlist_tracks WHERE venue_id = ?",
      )
      .get(params.venueId);

    const id = randomUUID();
    db.prepare(
      "INSERT INTO background_playlist_tracks (id, venue_id, position, title, song_ref) VALUES (?, ?, ?, ?, ?)",
    ).run(id, params.venueId, nextPosition, finalTitle, videoId);

    sendJson(res, 201, { id, position: nextPosition, title: finalTitle, songRef: videoId });
  });

  router.add(
    "DELETE",
    "/admin/venues/:venueId/playlist-tracks/:trackId",
    async (req, res, params) => {
      const result = db
        .prepare("DELETE FROM background_playlist_tracks WHERE id = ? AND venue_id = ?")
        .run(params.trackId, params.venueId);
      sendJson(res, 200, { deleted: result.changes > 0 });
    },
  );

  router.add(
    "POST",
    "/admin/venues/:venueId/tables/:tableId/pair",
    async (req, res, params) => {
      const table = db
        .prepare("SELECT id FROM tables WHERE id = ? AND venue_id = ?")
        .get(params.tableId, params.venueId);
      if (!table) {
        return sendJson(res, 404, { error: "table not found" });
      }

      const token = createPairing(db, params.tableId);
      sendJson(res, 201, { token, url: `/t/${token}` });
    },
  );

  router.add("POST", "/admin/venues/:venueId/player-token", async (req, res, params) => {
    const token = createPlayerPairing(db, params.venueId);
    sendJson(res, 201, { token, url: `/player/${token}` });
  });

  router.add("GET", "/youtube.js", async (req, res) => {
    res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
    res.end(YOUTUBE_JS);
  });

  router.add("GET", "/t/:token", async (req, res, params) => {
    const resolved = resolveToken(db, params.token);
    if (!resolved) {
      return sendJson(res, 404, { error: "unknown table" });
    }
    sendHtml(res, 200, TABLE_HTML);
  });

  router.add("GET", "/t/:token/state", async (req, res, params) => {
    const resolved = resolveToken(db, params.token);
    if (!resolved) {
      return sendJson(res, 404, { error: "unknown table" });
    }
    sendJson(res, 200, {
      tableId: resolved.tableId,
      kind: resolved.kind,
      pricePerUse: resolved.pricePerUse,
      ...queueStatePayload(db, resolved.venueId),
    });
  });

  router.add("POST", "/t/:token/queue", async (req, res, params) => {
    const resolved = resolveToken(db, params.token);
    if (!resolved) {
      return sendJson(res, 404, { error: "unknown table" });
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: "invalid JSON body" });
    }
    const { title, songRef } = body;
    if (typeof title !== "string" || !title.trim()) {
      return sendJson(res, 400, { error: "title is required" });
    }
    if (typeof songRef !== "string" || !songRef.trim()) {
      return sendJson(res, 400, { error: "songRef is required" });
    }
    // The table page already extracts a bare video ID client-side before
    // submitting, but this route is directly reachable regardless of the
    // page — re-validating here (idempotent against an already-bare ID)
    // is the actual enforcement point, not the client-side check.
    const videoId = extractVideoId(songRef);
    if (!videoId) {
      return sendJson(res, 400, { error: "songRef must be a valid YouTube link or video ID" });
    }
    // Best-effort real title via YouTube's official oEmbed endpoint — any
    // failure (bad ID, network issue, timeout) falls back to whatever
    // the requester typed, never blocking the request itself.
    const realTitle = await fetchOembedTitle(videoId);

    let entry;
    try {
      // Table identity comes ONLY from the resolved token, never from the
      // request body — this is the actual anti-impersonation enforcement
      // point for this route.
      entry = enqueue(db, {
        venueId: resolved.venueId,
        tableId: resolved.tableId,
        songTitle: realTitle ?? title,
        songRef: videoId,
      });
    } catch (err) {
      if (err instanceof TableAlreadyQueuedError) {
        return sendJson(res, 409, { error: "table already has an active request" });
      }
      throw err;
    }

    broadcastToClients(getWss(), db, resolved.venueId);
    sendJson(res, 201, entry);
  });

  router.add("DELETE", "/t/:token/queue/:entryId", async (req, res, params) => {
    const resolved = resolveToken(db, params.token);
    if (!resolved) {
      return sendJson(res, 404, { error: "unknown table" });
    }

    // Same enforcement point: cancel() is called with the RESOLVED
    // tableId, never a client-supplied one, so a token can only ever
    // cancel its own table's entries.
    const cancelled = cancel(db, { tableId: resolved.tableId, entryId: params.entryId });
    if (cancelled) {
      broadcastToClients(getWss(), db, resolved.venueId);
    }
    sendJson(res, 200, { cancelled });
  });

  router.add("GET", "/player/:token", async (req, res, params) => {
    const resolved = resolvePlayerToken(db, params.token);
    if (!resolved) {
      return sendJson(res, 404, { error: "unknown player" });
    }
    sendHtml(res, 200, PLAYER_HTML);
  });

  router.add("GET", "/player/:token/state", async (req, res, params) => {
    const resolved = resolvePlayerToken(db, params.token);
    if (!resolved) {
      return sendJson(res, 404, { error: "unknown player" });
    }
    sendJson(res, 200, queueStatePayload(db, resolved.venueId));
  });

  router.add("POST", "/player/:token/advance", async (req, res, params) => {
    const resolved = resolvePlayerToken(db, params.token);
    if (!resolved) {
      return sendJson(res, 404, { error: "unknown player" });
    }

    const result = advance(db, resolved.venueId);
    broadcastToClients(getWss(), db, resolved.venueId);

    if (result.type === "request") {
      return sendJson(res, 200, { type: "request", entry: toApiEntry(result.entry) });
    }
    sendJson(res, 200, result);
  });

  return router;
}

function broadcastToClients(wss, db, venueId) {
  const message = JSON.stringify({ type: "queue-state", ...queueStatePayload(db, venueId) });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  }
}

export function createServer({ db }) {
  let wss;
  const router = buildRouter(db, () => wss);

  const httpServer = createHttpServer(async (req, res) => {
    const match = router.match(req.method, req.url);
    if (!match) {
      return sendJson(res, 404, { error: "not found" });
    }
    try {
      await match.handler(req, res, match.params);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  });

  wss = new WebSocketServer({ server: httpServer });

  return { httpServer, wss, db };
}

export function broadcastQueueState(wss, db, venueId) {
  broadcastToClients(wss, db, venueId);
}

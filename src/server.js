import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WebSocketServer } from "ws";
import {
  nowPlaying,
  enqueue,
  cancel,
  advance,
  skipPlaying,
  TableAlreadyQueuedError,
} from "./queueEngine.js";
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

// Matches enqueue()'s camelCase shape.
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

function normalizeAdvanceResult(result) {
  if (result.type === "request") {
    return { type: "request", entry: toApiEntry(result.entry) };
  }
  return result;
}

function queueStatePayload(db, venueId) {
  return {
    venueId,
    nowPlaying: toApiEntry(nowPlaying(db, venueId)),
    queued: queuedList(db, venueId),
  };
}

const VALID_TABLE_KINDS = new Set(["public", "private"]);

// Shared between table creation and editing.
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

    // Private tables are always free, regardless of what was sent.
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

    // No FK cascade in this schema, so clean up manually.
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
                (SELECT token FROM pairing_tokens WHERE table_id = tables.id ORDER BY created_at DESC LIMIT 1) AS latestToken,
                (SELECT COUNT(*) FROM queue_entries WHERE table_id = tables.id AND status = 'done') AS billableCount
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
        billableCount: row.billableCount,
      })),
    );
  });

  router.add("GET", "/admin/venues/:venueId/currency", async (req, res, params) => {
    const row = db
      .prepare("SELECT currency_symbol AS currencySymbol FROM venues WHERE id = ?")
      .get(params.venueId);
    sendJson(res, 200, { currencySymbol: row?.currencySymbol ?? "" });
  });

  router.add("PUT", "/admin/venues/:venueId/currency", async (req, res, params) => {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: "invalid JSON body" });
    }
    const { currencySymbol } = body;
    if (typeof currencySymbol !== "string") {
      return sendJson(res, 400, { error: "currencySymbol must be a string" });
    }

    db.prepare(
      `INSERT INTO venues (id, name, currency_symbol, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET currency_symbol = excluded.currency_symbol`,
    ).run(params.venueId, params.venueId, currencySymbol, new Date().toISOString());

    sendJson(res, 200, { currencySymbol });
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

  router.add("GET", "/admin/venues/:venueId/player-token", async (req, res, params) => {
    const row = db
      .prepare(
        "SELECT token FROM player_tokens WHERE venue_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(params.venueId);
    sendJson(res, 200, row ? { token: row.token, url: `/player/${row.token}` } : { token: null, url: null });
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
      currencySymbol: resolved.currencySymbol,
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
    // Server-side enforcement, not just the client's own check.
    const videoId = extractVideoId(songRef);
    if (!videoId) {
      return sendJson(res, 400, { error: "songRef must be a valid YouTube link or video ID" });
    }
    // Falls back to the typed title on any lookup failure.
    const realTitle = await fetchOembedTitle(videoId);

    let entry;
    try {
      // Identity from the token only, never the request body.
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

    // Background music isn't a queue_entries row, so this covers that case too.
    if (!nowPlaying(db, resolved.venueId)) {
      const advanceResult = normalizeAdvanceResult(advance(db, resolved.venueId));
      broadcastToClients(getWss(), db, resolved.venueId, { skipTo: advanceResult });
    } else {
      broadcastToClients(getWss(), db, resolved.venueId);
    }
    sendJson(res, 201, entry);
  });

  router.add("GET", "/t/:token/preview", async (req, res, params) => {
    const resolved = resolveToken(db, params.token);
    if (!resolved) {
      return sendJson(res, 404, { error: "unknown table" });
    }

    const query = new URL(req.url, "http://internal").searchParams;
    const videoId = extractVideoId(query.get("videoId") ?? "");
    if (!videoId) {
      return sendJson(res, 400, { error: "videoId must be a valid YouTube link or video ID" });
    }

    const title = await fetchOembedTitle(videoId);
    sendJson(res, 200, { videoId, title });
  });

  router.add("DELETE", "/t/:token/queue/:entryId", async (req, res, params) => {
    const resolved = resolveToken(db, params.token);
    if (!resolved) {
      return sendJson(res, 404, { error: "unknown table" });
    }

    // Resolved tableId only, never client-supplied.
    const cancelled = cancel(db, { tableId: resolved.tableId, entryId: params.entryId });
    if (cancelled) {
      broadcastToClients(getWss(), db, resolved.venueId);
    }
    sendJson(res, 200, { cancelled });
  });

  router.add("POST", "/t/:token/queue/:entryId/skip", async (req, res, params) => {
    const resolved = resolveToken(db, params.token);
    if (!resolved) {
      return sendJson(res, 404, { error: "unknown table" });
    }

    // Resolved tableId only, never client-supplied.
    const skipResult = skipPlaying(db, { tableId: resolved.tableId, entryId: params.entryId });
    if (!skipResult) {
      return sendJson(res, 404, { error: "no matching playing entry for this table" });
    }

    const advanceResult = normalizeAdvanceResult(advance(db, resolved.venueId));
    broadcastToClients(getWss(), db, resolved.venueId, { skipTo: advanceResult });
    sendJson(res, 200, { billable: skipResult.billable, advance: advanceResult });
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

    const result = normalizeAdvanceResult(advance(db, resolved.venueId));
    broadcastToClients(getWss(), db, resolved.venueId);
    sendJson(res, 200, result);
  });

  // The video errored out (e.g. embedding blocked) instead of actually
  // playing, so unlike a normal advance, this isn't billable.
  router.add("POST", "/player/:token/error", async (req, res, params) => {
    const resolved = resolvePlayerToken(db, params.token);
    if (!resolved) {
      return sendJson(res, 404, { error: "unknown player" });
    }

    const result = normalizeAdvanceResult(advance(db, resolved.venueId, { billable: false }));
    broadcastToClients(getWss(), db, resolved.venueId, { skipTo: result });
    sendJson(res, 200, result);
  });

  return router;
}

function broadcastToClients(wss, db, venueId, extra = {}) {
  const message = JSON.stringify({
    type: "queue-state",
    ...queueStatePayload(db, venueId),
    ...extra,
  });
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

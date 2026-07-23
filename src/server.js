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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TABLE_HTML = readFileSync(path.join(__dirname, "..", "public", "table.html"), "utf8");
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

function buildRouter(db, getWss) {
  const router = new Router();

  router.add("GET", "/healthz", async (req, res) => {
    sendJson(res, 200, { ok: true });
  });

  router.add("POST", "/admin/venues/:venueId/tables", async (req, res, params) => {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: "invalid JSON body" });
    }
    const { label, kind } = body;
    if (typeof label !== "string" || !label.trim()) {
      return sendJson(res, 400, { error: "label is required" });
    }
    if (!VALID_TABLE_KINDS.has(kind)) {
      return sendJson(res, 400, { error: "kind must be 'public' or 'private'" });
    }

    const id = randomUUID();
    db.prepare(
      "INSERT INTO tables (id, venue_id, label, kind, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, params.venueId, label, kind, new Date().toISOString());

    sendJson(res, 201, { id, venueId: params.venueId, label, kind });
  });

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

    let entry;
    try {
      // Table identity comes ONLY from the resolved token, never from the
      // request body — this is the actual anti-impersonation enforcement
      // point for this route.
      entry = enqueue(db, {
        venueId: resolved.venueId,
        tableId: resolved.tableId,
        songTitle: title,
        songRef,
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

import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { nowPlaying } from "./queueEngine.js";
import { createPairing } from "./pairing.js";
import { Router } from "./router.js";

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
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

const VALID_TABLE_KINDS = new Set(["public", "private"]);

function buildRouter(db) {
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

  return router;
}

export function createServer({ db }) {
  const router = buildRouter(db);

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

  const wss = new WebSocketServer({ server: httpServer });

  return { httpServer, wss, db };
}

function queuedList(db, venueId) {
  return db
    .prepare(
      "SELECT * FROM queue_entries WHERE venue_id = ? AND status = 'queued' ORDER BY queued_at ASC",
    )
    .all(venueId);
}

export function broadcastQueueState(wss, db, venueId) {
  const message = JSON.stringify({
    type: "queue-state",
    venueId,
    nowPlaying: nowPlaying(db, venueId),
    queued: queuedList(db, venueId),
  });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  }
}

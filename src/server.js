import { createServer as createHttpServer } from "node:http";
import { WebSocketServer } from "ws";
import { nowPlaying } from "./queueEngine.js";

export function createServer({ db }) {
  const httpServer = createHttpServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
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

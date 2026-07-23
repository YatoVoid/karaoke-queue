import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { networkInterfaces } from "node:os";
import { openDatabase } from "./db.js";
import { createServer } from "./server.js";

export function formatStartupBanner(port, interfaces) {
  const lines = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        lines.push(`  http://${entry.address}:${port}/admin/venues/<venue-id>`);
      }
    }
  }
  return lines;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8080);
  const dbPath = process.env.DB_PATH ?? "./data/karaoke-queue.sqlite";

  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  const { httpServer } = createServer({ db });

  httpServer.listen(port, () => {
    const banner = formatStartupBanner(port, networkInterfaces());
    console.log(`karaoke-queue listening on port ${port}`);
    console.log(`Database: ${dbPath}`);
    console.log("");
    console.log("There is no venue-registration step — pick any consistent");
    console.log("string as your venue id (e.g. \"main\") the first time you");
    console.log("visit an admin URL with it. Open one of these on a device");
    console.log("connected to the same network to set up tables:");
    console.log("");
    if (banner.length > 0) {
      banner.forEach((line) => console.log(line));
    } else {
      console.log(`  http://localhost:${port}/admin/venues/<venue-id>`);
      console.log("  (no LAN-reachable network interface detected)");
    }
  });
}

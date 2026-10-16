// Sara Games Platform - Standalone Server
// Replicates the Hatch space runtime: serves static client, dispatches actions,
// provides SQLite (drizzle) + filesystem blobs.
//
// Auth model (Khan's GameJolt/itch.io design):
//   PUBLIC (no login): listGames, getGame (play free), recordPlay, listFeed, getProfile, me
//   LOGIN REQUIRED: downloadGame (NEW), uploadGame, createPost, toggleLike, addComment,
//                   purchaseGame, dashboard, updateProfile

import { createServer } from "node:http";
import { readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { join, extname, dirname } from "node:path";
import { existsSync } from "node:fs";

const PORT = process.env.PORT || 3000;
const DIR = dirname(new URL(import.meta.url).pathname);
const PUBLIC_DIR = join(DIR, "public");
const DATA_DIR = join(DIR, "data");
const DB_PATH = join(DATA_DIR, "app.db");
const BLOBS_DIR = join(DATA_DIR, "blobs");
const BLOBS_INDEX = join(BLOBS_DIR, "index.sqlite");

// ---- SQLite via bun:sqlite (blobs index) + libsql/drizzle (app data) ----
const { Database } = await import("bun:sqlite");
const sqlite = new Database(BLOBS_INDEX);

const { createClient } = await import("@libsql/client");
const { drizzle } = await import("drizzle-orm/libsql");
const libsqlClient = createClient({ url: `file:${DB_PATH}` });
const db = drizzle(libsqlClient);

// ---- Blob store (mirrors Hatch layout: objects/<2>/<full-id>, index.sqlite) ----
async function blobInit() {
  await mkdir(join(BLOBS_DIR, "objects"), { recursive: true });
}
function objectPath(objectId) {
  return join(BLOBS_DIR, "objects", objectId.slice(0, 2), objectId);
}
async function blobGetMeta(key) {
  const row = sqlite.prepare("SELECT * FROM blobs WHERE key = ?").get(key);
  // sqlite may be bun or node:sqlite; normalize
  return row || null;
}
// Ensure blobs index exists (copy already has it, but be safe)
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS blobs (
    key TEXT PRIMARY KEY NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    etag TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'private',
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    object_id TEXT
  )`);
} catch (e) { console.error("blob index init:", e.message); }

const blobs = {
  async put(key, data, options = {}) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const objectId = createHash("sha256").update(bytes).digest("hex");
    const p = objectPath(objectId);
    await mkdir(dirname(p), { recursive: true });
    if (!existsSync(p)) await writeFile(p, bytes);
    const now = Date.now();
    const etag = objectId.slice(0, 32);
    const ct = options.contentType || "application/octet-stream";
    try {
      sqlite.prepare(`INSERT INTO blobs (key, content_type, size_bytes, etag, visibility, created_at_ms, updated_at_ms, object_id)
        VALUES (?, ?, ?, ?, 'private', ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET content_type=excluded.content_type, size_bytes=excluded.size_bytes,
        etag=excluded.etag, updated_at_ms=excluded.updated_at_ms, object_id=excluded.object_id`).run(
        key, ct, bytes.length, etag, now, now, objectId);
    } catch (e) {
      // node:sqlite uses different param style? No - both use ?. Try plain exec fallback
      throw e;
    }
  },
  async getUrl(key, _options = {}) {
    const meta = await blobGetMeta(key);
    if (!meta) return null;
    return `/blobs/${encodeURIComponent(key)}`;
  },
  async delete(key) {
    sqlite.prepare("DELETE FROM blobs WHERE key = ?").run(key);
  },
  async head(key) {
    return await blobGetMeta(key);
  },
  async list(prefix = "") {
    const rows = sqlite.prepare("SELECT * FROM blobs WHERE key LIKE ?").all(prefix + "%");
    return rows || [];
  },
};

// ---- Load actions ----
const { Actions } = await import("./actions.js");
// Brand check (same as SDK's isAction, without the SDK dependency)
const ACTION_BRAND = "@hatch/space-sdk/action/v1";
const actionTable = {};
for (const [name, def] of Object.entries(Actions)) {
  if (def && typeof def === "object" && def.__brand === ACTION_BRAND && typeof def.handler === "function") {
    actionTable[name] = def;
  }
}
console.log(`Loaded ${Object.keys(actionTable).length} actions`);

// ---- NEW: downloadGame action (Khan: login required to download) ----
actionTable["downloadGame"] = {
  __brand: "@hatch/space-sdk/action/v1",
  request: null, // validated manually
  response: null,
  handler: async (ctx, args) => {
    const token = args?.token;
    if (!token) throw new Error("Login required to download games.");
    // Raw session lookup via the libsql client (drizzle wrapper has no .execute)
    const sres = await libsqlClient.execute({
      sql: "SELECT user_id FROM sessions WHERE token = ? LIMIT 1",
      args: [String(token)],
    });
    const srows = sres.rows || [];
    if (!srows.length) throw new Error("Login required to download games. Please sign in.");
    const userId = Number(srows[0].user_id);
    const gameId = Number(args.gameId);
    if (!gameId) throw new Error("Missing game id.");
    const gres = await libsqlClient.execute({
      sql: "SELECT id, title, price_cents, creator_id, html_content FROM games WHERE id = ? LIMIT 1",
      args: [gameId],
    });
    const grows = gres.rows || [];
    if (!grows.length) throw new Error("Game not found.");
    const g = grows[0];
    const price = Number(g.price_cents ?? 0);
    const creatorId = Number(g.creator_id);
    if (price > 0 && creatorId !== userId) {
      const pres = await libsqlClient.execute({
        sql: "SELECT id FROM purchases WHERE buyer_id = ? AND game_id = ? LIMIT 1",
        args: [userId, gameId],
      });
      if (!(pres.rows || []).length) throw new Error("Purchase this game to download it.");
    }
    const html = g.html_content;
    const title = g.title || `game-${gameId}`;
    if (!html) throw new Error("This game has no downloadable file (it links to an external page).");
    return {
      filename: `${String(title).toLowerCase().replace(/[^a-z0-9]+/g, "-")}.html`,
      htmlContent: html,
    };
  },
};

// ---- Ctx factory ----
function makeCtx() {
  return {
    slug: "sara-games-platform",
    invocationId: randomBytes(8).toString("hex"),
    spaceDir: DIR,
    db: () => db,
    blobs,
    emit: () => {},
    invalidateQueries: () => {},
    // Stubs (not used by these actions)
    agent: { spawnTask: async () => { throw new Error("not supported"); } },
    inference: { complete: async () => { throw new Error("not supported"); } },
    tool: {},
  };
}

// ---- MIME types ----
const MIME = {
  ".html": "text/html", ".js": "application/javascript", ".mjs": "application/javascript",
  ".css": "text/css", ".json": "application/json", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
  ".mp4": "video/mp4", ".webm": "video/webm", ".txt": "text/plain",
  ".xml": "application/xml",
};

// ---- Server ----
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // CORS (same-origin by default, but harmless)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type, x-request-id");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    // POST /actions
    if (pathname === "/actions" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = {}; }
      const { action, args } = parsed;
      const def = actionTable[action];
      if (!def) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `unknown action: ${action}` }));
        return;
      }
      try {
        let validated = args ?? {};
        if (def.request && typeof def.request.parse === "function") {
          validated = def.request.parse(validated);
        }
        const ctx = makeCtx();
        const data = await def.handler(ctx, validated);
        let out = data;
        if (def.response && typeof def.response.parse === "function") {
          try { out = def.response.parse(data); } catch { out = data; }
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: out }));
      } catch (e) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e.message || "action failed" }));
      }
      return;
    }

    // GET /blobs/<key>
    if (pathname.startsWith("/blobs/")) {
      const key = decodeURIComponent(pathname.slice("/blobs/".length));
      const meta = await blobGetMeta(key);
      if (!meta || !meta.object_id) {
        res.writeHead(404); res.end("not found"); return;
      }
      const p = objectPath(meta.object_id);
      if (!existsSync(p)) { res.writeHead(404); res.end("not found"); return; }
      const data = await readFile(p);
      res.writeHead(200, {
        "content-type": meta.content_type || "application/octet-stream",
        "content-length": data.length,
        "cache-control": "public, max-age=31536000",
      });
      res.end(data);
      return;
    }

    // Health
    if (pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, actions: Object.keys(actionTable).length }));
      return;
    }

    // Static files (SPA fallback to index.html)
    let filePath = join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname.slice(1));
    // Prevent path traversal
    if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
    try {
      const st = await stat(filePath);
      if (st.isDirectory()) filePath = join(filePath, "index.html");
    } catch {
      filePath = join(PUBLIC_DIR, "index.html");
    }
    try {
      const data = await readFile(filePath);
      res.writeHead(200, { "content-type": MIME[extname(filePath)] || "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404); res.end("not found");
    }
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
});

await blobInit();

// Auto-bootstrap seed catalog if games table is empty (for ephemeral hosts)
try {
  const countRes = await libsqlClient.execute("SELECT COUNT(*) as c FROM games");
  const count = Number(countRes.rows?.[0]?.c ?? 0);
  if (count === 0) {
    console.log("Games table empty — running bootstrapCatalog...");
    const def = actionTable["bootstrapCatalog"];
    if (def) {
      const out = await def.handler(makeCtx(), {});
      console.log("Bootstrap result:", JSON.stringify(out));
    }
  } else {
    console.log(`Games table has ${count} games — skipping bootstrap.`);
  }
} catch (e) {
  console.error("Bootstrap check failed:", e.message);
}

server.listen(PORT, () => console.log(`Sara Games Platform listening on :${PORT}`));

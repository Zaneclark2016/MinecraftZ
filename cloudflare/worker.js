const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extra }
  });
}

function cors(response) {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  headers.set("access-control-allow-headers", "content-type,authorization");
  headers.set("access-control-max-age", "86400");
  return new Response(response.body, { status: response.status, headers });
}

function randomToken(bytes = 32) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(data, b => b.toString(16).padStart(2, "0")).join("");
}

async function hashToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

function validId(value) {
  return typeof value === "string" && /^[a-f0-9]{24}$/.test(value);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    try {
      if (url.pathname === "/api/health" && request.method === "GET") {
        return cors(json({ ok: true, service: "MinecraftZ Worlds API", version: 1 }));
      }

      if (url.pathname === "/api/worlds" && request.method === "POST") {
        const body = await request.json();
        const id = randomToken(12);
        const ownerToken = randomToken();
        const stub = env.WORLDS.get(env.WORLDS.idFromName(id));
        const result = await stub.fetch("https://world.internal/init", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id,
            ownerHash: await hashToken(ownerToken),
            meta: {
              name: String(body.name || "My MinecraftZ World").slice(0, 48),
              visibility: body.visibility === "public" ? "public" : "private",
              created: Date.now(),
              settings: body.settings && typeof body.settings === "object" ? body.settings : {}
            }
          })
        });
        if (!result.ok) return cors(json({ error: "Could not create world." }, 500));
        return cors(json({ id, ownerToken }));
      }

      if (parts[0] === "api" && parts[1] === "worlds" && validId(parts[2])) {
        const id = parts[2];
        const stub = env.WORLDS.get(env.WORLDS.idFromName(id));
        const headers = new Headers(request.headers);
        headers.set("x-world-id", id);

        if (parts.length === 3 && request.method === "GET") {
          return cors(await stub.fetch("https://world.internal/world", { headers }));
        }
        if (parts[3] === "join" && request.method === "POST") {
          return cors(await stub.fetch("https://world.internal/join", {
            method: "POST", headers, body: request.body
          }));
        }
        if (parts[3] === "invites" && request.method === "POST") {
          const body = await request.json();
          const token = randomToken();
          const result = await stub.fetch("https://world.internal/invites", {
            method: "POST",
            headers,
            body: JSON.stringify({ role: body.role, token, tokenHash: await hashToken(token) })
          });
          const data = await result.json();
          return cors(json(result.ok ? { ...data, token } : data, result.status));
        }
        if (parts[3] === "edits" && request.method === "POST") {
          return cors(await stub.fetch("https://world.internal/edits", {
            method: "POST", headers, body: request.body
          }));
        }
        if (parts[3] === "signs" && request.method === "POST") {
          return cors(await stub.fetch("https://world.internal/signs", {
            method: "POST", headers, body: request.body
          }));
        }
      }

      return cors(json({ error: "Not found." }, 404));
    } catch (error) {
      return cors(json({ error: "Request failed.", detail: String(error).slice(0, 160) }, 400));
    }
  }
};

export class World {
  constructor(ctx) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS world (id TEXT PRIMARY KEY, owner_hash TEXT NOT NULL, meta TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS invites (token_hash TEXT PRIMARY KEY, role TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS edits (chunk TEXT NOT NULL, block_index INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(chunk, block_index));
      CREATE TABLE IF NOT EXISTS signs (coords TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/init" && request.method === "POST") {
        const body = await request.json();
        this.sql.exec(
          "INSERT OR IGNORE INTO world (id, owner_hash, meta) VALUES (?, ?, ?)",
          body.id, body.ownerHash, JSON.stringify(body.meta)
        );
        return json({ ok: true });
      }

      const world = this.sql.exec("SELECT id, owner_hash, meta FROM world LIMIT 1").one();
      if (!world) return json({ error: "World not found." }, 404);
      const meta = JSON.parse(world.meta);

      if (url.pathname === "/join" && request.method === "POST") {
        const body = await request.json();
        const tokenHash = await hashToken(String(body.invite || ""));
        const invite = this.sql.exec("SELECT role FROM invites WHERE token_hash = ?", tokenHash).toArray()[0];
        if (!invite) return json({ error: "That invite code is invalid or has been revoked." }, 403);
        return json({ id: world.id, meta, role: invite.role });
      }

      const auth = request.headers.get("authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const tokenHash = token ? await hashToken(token) : "";
      const isOwner = !!tokenHash && tokenHash === world.owner_hash;
      const invite = tokenHash
        ? this.sql.exec("SELECT role FROM invites WHERE token_hash = ?", tokenHash).toArray()[0]
        : null;
      const role = isOwner ? "owner" : invite?.role || null;

      if (url.pathname === "/world" && request.method === "GET") {
        if (meta.visibility !== "public" && !role) return json({ error: "This world is private. An invite is required." }, 403);
        return json({
          id: world.id, meta, role: role || "visitor",
          edits: this.sql.exec("SELECT chunk, block_index AS blockIndex, value FROM edits").toArray(),
          signs: this.sql.exec("SELECT coords, value FROM signs").toArray()
        });
      }

      if (url.pathname === "/invites" && request.method === "POST") {
        if (!isOwner) return json({ error: "Only the owner can create invites." }, 403);
        const body = await request.json();
        if (!["builder", "visitor"].includes(body.role)) return json({ error: "Role must be builder or visitor." }, 400);
        this.sql.exec("INSERT INTO invites (token_hash, role) VALUES (?, ?)", body.tokenHash, body.role);
        return json({ ok: true, role: body.role });
      }

      if (url.pathname === "/edits" && request.method === "POST") {
        if (!isOwner && role !== "builder") return json({ error: "You do not have building permission." }, 403);
        const body = await request.json();
        if (!Array.isArray(body.edits) || body.edits.length > 250) return json({ error: "Send up to 250 edits per request." }, 400);
        for (const edit of body.edits) {
          if (typeof edit.chunk !== "string" || edit.chunk.length > 80 ||
              !Number.isInteger(edit.blockIndex) || edit.blockIndex < 0 ||
              typeof edit.value !== "string" || edit.value.length > 100) continue;
          this.sql.exec(
            "INSERT INTO edits (chunk, block_index, value) VALUES (?, ?, ?) ON CONFLICT(chunk, block_index) DO UPDATE SET value = excluded.value",
            edit.chunk, edit.blockIndex, edit.value
          );
        }
        return json({ ok: true, saved: body.edits.length });
      }

      if (url.pathname === "/signs" && request.method === "POST") {
        if (!isOwner && role !== "builder") return json({ error: "You do not have building permission." }, 403);
        const body = await request.json();
        if (!Array.isArray(body.signs) || body.signs.length > 100) return json({ error: "Send up to 100 signs per request." }, 400);
        for (const sign of body.signs) {
          if (typeof sign.coords !== "string" || sign.coords.length > 100 ||
              typeof sign.value !== "string" || sign.value.length > 1000) continue;
          this.sql.exec(
            "INSERT INTO signs (coords, value) VALUES (?, ?) ON CONFLICT(coords) DO UPDATE SET value = excluded.value",
            sign.coords, sign.value
          );
        }
        return json({ ok: true, saved: body.signs.length });
      }

      return json({ error: "Not found." }, 404);
    } catch (error) {
      return json({ error: "World request failed.", detail: String(error).slice(0, 160) }, 400);
    }
  }
}

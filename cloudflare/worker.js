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
        if (body.visibility === "public") {
          await env.REGISTRY.get(env.REGISTRY.idFromName("registry")).fetch("https://registry.internal/touch", {
            method: "POST", body: JSON.stringify({ id, name: String(body.name || "My MinecraftZ World").slice(0, 48), mode: String((body.settings && body.settings.mode) || "creative").slice(0, 12) })
          });
        }
        return cors(json({ id, ownerToken }));
      }

      if (parts[0] === "api" && parts[1] === "account" && parts.length === 3) {
        const action = parts[2];
        let user = "";
        let body = {};
        if (request.method === "POST") body = await request.json().catch(() => ({}));
        user = String(body.username || url.searchParams.get("u") || "");
        if (!/^[A-Za-z0-9_]{3,16}$/.test(user)) return cors(json({ error: "Usernames are 3 to 16 letters, numbers or underscores." }, 400));
        if (!["register", "login", "logout", "data", "rename"].includes(action)) return cors(json({ error: "Not found." }, 404));
        if ((action === "register" || action === "login" || action === "rename") && (typeof body.password !== "string" || body.password.length < 6 || body.password.length > 100)) {
          return cors(json({ error: "Passwords need 6 to 100 characters." }, 400));
        }
        const stub = env.ACCOUNTS.get(env.ACCOUNTS.idFromName("u:" + user.toLowerCase()));
        const headers = new Headers({ "content-type": "application/json" });
        const auth = request.headers.get("authorization");
        if (auth) headers.set("authorization", auth);
        if (action === "rename") {
          const nu = String(body.newUsername || "");
          if (!/^[A-Za-z0-9_]{3,16}$/.test(nu)) return cors(json({ error: "Usernames are 3 to 16 letters, numbers or underscores." }, 400));
          const call = (s, path, payload) => s.fetch("https://account.internal/" + path, { method: "POST", headers, body: JSON.stringify(payload) });
          if (nu.toLowerCase() === user.toLowerCase()) {
            return cors(await call(stub, "recase", { username: user, password: body.password, newUsername: nu }));
          }
          const ex = await call(stub, "export", { username: user, password: body.password });
          if (!ex.ok) return cors(ex);
          const exported = await ex.json();
          const newStub = env.ACCOUNTS.get(env.ACCOUNTS.idFromName("u:" + nu.toLowerCase()));
          const im = await call(newStub, "import", { username: nu, salt: exported.salt, hash: exported.hash, data: exported.data });
          if (!im.ok) return cors(im);
          await call(stub, "close", { username: user });
          return cors(im);
        }
        const res = await stub.fetch("https://account.internal/" + action + "?method=" + request.method, {
          method: "POST", headers, body: JSON.stringify({ ...body, username: user })
        });
        return cors(res);
      }

      if (url.pathname === "/api/public" && request.method === "GET") {
        return cors(await env.REGISTRY.get(env.REGISTRY.idFromName("registry")).fetch("https://registry.internal/list"));
      }

      if (parts[0] === "api" && parts[1] === "worlds" && validId(parts[2])) {
        const id = parts[2];
        const stub = env.WORLDS.get(env.WORLDS.idFromName(id));
        const headers = new Headers(request.headers);
        headers.set("x-world-id", id);

        if (parts.length === 3 && request.method === "GET") {
          return cors(await stub.fetch("https://world.internal/world", { headers }));
        }
        if (parts[3] === "ping" && request.method === "POST") {
          const r = await stub.fetch("https://world.internal/ping", { method: "POST", headers });
          const info = await r.json();
          if (r.ok && info.visibility === "public") {
            await env.REGISTRY.get(env.REGISTRY.idFromName("registry")).fetch("https://registry.internal/touch", {
              method: "POST", body: JSON.stringify({ id, name: info.name, mode: info.mode })
            });
          }
          return cors(json({ ok: r.ok }, r.ok ? 200 : r.status));
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
        if (parts[3] === "players" && request.method === "POST") {
          return cors(await stub.fetch("https://world.internal/players", {
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
      CREATE TABLE IF NOT EXISTS players (
        player_id TEXT PRIMARY KEY, name TEXT NOT NULL,
        x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL,
        yaw REAL NOT NULL, pitch REAL NOT NULL, seen_at INTEGER NOT NULL,
        dim INTEGER NOT NULL DEFAULT 0
      );
    `);
    try { this.sql.exec("ALTER TABLE players ADD COLUMN dim INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
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
        if (meta.visibility === "public" && !body.invite) return json({ id: world.id, meta, role: "builder" });
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
      const role = isOwner ? "owner" : invite?.role || (meta.visibility === "public" ? "builder" : null);

      if (url.pathname === "/ping" && request.method === "POST") {
        if (!role) return json({ error: "Not allowed." }, 403);
        return json({ ok: true, visibility: meta.visibility, name: meta.name, mode: (meta.settings && meta.settings.mode) || "creative" });
      }

      if (url.pathname === "/players" && request.method === "POST") {
        if (!role) return json({ error: "An invite is required to share player presence." }, 403);
        const body = await request.json();
        const id = String(body.id || "");
        const name = String(body.name || "Player").replace(/[\\u0000-\\u001f]/g, "").slice(0, 16) || "Player";
        const values = [body.x, body.y, body.z, body.yaw, body.pitch].map(Number);
        const dim = body.dim === 1 ? 1 : 0;
        if (!/^[A-Za-z0-9_-]{8,64}$/.test(id) ||
            !values.every(Number.isFinite) ||
            Math.abs(values[0]) > 5000000 || values[1] < 0 || values[1] > 512 ||
            Math.abs(values[2]) > 5000000 || Math.abs(values[3]) > 1000 || Math.abs(values[4]) > 1000 ||
            (body.dim !== undefined && body.dim !== 0 && body.dim !== 1)) {
          return json({ error: "Invalid player position." }, 400);
        }
        const now = Date.now();
        this.sql.exec("DELETE FROM players WHERE seen_at < ?", now - 12000);
        this.sql.exec(
          "INSERT INTO players (player_id, name, x, y, z, yaw, pitch, seen_at, dim) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(player_id) DO UPDATE SET name=excluded.name, x=excluded.x, y=excluded.y, z=excluded.z, yaw=excluded.yaw, pitch=excluded.pitch, seen_at=excluded.seen_at, dim=excluded.dim",
          id, name, values[0], values[1], values[2], values[3], values[4], now, dim
        );
        const players = this.sql.exec(
          "SELECT player_id AS id, name, x, y, z, yaw, pitch, dim FROM players WHERE seen_at >= ? ORDER BY seen_at DESC LIMIT 8",
          now - 12000
        ).toArray();
        return json({ ok: true, players });
      }

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

export class Registry {
  constructor(ctx) {
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS pub (id TEXT PRIMARY KEY, name TEXT NOT NULL, mode TEXT NOT NULL, created INTEGER NOT NULL, seen INTEGER NOT NULL)");
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/touch" && request.method === "POST") {
      const b = await request.json();
      const now = Date.now();
      this.sql.exec(
        "INSERT INTO pub (id, name, mode, created, seen) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, mode=excluded.mode, seen=excluded.seen",
        String(b.id), String(b.name || "World").replace(/[\u0000-\u001f]/g, "").slice(0, 48), String(b.mode || "creative").slice(0, 12), now, now
      );
      return json({ ok: true });
    }
    if (url.pathname === "/list") {
      const now = Date.now();
      this.sql.exec("DELETE FROM pub WHERE seen < ?", now - 30 * 86400000);
      const rows = this.sql.exec("SELECT id, name, mode, created, seen FROM pub ORDER BY seen DESC LIMIT 40").toArray();
      return json({ worlds: rows, now });
    }
    return json({ error: "Not found." }, 404);
  }
}

async function pbkdf2Hex(password, saltHex) {
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
  return Array.from(new Uint8Array(bits), b => b.toString(16).padStart(2, "0")).join("");
}

function sameString(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export class Account {
  constructor(ctx) {
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS acct (id INTEGER PRIMARY KEY CHECK (id = 1), username TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, created INTEGER NOT NULL, data TEXT NOT NULL DEFAULT '[]', fails INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, created INTEGER NOT NULL);
    `);
  }

  async newSession() {
    const token = randomToken();
    this.sql.exec("INSERT INTO sessions (token_hash, created) VALUES (?, ?)", await hashToken(token), Date.now());
    this.sql.exec("DELETE FROM sessions WHERE token_hash NOT IN (SELECT token_hash FROM sessions ORDER BY created DESC LIMIT 8)");
    return token;
  }

  async authed(request) {
    const auth = request.headers.get("authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) return false;
    const row = this.sql.exec("SELECT token_hash FROM sessions WHERE token_hash = ?", await hashToken(token)).toArray()[0];
    return !!row;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const action = url.pathname.slice(1);
    try {
      const body = await request.json().catch(() => ({}));
      const row = this.sql.exec("SELECT * FROM acct WHERE id = 1").toArray()[0];

      if (action === "register") {
        if (row) return json({ error: "That username is taken." }, 409);
        const salt = randomToken(16);
        const hash = await pbkdf2Hex(body.password, salt);
        this.sql.exec("INSERT INTO acct (id, username, salt, hash, created) VALUES (1, ?, ?, ?, ?)", body.username, salt, hash, Date.now());
        return json({ ok: true, username: body.username, token: await this.newSession(), worlds: [] });
      }

      if (action === "login") {
        if (!row) return json({ error: "Wrong username or password." }, 403);
        if (row.locked_until > Date.now()) return json({ error: "Too many wrong tries. Wait a few minutes and try again." }, 429);
        const hash = await pbkdf2Hex(body.password, row.salt);
        if (!sameString(hash, row.hash)) {
          const fails = row.fails + 1;
          this.sql.exec("UPDATE acct SET fails = ?, locked_until = ? WHERE id = 1", fails >= 5 ? 0 : fails, fails >= 5 ? Date.now() + 15 * 60000 : 0);
          return json({ error: "Wrong username or password." }, 403);
        }
        this.sql.exec("UPDATE acct SET fails = 0, locked_until = 0 WHERE id = 1");
        return json({ ok: true, username: row.username, token: await this.newSession(), worlds: JSON.parse(row.data || "[]") });
      }

      if (action === "import") {
        if (row) return json({ error: "That username is taken." }, 409);
        this.sql.exec("INSERT INTO acct (id, username, salt, hash, created, data) VALUES (1, ?, ?, ?, ?, ?)", body.username, String(body.salt), String(body.hash), Date.now(), String(body.data || "[]"));
        return json({ ok: true, username: body.username, token: await this.newSession(), worlds: JSON.parse(body.data || "[]") });
      }

      if (!row || !(await this.authed(request))) return json({ error: "Please log in again." }, 401);

      if (action === "export" || action === "recase") {
        if (row.locked_until > Date.now()) return json({ error: "Too many wrong tries. Wait a few minutes and try again." }, 429);
        const h = await pbkdf2Hex(String(body.password || ""), row.salt);
        if (!sameString(h, row.hash)) {
          const fails = row.fails + 1;
          this.sql.exec("UPDATE acct SET fails = ?, locked_until = ? WHERE id = 1", fails >= 5 ? 0 : fails, fails >= 5 ? Date.now() + 15 * 60000 : 0);
          return json({ error: "Wrong password." }, 403);
        }
        this.sql.exec("UPDATE acct SET fails = 0, locked_until = 0 WHERE id = 1");
        if (action === "recase") {
          this.sql.exec("UPDATE acct SET username = ? WHERE id = 1", body.newUsername);
          return json({ ok: true, username: body.newUsername, worlds: JSON.parse(row.data || "[]") });
        }
        return json({ ok: true, salt: row.salt, hash: row.hash, data: row.data });
      }

      if (action === "close") {
        this.sql.exec("DELETE FROM acct WHERE id = 1");
        this.sql.exec("DELETE FROM sessions");
        return json({ ok: true });
      }

      if (action === "logout") {
        const auth = request.headers.get("authorization") || "";
        this.sql.exec("DELETE FROM sessions WHERE token_hash = ?", await hashToken(auth.slice(7)));
        return json({ ok: true });
      }

      if (action === "data") {
        if (url.searchParams.get("method") === "GET") return json({ ok: true, worlds: JSON.parse(row.data || "[]") });
        if (!Array.isArray(body.worlds) || body.worlds.length > 100) return json({ error: "Too many worlds." }, 400);
        const text = JSON.stringify(body.worlds);
        if (text.length > 400000) return json({ error: "Too much data." }, 400);
        this.sql.exec("UPDATE acct SET data = ? WHERE id = 1", text);
        return json({ ok: true, saved: body.worlds.length });
      }

      return json({ error: "Not found." }, 404);
    } catch (error) {
      return json({ error: "Account request failed.", detail: String(error).slice(0, 160) }, 400);
    }
  }
}

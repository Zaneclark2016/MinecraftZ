const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('MinecraftZ relay is running\n');
});
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 * 1024 });

const peers = new Map();
const links = new Map();
const STALE_MS = 45000;

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function dropLinks(ws) {
  for (const [cid, l] of links) {
    if (l.a === ws || l.b === ws) {
      send(l.a === ws ? l.b : l.a, { op: 'x', cid });
      links.delete(cid);
    }
  }
}

function release(ws) {
  if (ws.pid && peers.get(ws.pid) === ws) peers.delete(ws.pid);
  dropLinks(ws);
}

wss.on('connection', (ws) => {
  ws.pid = null;
  ws.seen = Date.now();
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; ws.seen = Date.now(); });

  ws.on('message', (raw) => {
    ws.seen = Date.now();
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.op !== 'string') return;

    if (m.op === 'ping') { send(ws, { op: 'pong' }); return; }

    if (m.op === 'reg') {
      if (ws.pid) return;
      let id = typeof m.id === 'string' ? m.id.slice(0, 96) : '';
      if (id) {
        const old = peers.get(id);
        if (old && old !== ws) {
          if (old.readyState === 1 && Date.now() - old.seen < STALE_MS) {
            send(ws, { op: 'err', type: 'unavailable-id' });
            return;
          }
          release(old);
          try { old.terminate(); } catch (e) {}
        }
      } else {
        do { id = Math.random().toString(36).slice(2, 12); } while (peers.has(id));
      }
      ws.pid = id;
      peers.set(id, ws);
      send(ws, { op: 'open', id });
      return;
    }

    if (!ws.pid) return;

    if (m.op === 'conn') {
      const target = peers.get(m.to);
      if (!target || target.readyState !== 1 || typeof m.cid !== 'string' || links.has(m.cid)) {
        send(ws, { op: 'cerr', cid: m.cid, type: 'peer-unavailable', to: m.to });
        return;
      }
      links.set(m.cid, { a: ws, b: target });
      send(target, { op: 'inc', cid: m.cid, from: ws.pid });
      send(ws, { op: 'opened', cid: m.cid });
      return;
    }

    if (m.op === 'd') {
      const l = links.get(m.cid);
      if (!l) return;
      const other = l.a === ws ? l.b : l.b === ws ? l.a : null;
      if (other) send(other, { op: 'd', cid: m.cid, d: m.d });
      return;
    }

    if (m.op === 'x') {
      const l = links.get(m.cid);
      if (!l) return;
      if (l.a !== ws && l.b !== ws) return;
      send(l.a === ws ? l.b : l.a, { op: 'x', cid: m.cid });
      links.delete(m.cid);
    }
  });

  ws.on('close', () => release(ws));
  ws.on('error', () => {});
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { release(ws); ws.terminate(); continue; }
    ws.alive = false;
    try { ws.ping(); } catch (e) {}
  }
}, 20000);

server.listen(PORT, () => console.log('MinecraftZ relay listening on ' + PORT));

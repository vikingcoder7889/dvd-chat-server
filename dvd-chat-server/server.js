// server.js
import http from 'http';
import { WebSocketServer } from 'ws';

const LOG_MAX = 300;
let log = []; // [{type:'system'|'user', user?, text, ts}]
const clients = new Map(); // ws -> {user, room, bucket}

function broadcast(obj, room='global'){
  const data = JSON.stringify(obj);
  for (const [ws, meta] of clients.entries()){
    if (meta.room === room && ws.readyState === ws.OPEN) ws.send(data);
  }
}

function pushLog(evt){
  log.push(evt);
  if (log.length > LOG_MAX) log = log.slice(-LOG_MAX);
}

const BAD_WORDS = [/fuck/i, /cunt/i, /nigg/i, /kike/i, /spic/i, /retard/i];

function clean(text){
  let t = String(text||'').slice(0, 500);
  for (const re of BAD_WORDS) t = t.replace(re, '****');
  return t;
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server, path: '/chat' });

wss.on('connection', (ws) => {
  const meta = { user: 'anon', room: 'global', bucket: {t0: Date.now(), n: 0} };
  clients.set(ws, meta);

  ws.send(JSON.stringify({ t: 'welcome', log, users: clients.size }));
  broadcast({ t:'count', n: clients.size });

  ws.on('message', (buf) => {
    let msg = {};
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    // simple leaky bucket: 10 msgs / 10s per socket
    const b = meta.bucket; const now = Date.now();
    if (now - b.t0 > 10_000){ b.t0 = now; b.n = 0; }
    if (++b.n > 10){ ws.send(JSON.stringify({t:'error', text:'Rate limit exceeded'})); return; }

    if (msg.t === 'hello'){
      meta.user = String(msg.user || 'anon').slice(0, 24);
      meta.room = String(msg.room || 'global');
      return;
    }
    if (msg.t === 'chat'){
      const text = clean(msg.text);
      const evt = { type:'user', user: meta.user, text, ts: msg.ts || new Date().toISOString() };
      pushLog(evt);
      broadcast({ t:'chat', user: evt.user, text: evt.text, ts: evt.ts }, meta.room);
      return;
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    broadcast({ t:'count', n: clients.size });
  });
});

const PORT = process.env.PORT || 8787;
server.listen(PORT, () => console.log('chat ws listening on :' + PORT));

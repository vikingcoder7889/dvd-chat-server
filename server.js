/* server.js (ESM) — Observer-sync patch */
import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';
import { Connection, PublicKey, SystemProgram, Transaction, clusterApiUrl } from '@solana/web3.js';

/* =========================
   Config (env + constants)
   ========================= */
const RECEIVER_PUBKEY = new PublicKey(process.env.RECEIVER_PUBKEY); // set this in Render env
const CLAIM_DURATION_MS = 15 * 60 * 1000;        // 15 minutes per paid slot
const MIN_LAMPORTS     = Math.floor(0.01 * 1e9); // 0.01 SOL
const DEFAULT_OVERLAY_LOGO = '/dvd_logo-bouncing.png';

const PORT = process.env.PORT || 8787;
const connection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');

/* =========================
   Chat state + helpers
   ========================= */
const LOG_MAX = 300;
let log = []; // [{type:'system'|'user', user?, text, ts}]
const clients = new Map(); // ws -> { user, room, bucket }

function pushLog(evt) {
  log.push(evt);
  if (log.length > LOG_MAX) log = log.slice(-LOG_MAX);
}
function broadcast(obj, room = 'global') {
  const data = JSON.stringify(obj);
  for (const [ws, meta] of clients.entries()) {
    if (meta.room === room && ws.readyState === ws.OPEN) ws.send(data);
  }
}

/* =========================
   Canonical time & physics
   ========================= */
const nowMs = () => Date.now();

// Fixed world so motion is identical everywhere
const WORLD_W = 1920;
const WORLD_H = 1080;

// Logical logo size (scaled client-side by each viewport)
const LOGO_W  = 300;
const LOGO_H  = 180;

// Speed in world units/sec
const SPEED   = 380;

// Fixed server epoch for deterministic replay
const SERVER_T0 = Date.now();

// Compute physics from the active image url (deterministic seed)
function physicsFor(imageUrl, t0 = SERVER_T0) {
  const seed = [...String(imageUrl || DEFAULT_OVERLAY_LOGO)]
    .reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0) >>> 0;
  const ang = (seed % 360) * Math.PI / 180;
  const vx  = Math.cos(ang) * SPEED;
  const vy  = Math.sin(ang) * SPEED;
  const x0  = (WORLD_W - LOGO_W) / 2;
  const y0  = (WORLD_H - LOGO_H) / 2;
  return { worldW: WORLD_W, worldH: WORLD_H, logoW: LOGO_W, logoH: LOGO_H, x0, y0, vx, vy, t0 };
}

/* =========================
   Active logo queue (FIFO)
   ========================= */
let currentLogo = { imageUrl: DEFAULT_OVERLAY_LOGO, expiresAt: 0, setBy: 'system' };
const queue = [];   // [{ imageUrl, setBy, tx }]
let active = null;  // { imageUrl, setBy, tx, startedAt, expiresAt }
let revertTimer = null;

// "Next burn" target (kept as a single server-side schedule)
let nextBurnAt = Date.now() + 12 * 60 * 60 * 1000; // 12h from server start

/* =========================
   Express (HTTP)
   ========================= */
const app = express();
app.use(cors());
app.use(express.json());

// Optional: serve static assets when deployed as a single service
// (harmless if you host the HTML elsewhere; keeps endpoints simple for local dev)
app.use(express.static('.'));

app.get('/health', (req, res) => res.status(200).send('ok'));

// Create-transfer (server builds tx, Phantom signs it)
app.post('/create-transfer', async (req, res) => {
  try {
    const from = new PublicKey(String(req.body?.fromPubkey || ''));
    const lamports = Number(req.body?.lamports || 0);
    if (!lamports || lamports < 10_000) {
      res.set('Access-Control-Allow-Origin', '*');
      return res.status(400).json({ error: 'invalid amount' });
    }

    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: from, recentBlockhash: blockhash }).add(
      SystemProgram.transfer({ fromPubkey: from, toPubkey: RECEIVER_PUBKEY, lamports })
    );

    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    res.set('Access-Control-Allow-Origin', '*');
    res.json({ txBase64: Buffer.from(serialized).toString('base64') });
  } catch (e) {
    console.error('create-transfer error', e);
    res.status(500).json({ error: e?.message || 'server error' });
  }
});

const server = http.createServer(app);

/* =========================
   WebSocket servers
   ========================= */

// 1) Primary chat WS
const wss = new WebSocketServer({ server, path: '/chat' });

// 2) Observer WS — read-only stream for physics/time/burn timer
const wssObserver = new WebSocketServer({ server, path: '/observer' });
const observerClients = new Set(); // ws

function sendObserver(obj) {
  const data = JSON.stringify(obj);
  for (const ws of observerClients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

// Attach chat behavior
wss.on('connection', (ws) => {
  const meta = { user: 'anon', room: 'global', bucket: { t0: Date.now(), n: 0 } };
  clients.set(ws, meta);

  // Greet + log + users
  ws.send(JSON.stringify({ t: 'welcome', log, users: clients.size }));

  // Canonical time & burn schedule
  ws.send(JSON.stringify({ t: 'time', now: nowMs() }));
  if (typeof nextBurnAt === 'number') {
    ws.send(JSON.stringify({ t: 'next_burn', at: new Date(nextBurnAt).toISOString(), now: nowMs() }));
  }

  // Current logo snapshot for this client
  ws.send(JSON.stringify({
    t: 'logo_current',
    imageUrl: currentLogo.imageUrl,
    expiresAt: new Date(currentLogo.expiresAt).toISOString(),
    setBy: currentLogo.setBy,
    phys: physicsFor(currentLogo.imageUrl, active?.startedAt || SERVER_T0),
    now: nowMs()
  }));

  // Tell everyone queue size + user count
  broadcastQueueSize(meta.room);
  broadcast({ t: 'count', n: clients.size }, meta.room);

  ws.on('close', () => {
    clients.delete(ws);
    broadcast({ t: 'count', n: clients.size }, meta.room);
  });

  ws.on('message', async (buf) => {
    let msg = {};
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    if (msg.t === 'hello') {
      meta.user = String(msg.user || 'anon').slice(0, 24);
      meta.room = String(msg.room || 'global');
      return;
    }

    // === PAY-TO-LOGO claim (verify on-chain, then enqueue) ===
    if (msg.t === 'logo_claim') {
      const { tx, imageUrl } = msg;

      // Validate image reference
      const MAX_DATAURL_CHARS = 2_900_000; // ~2MB base64
      function isHttpsImage(urlStr){
        try {
          const u = new URL(urlStr);
          return u.protocol === 'https:' && /\.(png|jpg|jpeg|webp|gif|svg)(\?|#|$)/i.test(u.pathname);
        } catch { return false; }
      }
      function isDataImage(urlStr){
        if (typeof urlStr !== 'string' || urlStr.length > MAX_DATAURL_CHARS) return false;
        if (!urlStr.startsWith('data:image/')) return false;
        return /;base64,/.test(urlStr);
      }
      if (!(isHttpsImage(imageUrl) || isDataImage(imageUrl))) {
        ws.send(JSON.stringify({ t:'error', text:'Invalid image (must be https image URL or data:image/*;base64)' }));
        return;
      }

      try {
        const parsed = await connection.getParsedTransaction(tx, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });
        if (!parsed || parsed.meta?.err) {
          ws.send(JSON.stringify({ t: 'error', text: 'Transaction not confirmed' }));
          return;
        }

        // Look for transfer to RECEIVER_PUBKEY >= MIN_LAMPORTS
        const instr = parsed.transaction.message.instructions || [];
        let toReceiver = false; let paid = 0n;
        for (const ix of instr) {
          const p = ix.parsed;
          if (p && p.type === 'transfer' && p.info && p.info.destination === RECEIVER_PUBKEY.toString()) {
            toReceiver = true;
            paid += BigInt(p.info.lamports || 0);
          }
        }
        if (!toReceiver || paid < BigInt(MIN_LAMPORTS)) {
          ws.send(JSON.stringify({ t: 'error', text: 'Payment of required amount to receiver not found' }));
          return;
        }

        // Enqueue
        const item = { imageUrl, setBy: meta.user || 'user', tx };
        const wasIdle = !active;
        queue.push(item);

        const pos = (active ? 1 : 0) + queue.length;
        ws.send(JSON.stringify({ t: 'logo_queue_pos', pos }));

        broadcast({ t: 'system', text: `${item.setBy} joined the logo queue (#${pos}).`, ts: new Date().toISOString() }, meta.room);
        broadcastQueueSize(meta.room);

        if (wasIdle) startNext(meta.room);
      } catch (err) {
        console.error('logo_claim verify error', err);
        ws.send(JSON.stringify({ t: 'error', text: 'Verification failed' }));
      }
    }

    // Basic chat (optional/minimal here; keep your existing chat handlers as needed)
    if (msg.t === 'chat' && typeof msg.text === 'string') {
      const text = String(msg.text).slice(0, 280);
      pushLog({ type: 'user', user: meta.user, text, ts: new Date().toISOString() });
      broadcast({ t: 'chat', user: meta.user, text, ts: new Date().toISOString() }, meta.room);
    }
  });
});

// Observer connections: read-only stream
wssObserver.on('connection', (ws) => {
  observerClients.add(ws);

  // Canonical time & next burn
  ws.send(JSON.stringify({ t: 'time', now: nowMs() }));
  if (typeof nextBurnAt === 'number') {
    ws.send(JSON.stringify({ t: 'next_burn', at: new Date(nextBurnAt).toISOString(), now: nowMs() }));
  }

  // Current logo snapshot (includes physics + server time)
  ws.send(JSON.stringify({
    t: 'logo_current',
    imageUrl: currentLogo.imageUrl,
    expiresAt: new Date(currentLogo.expiresAt).toISOString(),
    setBy: currentLogo.setBy,
    phys: physicsFor(currentLogo.imageUrl, active?.startedAt || SERVER_T0),
    now: nowMs()
  }));

  ws.on('close', () => observerClients.delete(ws));
  ws.on('error', () => { try { ws.close(); } catch {} observerClients.delete(ws); });
});

// Periodic time heartbeats for skew correction (every 2s)
setInterval(() => {
  sendObserver({ t: 'time', now: nowMs() });
}, 2000);

/* =========================
   Broadcast helpers
   ========================= */
function broadcastQueueSize(room = 'global') {
  const n = (active ? 1 : 0) + queue.length;
  broadcast({ t: 'logo_queue_size', n }, room);
  // FYI: observer clients don't need queue length for physics sync
}

function broadcastLogo(room = 'global') {
  const payload = {
    t: 'logo_current',
    imageUrl: currentLogo.imageUrl,
    expiresAt: new Date(currentLogo.expiresAt).toISOString(),
    setBy: currentLogo.setBy,
    phys: physicsFor(currentLogo.imageUrl, active?.startedAt || SERVER_T0),
    now: nowMs()
  };
  broadcast(payload, room);  // chat clients
  sendObserver(payload);     // observer clients (read-only)
}

function startNext(room = 'global') {
  clearTimeout(revertTimer);

  if (!queue.length) {
    active = null;
    currentLogo = { imageUrl: DEFAULT_OVERLAY_LOGO, expiresAt: 0, setBy: 'system' };
    broadcastLogo(room);
    broadcastQueueSize(room);
    return;
  }

  const item = queue.shift();
  const startedAt = Date.now();
  active = {
    imageUrl: item.imageUrl,
    setBy: item.setBy,
    tx: item.tx,
    startedAt,
    expiresAt: startedAt + CLAIM_DURATION_MS,
  };

  currentLogo = {
    imageUrl: item.imageUrl,
    expiresAt: active.expiresAt,
    setBy: item.setBy,
  };

  broadcastLogo(room);
  broadcastQueueSize(room);
  revertTimer = setTimeout(() => startNext(room), CLAIM_DURATION_MS);
}

/* =========================
   Start server
   ========================= */
server.listen(PORT, () => {
  console.log(`[dvd-chat-server] listening on :${PORT}`);
  console.log(`[dvd-chat-server] chat WS:      ws://localhost:${PORT}/chat`);
  console.log(`[dvd-chat-server] observer WS:  ws://localhost:${PORT}/observer`);
});


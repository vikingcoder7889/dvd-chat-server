/* server.js (ESM) */
import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';
import { Connection, PublicKey, SystemProgram, Transaction, clusterApiUrl } from '@solana/web3.js';

// --- Config (env + pricing/duration) ---
const RECEIVER_PUBKEY = new PublicKey(process.env.RECEIVER_PUBKEY); // set in env (Render or local)
const CLAIM_DURATION_MS = 15 * 60 * 1000;           // 15 minutes active duration
const MIN_LAMPORTS     = Math.floor(0.01 * 1e9);    // 0.01 SOL
const DEFAULT_OVERLAY_LOGO = '/dvd_logo-bouncing.png';

const connection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');

// --- Chat history, clients, broadcast helpers ---
const LOG_MAX = 300;
let log = [];                              // [{type:'system'|'user', user?, text, ts}]
const clients = new Map();                 // ws -> { user, room, bucket }

function pushLog(evt) {
  log.push(evt);
  if (log.length > LOG_MAX) log = log.slice(-LOG_MAX);
}

const _origBroadcast = function broadcast(obj, room = 'global') {
  const data = JSON.stringify(obj);
  for (const [ws, meta] of clients.entries()) {
    if (meta.room === room && ws.readyState === ws.OPEN) ws.send(data);
  }
}


function broadcast(obj, room = 'global') {
  _origBroadcast(obj, room);
  if (obj && (obj.t === 'logo_current' || obj.t === 'next_burn' || obj.t === 'time' || obj.t === 'logo_queue_size' || obj.t === 'burn' || obj.t === 'proof')) {
    broadcastToObservers(obj);
  }
}

// --- canonical time & physics (global) ---
const nowMs = () => Date.now();

// Fixed logical “world” so motion is identical for everyone
const WORLD_W = 1920;
const WORLD_H = 1080;

// Logical logo size (scaled client-side if needed)
const LOGO_W  = 300;
const LOGO_H  = 180;

// Speed in world units/sec
const SPEED   = 380;

// Add this one line near the world constants:
const SERVER_T0 = Date.now();

// --- Logo queue (FIFO) state ---
let currentLogo = { imageUrl: DEFAULT_OVERLAY_LOGO, expiresAt: 0, setBy: 'system' };
const queue = [];   // [{ imageUrl, setBy, tx }]
let active = null;  // { imageUrl, setBy, tx, startedAt, expiresAt }
let revertTimer = null;

// Optional: persistent “next burn” target (adjust as you like)
let nextBurnAt = Date.now() + 12 * 60 * 60 * 1000; // 12h from server start

// Build physics (deterministic) from the current image url
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

// Broadcast current logo to everyone in a room
function broadcastLogo(room = 'global') {
  broadcast({
    t: 'logo_current',
    imageUrl: currentLogo.imageUrl,
    expiresAt: new Date(currentLogo.expiresAt).toISOString(),
    setBy: currentLogo.setBy,
    phys: physicsFor(currentLogo.imageUrl, active?.startedAt || SERVER_T0),
    now: nowMs()
  }, room);
}

function broadcastQueueSize(room = 'global') {
  const n = (active ? 1 : 0) + queue.length;
  broadcast({ t: 'logo_queue_size', n }, room);
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

// --- HTTP (Express) ---
const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.status(200).send('ok'));

// Create-transfer (server builds tx, Phantom signs it)
app.post('/create-transfer', async (req, res) => {
  try {
    const from = new PublicKey(String(req.body?.fromPubkey || ''));
    const lamports = Number(req.body?.lamports || 0);
    if (!lamports || lamports < 10_000) return res.status(400).json({ error: 'invalid amount' });

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


// --- Simple server-side corner detection (simulated burn hook) ---
function worldPosAt(tMs, phys) {
  const tSec = Math.max(0, (tMs - phys.t0) / 1000);
  function bounce1D(start, v, tSec, min, max) {
    const span = max - min; if (span <= 0) return min;
    const dist = (start - min) + v * tSec;
    const period = 2 * span;
    let m = dist % period; if (m < 0) m += period;
    const pos = m <= span ? m : (period - m);
    return pos + min;
  }
  const x = bounce1D(phys.x0, phys.vx, tSec, 0, phys.worldW - phys.logoW);
  const y = bounce1D(phys.y0, phys.vy, tSec, 0, phys.worldH - phys.logoH);
  return { x, y };
}

let burnsToday = 0;
let lastBurnAt = 0;
let lastDay = new Date().toDateString();

function maybeDailyReset() {
  const today = new Date().toDateString();
  if (today !== lastDay) { lastDay = today; burnsToday = 0; }
}

setInterval(async () => {
  try {
    maybeDailyReset();
    if (burnsToday >= 2) return;

    const phys = physicsFor(currentLogo.imageUrl, active?.startedAt || SERVER_T0);
    const now = nowMs();
    const { x, y } = worldPosAt(now, phys);
    const eps = 3; // proximity to a corner in world units
    const atLeft = x <= eps;
    const atRight = x >= (phys.worldW - phys.logoW - eps);
    const atTop = y <= eps;
    const atBottom = y >= (phys.worldH - phys.logoH - eps);
    const inCorner = (atLeft || atRight) && (atTop || atBottom);

    if (inCorner && (now - lastBurnAt) > 30_000) { // debounce 30s
      // Simulate a burn hook: emit a 'burn' event and schedule nextBurnAt in 12h
      burnsToday += 1;
      lastBurnAt = now;
      nextBurnAt = now + 12 * 60 * 60 * 1000;
      const proof = { sig: 'pending-oracle', slot: await connection.getSlot() };
      broadcast({ t: 'burn', when: new Date(now).toISOString(), pct: 0.5, reason: 'corner', imageUrl: currentLogo.imageUrl });
      broadcast({ t: 'next_burn', at: new Date(nextBurnAt).toISOString(), now: nowMs() });
      broadcast({ t: 'proof', tx: proof.sig, slot: proof.slot });
    }
  } catch {}
}, 1000);
const server = http.createServer(app);


// Helpers to talk to observer clients
function broadcastToObservers(obj) {
  const data = JSON.stringify(obj);
  if (typeof observerClients !== 'undefined') {
    for (const ws of observerClients) {
      if (ws.readyState === ws.OPEN) { try { ws.send(data); } catch {} }
    }
  }
}
// --- WebSocket server ---
const wss = new WebSocketServer({ server, path: '/chat' });
const wssObs = new WebSocketServer({ server, path: '/observer' });
// Track observer clients (sync-only)
const observerClients = new Set();


wss.on('connection', (ws) => {
  const meta = { user: 'anon', room: 'global', bucket: { t0: Date.now(), n: 0 } };
  clients.set(ws, meta);

  // Greet + log + users
  ws.send(JSON.stringify({ t: 'welcome', log, users: clients.size }));

  // Send canonical time and next burn to this client
  ws.send(JSON.stringify({ t: 'time', now: nowMs() }));
  if (typeof nextBurnAt === 'number') {
    ws.send(JSON.stringify({ t: 'next_burn', at: new Date(nextBurnAt).toISOString(), now: nowMs() }));
  }

  // Send current logo state ONLY to this client (includes physics + now)
  (function sendCurrentLogoToOne() {
    const payload = {
      t: 'logo_current',
      imageUrl: currentLogo.imageUrl,
      expiresAt: new Date(currentLogo.expiresAt).toISOString(),
      setBy: currentLogo.setBy,
      phys: physicsFor(currentLogo.imageUrl, active?.startedAt || SERVER_T0),
      now: nowMs()
    };
    ws.send(JSON.stringify(payload));
  })();

  // Tell everyone queue size + user count
  broadcastQueueSize(meta.room);
  broadcast({ t: 'count', n: clients.size }, meta.room);

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
        try { const u = new URL(urlStr);
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
        ws.send(JSON.stringify({ t: 'error', text: 'Verification error' }));
      }
      return;
    }

    // === Rate limit ONLY for chat messages ===
    const b = meta.bucket; const t = Date.now();
    if (t - b.t0 > 10_000) { b.t0 = t; b.n = 0; }
    if (++b.n > 10) { ws.send(JSON.stringify({ t: 'error', text: 'Rate limit exceeded' })); return; }

    if (msg.t === 'chat') {
      const text = String(msg.text || '').slice(0, 500)
        .replace(/fuck|cunt|nigg|kike|spic|retard/gi, '****');
      const evt = { type: 'user', user: meta.user, text, ts: msg.ts || new Date().toISOString() };
      pushLog(evt);
      broadcast({ t: 'chat', user: evt.user, text: evt.text, ts: evt.ts }, meta.room);
      return;
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    broadcast({ t: 'count', n: clients.size }, 'global');
  });
});

const PORT = process.env.PORT || 8787;
server.listen(PORT, () => console.log('chat ws listening on :' + PORT));


wssObs.on('connection', (ws) => {
  try {
    observerClients.add(ws);
    // Send canonical time, next burn, and current logo
    ws.send(JSON.stringify({ t: 'time', now: nowMs() }));
    if (typeof nextBurnAt === 'number') {
      ws.send(JSON.stringify({ t: 'next_burn', at: new Date(nextBurnAt).toISOString(), now: nowMs() }));
    }
    ws.send(JSON.stringify({
      t: 'logo_current',
      imageUrl: currentLogo.imageUrl,
      expiresAt: new Date(currentLogo.expiresAt).toISOString(),
      setBy: currentLogo.setBy,
      phys: physicsFor(currentLogo.imageUrl, active?.startedAt || SERVER_T0),
      now: nowMs()
    }));
    ws.on('close', () => { observerClients.delete(ws); });
    ws.on('error', () => { observerClients.delete(ws); });
  } catch { try { ws.close(); } catch {} }
});

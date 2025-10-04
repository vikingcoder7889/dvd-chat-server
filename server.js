/* server.js (ESM) — Full, synced + observer + chat + queue
   - Express HTTP + WebSocket (/chat, /observer)
   - Deterministic server physics for bouncing logo (single global state)
   - Periodic sync ticks so clients always converge (even after refresh)
   - Next-burn timer broadcast
   - Minimal chat (hello, chat, system, counts)
   - Optional payment flow scaffolding (create-transfer) via @solana/web3.js

   Notes:
   - Set env RECEIVER_PUBKEY (base58) if you use /create-transfer.
   - Deploy behind Render or any Node host. PORT defaults to 8787.
*/
import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';

// Optional Solana support (guard import so app runs even if pkg not installed)
let Connection, PublicKey, SystemProgram, Transaction, clusterApiUrl;
try {
  ({ Connection, PublicKey, SystemProgram, Transaction, clusterApiUrl } = await import('@solana/web3.js'));
} catch { /* optional */ }

// ---------------------- Config ----------------------
const PORT = process.env.PORT || 8787;
const RECEIVER_PUBKEY = process.env.RECEIVER_PUBKEY || '11111111111111111111111111111111'; // placeholder
const CLAIM_DURATION_MS = 15 * 60 * 1000; // 15 minutes slot per custom logo upload
const DEFAULT_OVERLAY_LOGO = '/dvd_logo-bouncing.png';

// Physics world (logical units)
const WORLD_W = 1920;
const WORLD_H = 1080;
const LOGO_W  = 300;
const LOGO_H  = 180;
const SPEED   = 380; // world units/sec

// Global epoch anchor for deterministic motion
const SERVER_T0 = Date.now();
const nowMs = () => Date.now();

// -------------------- HTTP (Express) -----------------
const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.status(200).send('ok'));

// Optional: prebuild Solana transfer tx (client signs with Phantom)
app.post('/create-transfer', async (req, res) => {
  try {
    if (!Connection) return res.status(501).json({ error: 'solana disabled' });
    const { fromPubkey, lamports } = req.body || {};
    if (!fromPubkey || !lamports) return res.status(400).json({ error: 'missing params' });

    const conn = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');
    const from = new PublicKey(String(fromPubkey));
    const to = new PublicKey(RECEIVER_PUBKEY);
    const { blockhash } = await conn.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: from, recentBlockhash: blockhash }).add(
      SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: Number(lamports) })
    );
    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    res.json({ txBase64: Buffer.from(serialized).toString('base64') });
  } catch (e) {
    console.error('create-transfer error', e);
    res.status(500).json({ error: e?.message || 'server error' });
  }
});

// ---------------- WebSocket (chat & observer) ----------------
const server = http.createServer(app);
const wssChat = new WebSocketServer({ server, path: '/chat' });
const wssObs  = new WebSocketServer({ server, path: '/observer' });

// Track chat clients and observer clients
const chatClients = new Map(); // ws -> { user, room, bucket }
const observerClients = new Set();

// ----------------- Canonical global state --------------------
let nextBurnAt = nowMs() + 12 * 60 * 60 * 1000; // 12h from boot
let burnedPctTotal = 0;
let corners = 0;

// Current active logo & queue
let active = null; // { imageUrl, setBy, startedAt, expiresAt }
let revertTimer = null;
const queue = []; // [{ imageUrl, setBy, tx }]

function physicsFor(imageUrl, t0 = SERVER_T0) {
  // Seed direction using image URL for determinism
  const seed = [...String(imageUrl || DEFAULT_OVERLAY_LOGO)].reduce((a, c) => ((a<<5) - a + c.charCodeAt(0))|0, 0) >>> 0;
  const ang = (seed % 360) * Math.PI / 180;
  const vx  = Math.cos(ang) * SPEED;
  const vy  = Math.sin(ang) * SPEED;
  const x0  = (WORLD_W - LOGO_W) / 2;
  const y0  = (WORLD_H - LOGO_H) / 2;
  return { worldW: WORLD_W, worldH: WORLD_H, logoW: LOGO_W, logoH: LOGO_H, x0, y0, vx, vy, t0 };
}

// Default logo
let currentLogo = { imageUrl: DEFAULT_OVERLAY_LOGO, setBy: 'system', expiresAt: 0 };

function broadcastAll(payload) {
  const data = JSON.stringify(payload);
  // chat clients
  for (const [ws, meta] of chatClients.entries()) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
  // observers
  for (const ws of observerClients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

function sendState(ws) {
  // Send canonical time, burn timer & current logo physics
  const base = { now: nowMs() };
  try { ws.send(JSON.stringify({ t: 'time', ...base })); } catch {}
  try { ws.send(JSON.stringify({ t: 'next_burn', at: new Date(nextBurnAt).toISOString(), ...base })); } catch {}
  try {
    ws.send(JSON.stringify({
      t: 'logo_current',
      imageUrl: currentLogo.imageUrl,
      expiresAt: new Date(currentLogo.expiresAt || 0).toISOString(),
      setBy: currentLogo.setBy,
      phys: physicsFor(currentLogo.imageUrl, active?.startedAt || SERVER_T0),
      ...base
    }));
  } catch {}
}

function broadcastLogo() {
  broadcastAll({
    t: 'logo_current',
    imageUrl: currentLogo.imageUrl,
    expiresAt: new Date(currentLogo.expiresAt || 0).toISOString(),
    setBy: currentLogo.setBy,
    phys: physicsFor(currentLogo.imageUrl, active?.startedAt || SERVER_T0),
    now: nowMs()
  });
}
function broadcastTime() {
  broadcastAll({ t: 'time', now: nowMs() });
}
function broadcastNextBurn() {
  broadcastAll({ t: 'next_burn', at: new Date(nextBurnAt).toISOString(), now: nowMs() });
}

function startNext() {
  clearTimeout(revertTimer);
  if (!queue.length) {
    active = null;
    currentLogo = { imageUrl: DEFAULT_OVERLAY_LOGO, setBy: 'system', expiresAt: 0 };
    broadcastLogo();
    return;
  }
  const item = queue.shift();
  const startedAt = nowMs();
  active = { imageUrl: item.imageUrl, setBy: item.setBy, tx: item.tx, startedAt, expiresAt: startedAt + CLAIM_DURATION_MS };
  currentLogo = { imageUrl: item.imageUrl, setBy: item.setBy, expiresAt: active.expiresAt };
  broadcastLogo();
  revertTimer = setTimeout(startNext, CLAIM_DURATION_MS);
}

// -------------------- Chat WS handlers -----------------------
wssChat.on('connection', (ws) => {
  const meta = { user: 'anon', room: 'global', bucket: { t0: Date.now(), n: 0 } };
  chatClients.set(ws, meta);

  // Welcome + state
  try { ws.send(JSON.stringify({ t: 'welcome', users: chatClients.size, log: [] })); } catch {}
  sendState(ws);

  // Count broadcast
  broadcastAll({ t: 'count', n: chatClients.size });

  ws.on('message', async (buf) => {
    let msg = {};
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    if (msg.t === 'hello') {
      meta.user = (String(msg.user || 'anon')).slice(0, 24);
      meta.room = String(msg.room || 'global');
      return;
    }

    // Very light rate limit
    const b = meta.bucket; const t = Date.now();
    if (t - b.t0 > 10_000) { b.t0 = t; b.n = 0; }
    if (++b.n > 15) { try { ws.send(JSON.stringify({ t: 'error', text: 'rate limit' })); } catch {} return; }

    if (msg.t === 'chat') {
      const text = String(msg.text || '').slice(0, 240);
      const cleaned = text.replace(/https?:\/\/\S+/gi, '[link]').replace(/\s+/g, ' ').trim();
      broadcastAll({ t: 'chat', user: meta.user, text: cleaned, ts: new Date().toISOString() });
      return;
    }

    if (msg.t === 'logo_claim') {
      // Accept an imageUrl and enqueue for CLAIM_DURATION_MS; verification can be added here
      const imageUrl = String(msg.imageUrl || '').trim();
      if (!imageUrl) { try { ws.send(JSON.stringify({ t: 'error', text: 'invalid image url' })); } catch {} return; }
      const wasIdle = !active;
      queue.push({ imageUrl, setBy: meta.user || 'user', tx: msg.tx || null });
      try { ws.send(JSON.stringify({ t: 'logo_queue_pos', pos: (active ? 1 : 0) + queue.length })); } catch {}
      if (wasIdle) startNext();
      return;
    }
  });

  ws.on('close', () => {
    chatClients.delete(ws);
    broadcastAll({ t: 'count', n: chatClients.size });
  });
});

// ---------------- Observer WS (read-only clients) -------------
wssObs.on('connection', (ws) => {
  observerClients.add(ws);
  sendState(ws);
  ws.on('close', () => observerClients.delete(ws));
  ws.on('error', () => observerClients.delete(ws));
});

// ---------------- Periodic sync ticks -------------------------
// Ensure every client (new or refreshing) converges to the same motion.
setInterval(() => { broadcastTime(); broadcastLogo(); }, 2000);

// ---------------- Optional: corner detection & burn tick ------
// This is a simple debounced example. Tie into your program/oracle as needed.
let lastCornerAt = 0;
setInterval(() => {
  const phys = physicsFor(currentLogo.imageUrl, active?.startedAt || SERVER_T0);
  const tSec = (nowMs() - phys.t0) / 1000;
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
  const eps = 2; // corner proximity
  const atLeft = x <= eps, atRight = x >= (phys.worldW - phys.logoW - eps);
  const atTop = y <= eps, atBottom = y >= (phys.worldH - phys.logoH - eps);
  const inCorner = (atLeft || atRight) && (atTop || atBottom);
  const now = nowMs();
  if (inCorner && (now - lastCornerAt) > 30000) { // debounce 30s
    lastCornerAt = now;
    corners += 1;
    burnedPctTotal += 0.5; // demo: +0.5% per corner
    nextBurnAt = now + 12 * 60 * 60 * 1000;
    broadcastAll({ t: 'burn', when: new Date(now).toISOString(), pct: 0.5, corners, burnedPctTotal });
    broadcastNextBurn();
  }
}, 1000);

// ---------------- Boot ----------------------------------------
server.listen(PORT, () => {
  console.log('server listening on :' + PORT);
});

/* server.js (ESM) */
import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';
import { Connection, PublicKey, SystemProgram, Transaction, clusterApiUrl } from '@solana/web3.js';

// --- Config (env + pricing/duration) ---
const RECEIVER_PUBKEY = new PublicKey(process.env.RECEIVER_PUBKEY); // set in Render
const CLAIM_DURATION_MS = 15 * 60 * 1000;           // 15 minutes
const MIN_LAMPORTS     = Math.floor(0.01 * 1e9);    // 0.01 SOL
const DEFAULT_OVERLAY_LOGO = '/dvd_logo-bouncing.png';
const connection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');
// --- Chat history, clients, broadcast helpers ---
const LOG_MAX = 300;          // keep the most recent ~300 lines
let log = [];                 // [{type:'system'|'user', user?, text, ts}]
const clients = new Map();    // ws -> { user, room, bucket }

function pushLog(evt) {
  log.push(evt);
  if (log.length > LOG_MAX) log = log.slice(-LOG_MAX);
}

function broadcast(obj, room = 'global') {
  const data = JSON.stringify(obj);
  for (const [ws, meta] of clients.entries()) {
    if (meta.room === room && ws.readyState === ws.OPEN) {
      ws.send(data);
    }
  }
}

// --- canonical time & physics (global) ---
const nowMs = () => Date.now();

// Choose a fixed "world" so motion is identical for everyone, regardless of canvas size
const WORLD_W = 1920;
const WORLD_H = 1080;

// Logical logo size inside the world (scale on the client)
const LOGO_W  = 300;
const LOGO_H  = 180;

// Initial speed in world units per second (tweak to taste)
const SPEED   = 380;



// One-client helper (used on connect)
function sendCurrentLogo(ws) {
  try {
    // derive deterministic physics for the current logo
    const startAt = nowMs();
    const img = currentLogo.imageUrl || DEFAULT_OVERLAY_LOGO;
    const seed = [...String(img)].reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0) >>> 0;
    const ang  = (seed % 360) * Math.PI / 180;
    const vx   = Math.cos(ang) * SPEED;
    const vy   = Math.sin(ang) * SPEED;

    const x0 = (WORLD_W - LOGO_W) / 2;
    const y0 = (WORLD_H - LOGO_H) / 2;

    ws.send(JSON.stringify({
      t: 'logo_current',
      imageUrl: currentLogo.imageUrl,
      expiresAt: new Date(currentLogo.expiresAt).toISOString(),
      setBy: currentLogo.setBy,
      phys: { worldW: WORLD_W, worldH: WORLD_H, logoW: LOGO_W, logoH: LOGO_H, x0, y0, vx, vy, t0: startAt },
      now: nowMs()
    }));
  } catch {}
}



// (Optional) If you also want to show the queue length in the UI
function broadcastQueueSize(room = 'global') {
  const n = (active ? 1 : 0) + queue.length;
  broadcast({ t: 'logo_queue_size', n }, room);
}


// --- Simple moderation ---
const BAD_WORDS = [/fuck/i, /cunt/i, /nigg/i, /kike/i, /spic/i, /retard/i];
function clean(text) {
  let t = String(text || '').slice(0, 500);
  for (const re of BAD_WORDS) t = t.replace(re, '****');
  return t;
}

// --- Logo queue (FIFO) state ---
let currentLogo = { imageUrl: DEFAULT_OVERLAY_LOGO, expiresAt: 0, setBy: 'system' };
const queue = [];  // [{ imageUrl, setBy, tx }]
let active = null; // { imageUrl, setBy, tx, startedAt, expiresAt }
let revertTimer = null;

  const startAt = nowMs();

  // deterministic direction derived from imageUrl (simple hash)
  const seed = [...String(currentLogo.imageUrl || DEFAULT_OVERLAY_LOGO)]
    .reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0) >>> 0;
  const ang = (seed % 360) * Math.PI / 180;
  const vx  = Math.cos(ang) * SPEED;
  const vy  = Math.sin(ang) * SPEED;

  // start centered in the world
  const x0 = (WORLD_W - LOGO_W) / 2;
  const y0 = (WORLD_H - LOGO_H) / 2;

  broadcast({
    t: 'logo_current',
    imageUrl: currentLogo.imageUrl,
    expiresAt: new Date(currentLogo.expiresAt).toISOString(),
    setBy: currentLogo.setBy,

    // NEW: canonical physics the clients will follow
    phys: {
      worldW: WORLD_W,
      worldH: WORLD_H,
      logoW:  LOGO_W,
      logoH:  LOGO_H,
      x0, y0,
      vx, vy,
      t0: startAt
    },

    // also include server “now” for time sync
    now: nowMs()
  }, room);


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
  const now = Date.now();
  active = {
    ...item,
    startedAt: now,
    expiresAt: now + CLAIM_DURATION_MS,
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

// --- HTTP (Express app + health) ---
const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.status(200).send('ok'));

// Attach app to HTTP server
const server = http.createServer(app);

// --- WebSocket server ---
const wss = new WebSocketServer({ server, path: '/chat' });

wss.on('connection', (ws) => {
  const meta = { user: 'anon', room: 'global', bucket: { t0: Date.now(), n: 0 } };
  clients.set(ws, meta);

  ws.send(JSON.stringify({ t: 'welcome', log, users: clients.size }));
  sendCurrentLogo(ws);        // send the current logo state ONLY to the new client
  broadcastQueueSize(meta.room);   // NEW: send queue size
  broadcast({ t: 'count', n: clients.size });

  ws.send(JSON.stringify({ t: 'logo_queue_size', n: (active ? 1 : 0) + queue.length }));

  // send canonical server time for client clock-sync
ws.send(JSON.stringify({ t: 'time', now: nowMs() }));

// (optional) also send next burn if you maintain one; we’ll define it below
if (typeof nextBurnAt === 'number') {
  ws.send(JSON.stringify({ t: 'next_burn', at: new Date(nextBurnAt).toISOString(), now: nowMs() }));
}

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

      // Validate image reference: either https://...image.(png|jpg|jpeg|webp|gif|svg) OR data:image/*;base64,...
const MAX_DATAURL_CHARS = 2_900_000; // ~2MB base64 payload limit

function isHttpsImage(urlStr){
  try {
    const u = new URL(urlStr);
    return u.protocol === 'https:' && /\.(png|jpg|jpeg|webp|gif|svg)(\?|#|$)/i.test(u.pathname);
  } catch { return false; }
}

function isDataImage(urlStr){
  // basic shape: data:image/png;base64,AAAA...
  if (typeof urlStr !== 'string' || urlStr.length > MAX_DATAURL_CHARS) return false;
  if (!urlStr.startsWith('data:image/')) return false;
  // must be base64 for safety/compat
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
        let toReceiver = false;
        let paid = 0n;
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

        // Enqueue item
        const item = { imageUrl, setBy: meta.user || 'user', tx };
        const wasIdle = !active;
        queue.push(item);

        // Position for this payer
        const pos = (active ? 1 : 0) + queue.length;
        ws.send(JSON.stringify({ t: 'logo_queue_pos', pos }));

        // Announce + queue size
        broadcast({ t: 'system', text: `${item.setBy} joined the logo queue (#${pos}).`, ts: new Date().toISOString() }, meta.room);
        broadcastQueueSize(meta.room);

        // Start immediately if nothing active
        if (wasIdle) startNext(meta.room);

      } catch (err) {
        console.error('logo_claim verify error', err);
        ws.send(JSON.stringify({ t: 'error', text: 'Verification error' }));
      }
      return;
    }

    // === Rate limit ONLY for chat messages ===
    const b = meta.bucket; const now = Date.now();
    if (now - b.t0 > 10_000) { b.t0 = now; b.n = 0; }
    if (++b.n > 10) { ws.send(JSON.stringify({ t: 'error', text: 'Rate limit exceeded' })); return; }

    if (msg.t === 'chat') {
      const text = clean(msg.text);
      const evt = { type: 'user', user: meta.user, text, ts: msg.ts || new Date().toISOString() };
      pushLog(evt);
      broadcast({ t: 'chat', user: evt.user, text: evt.text, ts: evt.ts }, meta.room);
      return;
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    broadcast({ t: 'count', n: clients.size });
  });
});

const PORT = process.env.PORT || 8787;
server.listen(PORT, () => console.log('chat ws listening on :' + PORT));


// --- Create transfer transaction (server-side) ---
app.post('/create-transfer', async (req, res) => {
  try {
    const from = new PublicKey(String(req.body?.fromPubkey || ''));
    const lamports = Number(req.body?.lamports || 0);
    if (!lamports || lamports < 10_000) {
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

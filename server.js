/* server.js (ESM) */
import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';
import { Connection, PublicKey, SystemProgram, Transaction, clusterApiUrl } from '@solana/web3.js';

// --- Config (env + pricing/duration) ---
const RECEIVER_PUBKEY = new PublicKey(process.env.RECEIVER_PUBKEY || "Bbe9EKuc2Yg72wzSGA2f2L62sK1rG1i1j9xL7t3w2WXt"); // Fallback for local dev
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

function broadcast(obj, room = 'global') {
  const data = JSON.stringify(obj);
  for (const [ws, meta] of clients.entries()) {
    if (meta.room === room && ws.readyState === ws.OPEN) ws.send(data);
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

// This is the canonical t=0 for the default logo's physics.
const SERVER_T0 = nowMs();

// --- Logo queue (FIFO) state ---
let currentLogo = { imageUrl: DEFAULT_OVERLAY_LOGO, expiresAt: 0, setBy: 'system' };
const queue = [];   // [{ imageUrl, setBy, tx }]
let active = null;  // { imageUrl, setBy, tx, startedAt, expiresAt }
let revertTimer = null;

// The server now manages the single, synchronized "next burn" time.
let nextBurnAt = nowMs() + 12 * 60 * 60 * 1000; // 12h from server start

// Build deterministic physics from the image url and a start time.
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

// Broadcast current logo and its physics state to everyone in a room.
function broadcastLogo(room = 'global') {
  broadcast({
    t: 'logo_current',
    imageUrl: currentLogo.imageUrl,
    expiresAt: new Date(currentLogo.expiresAt).toISOString(),
    setBy: currentLogo.setBy,
    // The `phys` object is the single source of truth for animation.
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
  const startedAt = nowMs();
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

const server = http.createServer(app);

// --- WebSocket server ---
const wss = new WebSocketServer({ server, path: '/chat' });

wss.on('connection', (ws) => {
  const meta = { user: 'anon', room: 'global', bucket: { t0: nowMs(), n: 0 } };
  clients.set(ws, meta);

  // Greet + log + users
  ws.send(JSON.stringify({ t: 'welcome', log, users: clients.size }));

  // Send canonical server time so client can calculate skew.
  ws.send(JSON.stringify({ t: 'time', now: nowMs() }));
  
  // Send the synchronized burn time.
  ws.send(JSON.stringify({ t: 'next_burn', at: new Date(nextBurnAt).toISOString() }));

  // Send current logo state ONLY to this new client.
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

  ws.on('message', async (buf) => {
    let msg = {};
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    if (msg.t === 'hello') {
      meta.user = String(msg.user || 'anon').slice(0, 24);
      meta.room = String(msg.room || 'global');
      // A non-chat user is just an observer, connect them without joining chat.
      // They will now receive sync messages.
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

        const item = { imageUrl, setBy: meta.user || 'user', tx };
        const wasIdle = !active && queue.length === 0;
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
    const b = meta.bucket; const t = nowMs();
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

// A separate, simple WebSocket server for observers.
const observerWss = new WebSocketServer({ noServer: true });
observerWss.on('connection', (ws) => {
    // Send initial state immediately.
    ws.send(JSON.stringify({ t: 'time', now: nowMs() }));
    ws.send(JSON.stringify({ t: 'next_burn', at: new Date(nextBurnAt).toISOString() }));
    ws.send(JSON.stringify({
        t: 'logo_current',
        imageUrl: currentLogo.imageUrl,
        phys: physicsFor(currentLogo.imageUrl, active?.startedAt || SERVER_T0),
        now: nowMs()
    }));
    
    // Add to a special 'observers' list to receive broadcasts
    const meta = { room: 'global', isObserver: true };
    clients.set(ws, meta);

    ws.on('close', () => {
        clients.delete(ws);
    });
});


server.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url, `http://${request.headers.host}`);
    if (pathname === '/chat') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    } else if (pathname === '/observer') {
        observerWss.handleUpgrade(request, socket, head, (ws) => {
            observerWss.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
    }
});


const PORT = process.env.PORT || 8787;
server.listen(PORT, () => console.log('HTTP and WebSocket server listening on :' + PORT));

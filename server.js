const cors = require('cors');
// server.js
import http from 'http';
import { WebSocketServer } from 'ws';
import { Connection, PublicKey, clusterApiUrl } from '@solana/web3.js';

// --- Config (env + pricing/duration) ---
const RECEIVER_PUBKEY = new PublicKey(process.env.RECEIVER_PUBKEY); // set in Render
const CLAIM_DURATION_MS = 15 * 60 * 1000;           // 15 minutes
const MIN_LAMPORTS     = Math.floor(0.01 * 1e9);    // 0.01 SOL
const DEFAULT_OVERLAY_LOGO = '/dvd_logo-bouncing.png';

const connection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');

// --- Chat history, clients, broadcast helpers ---
const LOG_MAX = 300;
let log = []; // [{type:'system'|'user', user?, text, ts}]
const clients = new Map(); // ws -> {user, room, bucket}

function broadcast(obj, room = 'global') {
  const data = JSON.stringify(obj);
  for (const [ws, meta] of clients.entries()) {
    if (meta.room === room && ws.readyState === ws.OPEN) ws.send(data);
  }
}

function pushLog(evt) {
  log.push(evt);
  if (log.length > LOG_MAX) log = log.slice(-LOG_MAX);
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

function broadcastLogo(room = 'global') {
  broadcast({
    t: 'logo_current',
    imageUrl: currentLogo.imageUrl,
    expiresAt: new Date(currentLogo.expiresAt).toISOString(),
    setBy: currentLogo.setBy,
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

// --- HTTP (health) ---
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(404); res.end();
});

// --- WebSocket server ---
const wss = new WebSocketServer({ server, path: '/chat' });

wss.on('connection', (ws) => {
  const meta = { user: 'anon', room: 'global', bucket: { t0: Date.now(), n: 0 } };
  clients.set(ws, meta);

  ws.send(JSON.stringify({ t: 'welcome', log, users: clients.size }));
  broadcastLogo(meta.room);        // NEW: send current logo state
  broadcastQueueSize(meta.room);   // NEW: send queue size
  broadcast({ t: 'count', n: clients.size });

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
const MAX_DATAURL_CHARS = 800_000; // ~600KB base64 payload limit

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
app.post('/create-transfer', express.json(), async (req, res) => {
  try {
    const { Connection, PublicKey, SystemProgram, Transaction, clusterApiUrl } = require('@solana/web3.js');
    const from = new PublicKey(String(req.body?.fromPubkey||''));
    const lamports = Number(req.body?.lamports || 0);
    if (!lamports || lamports < 1e4) return res.status(400).json({ error: 'invalid amount' });

    const RECEIVER_PUBKEY = new PublicKey(process.env.RECEIVER_PUBKEY || 'GF34Uc25emR9LgWvPK4nGd1nRnBsa5vvNHyAo8NxiZGE');

    const connection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');
    const { blockhash } = await connection.getLatestBlockhash('confirmed');

    const tx = new Transaction({ feePayer: from, recentBlockhash: blockhash }).add(
      SystemProgram.transfer({ fromPubkey: from, toPubkey: RECEIVER_PUBKEY, lamports })
    );

    const txSer = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    res.set('Access-Control-Allow-Origin', '*');
    res.json({ txBase64: txSer.toString('base64') });
  } catch (e) {
    console.error('create-transfer error', e);
    res.status(500).json({ error: e?.message || 'server error' });
  }
});


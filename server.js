/* server.js (ESM) */

// =================================================================
// 1. IMPORTS
// =================================================================
import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';
import { Connection, PublicKey, SystemProgram, Transaction, clusterApiUrl } from '@solana/web3.js';

// =================================================================
// 2. CONFIGURATION & CONSTANTS
// =================================================================
const RECEIVER_PUBKEY = new PublicKey(process.env.RECEIVER_PUBKEY); // Set in .env
const CLAIM_DURATION_MS = 15 * 60 * 1000;         // 15 minutes active duration
const MIN_LAMPORTS = Math.floor(0.01 * 1e9);      // 0.01 SOL
const DEFAULT_OVERLAY_LOGO = '/dvd_logo-bouncing.png';
const LOG_MAX = 300;
const SERVER_T0 = Date.now(); // Canonical server start time

const connection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');

// The public key of the wallet you want to display transactions for.
// THIS MUST BE THE SAME WALLET THAT RECEIVES THE PAYMENTS.
const DEV_WALLET_PUBLIC_KEY = new PublicKey('GF34Uc25emR9LgWvPK4nGd1nRnBsa5vvNHyAo8NxiZGE'); // Using your .env wallet for this example

const SOLANA_CONNECTION = new Connection('https://solana-mainnet.g.alchemy.com/v2/5feEWsSBPHsAvcQK2zfji');

// =================================================================
// 3. GLOBAL STATE & HELPERS
// =================================================================
let log = [];                               // Chat history: [{type, user?, text, ts}]
const clients = new Map();                  // Connected clients: ws -> { user, room, bucket }

let devTransactionsCache = []; // <-- ADD THIS LINE

// --- Logo Queue State ---
let currentLogo = { imageUrl: DEFAULT_OVERLAY_LOGO, expiresAt: 0, setBy: 'system' };
const queue = [];                           // FIFO queue: [{ imageUrl, setBy, tx }]
let active = null;                          // Currently active logo: { imageUrl, setBy, tx, startedAt, expiresAt }
let revertTimer = null;
let nextBurnAt = 0; // Will be set by our new function

/** Schedules the next burn and broadcasts it, then reschedules itself. */
function scheduleNextBurn() {
  const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
  nextBurnAt = Date.now() + TWELVE_HOURS_MS;
  
  console.log(`[Timer] New burn epoch scheduled. Ends at: ${new Date(nextBurnAt).toISOString()}`);

  // Tell all connected clients about the new timer
  const payload = {
    t: 'next_burn',
    at: new Date(nextBurnAt).toISOString(),
    now: Date.now()
  };
  broadcastObserver(payload);
  broadcast(payload, 'global'); // Also inform chat clients

  // Automatically run this function again in 12 hours to create a loop
  setTimeout(scheduleNextBurn, TWELVE_HOURS_MS);
}

/** Pushes an event to the global chat log, trimming old entries. */
function pushLog(evt) {
  log.push(evt);
  if (log.length > LOG_MAX) log = log.slice(-LOG_MAX);
}

/** Broadcasts a JSON object to all clients in a specific room. */
function broadcast(obj, room = 'global') {
  const data = JSON.stringify(obj);
  for (const [ws, meta] of clients.entries()) {
    if (meta.room === room && ws.readyState === ws.OPEN) ws.send(data);
  }
}

/** Broadcasts a JSON object to all observer clients. */
function broadcastObserver(obj) {
  const data = JSON.stringify(obj);
  wssObserver.clients.forEach(ws => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });
}

/** Gets the current time in milliseconds. */
const nowMs = () => Date.now();

// REPLACE THE ENTIRE OLD FUNCTION WITH THIS CORRECTED VERSION
async function fetchDevWalletTransactions() {
    try {
        const signatures = await SOLANA_CONNECTION.getSignaturesForAddress(
            DEV_WALLET_PUBLIC_KEY,
            { limit: 15 } // Fetch last 15 transactions
        );

        if (!signatures.length) return [];

        const transactionSignatures = signatures.map(sigInfo => sigInfo.signature);
        const parsedTransactions = await SOLANA_CONNECTION.getParsedTransactions(transactionSignatures, { maxSupportedTransactionVersion: 0 });

        const transactions = [];
        for (let i = 0; i < signatures.length; i++) {
            const sigInfo = signatures[i];
            const tx = parsedTransactions[i]; // The correct variable for the transaction details

            if (tx) {
                const blockTime = new Date(tx.blockTime * 1000).toLocaleString();
                let type = 'Other';
                let amount = 'N/A';

                // Find the index of our dev wallet in the transaction's account keys
                const accountIndex = tx.transaction.message.accountKeys.findIndex(key => key.pubkey.equals(DEV_WALLET_PUBLIC_KEY));

                if (accountIndex !== -1) {
                    // Get the SOL balance before and after the transaction
                    const preBalance = tx.meta.preBalances[accountIndex];
                    const postBalance = tx.meta.postBalances[accountIndex];

                    if (preBalance !== undefined && postBalance !== undefined) {
                        const balanceChange = (postBalance - preBalance) / 1_000_000_000; // Convert lamports to SOL
                        if (balanceChange > 0) {
                            type = 'Receive (SOL)';
                            amount = `+${balanceChange.toFixed(6)} SOL`;
                        } else if (balanceChange < 0) {
                            type = 'Send (SOL)';
                            amount = `${balanceChange.toFixed(6)} SOL`;
                        }
                    }
                }

                transactions.push({
                    time: blockTime,
                    type: type,
                    amount: amount,
                    signature: sigInfo.signature,
                    slot: sigInfo.slot
                });
            }
        }
        return transactions;
    } catch (error) {
        console.error("Error fetching dev wallet transactions:", error);
        return [];
    }
}
                
// =================================================================
// 4. DETERMINISTIC PHYSICS ENGINE
// =================================================================
const WORLD_W = 1920, WORLD_H = 1080; // Logical world dimensions
const LOGO_W  = 300,  LOGO_H  = 180;  // Logical logo dimensions
const SPEED   = 380;                  // Speed in world units/sec

/** Generates deterministic physics properties based on a seed (image URL). */
function physicsFor(imageUrl, t0 = SERVER_T0) {
  const seed = [...String(imageUrl || DEFAULT_OVERLAY_LOGO)]
    .reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0) >>> 0;
  const ang = (seed % 360) * Math.PI / 180;
  const vx = Math.cos(ang) * SPEED;
  const vy = Math.sin(ang) * SPEED;
  const x0 = (WORLD_W - LOGO_W) / 2;
  const y0 = (WORLD_H - LOGO_H) / 2;
  return { worldW: WORLD_W, worldH: WORLD_H, logoW: LOGO_W, logoH: LOGO_H, x0, y0, vx, vy, t0 };
}

/** Calculates the state (pos, vel) of the logo at a specific time for telemetry. */
function __logoStateAt(timeMs) {
  const phys = physicsFor(currentLogo.imageUrl, active?.startedAt || SERVER_T0);
  const rangeX = phys.worldW - phys.logoW;
  const rangeY = phys.worldH - phys.logoH;
  const tSec = Math.max(0, (timeMs - phys.t0) / 1000);

  const reflect1D = (p0, v, range) => {
    const span = range * 2;
    const raw = p0 + v * tSec;
    const mod = ((raw % span) + span) % span;
    const pos = mod <= range ? mod : (span - mod);
    return Math.max(0, Math.min(range, pos));
  };

  const x = reflect1D(phys.x0, phys.vx, rangeX);
  const y = reflect1D(phys.y0, phys.vy, rangeY);
  return { x, y }; // Simplified for telemetry, can add back vel if needed
}

// =================================================================
// 5. LOGO QUEUE MANAGEMENT
// =================================================================
/** Processes the next logo in the queue or reverts to default. */
function startNext(room = 'global') {
  clearTimeout(revertTimer);

  if (!queue.length) {
    active = null;
    currentLogo = { imageUrl: DEFAULT_OVERLAY_LOGO, expiresAt: 0, setBy: 'system' };
  } else {
    const item = queue.shift();
    const startedAt = Date.now();
    active = {
      ...item,
      startedAt,
      expiresAt: startedAt + CLAIM_DURATION_MS,
    };
    currentLogo = {
      imageUrl: item.imageUrl,
      expiresAt: active.expiresAt,
      setBy: item.setBy,
    };
    revertTimer = setTimeout(() => startNext(room), CLAIM_DURATION_MS);
  }

  // Notify clients of the change
  const payload = {
    t: 'logo_current',
    imageUrl: currentLogo.imageUrl,
    expiresAt: new Date(currentLogo.expiresAt).toISOString(),
    setBy: currentLogo.setBy,
    phys: physicsFor(currentLogo.imageUrl, active?.startedAt || SERVER_T0),
    now: nowMs()
  };
  broadcast(payload, room);
  broadcastObserver(payload);
  broadcastQueueSize(room);
}

/** Broadcasts the current size of the logo queue. */
function broadcastQueueSize(room = 'global') {
  const n = (active ? 1 : 0) + queue.length;
  broadcast({ t: 'logo_queue_size', n }, room);
}

// =================================================================
// 6. TELEMETRY
// =================================================================
let __lastTelemetrySend = 0;
setInterval(() => {
  const now = Date.now();
  if (now - __lastTelemetrySend < 83) return; // ~12 Hz throttle
  const st = __logoStateAt(now);
  broadcastObserver({ t: 'logo_state', ...st });
  __lastTelemetrySend = now;
}, 16);

// =================================================================
// 7. HTTP SERVER (EXPRESS)
// =================================================================
const app = express();
const server = http.createServer(app);
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.status(200).send('ok'));

app.post('/create-transfer', async (req, res) => {
  try {
    const from = new PublicKey(String(req.body?.fromPubkey || ''));
    const lamports = Number(req.body?.lamports || 0);
    if (!lamports || lamports < MIN_LAMPORTS) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: from, recentBlockhash: blockhash }).add(
      SystemProgram.transfer({ fromPubkey: from, toPubkey: RECEIVER_PUBKEY, lamports })
    );

    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    res.json({ txBase64: Buffer.from(serialized).toString('base64') });
  } catch (e) {
    console.error('create-transfer error', e);
    res.status(500).json({ error: e?.message || 'Server error' });
  }
});

// =================================================================
// 8. WEBSOCKET SERVERS
// =================================================================
const wss = new WebSocketServer({ noServer: true });
const wssObserver = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const pathname = request.url;

  if (pathname === '/chat') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else if (pathname === '/observer') {
    wssObserver.handleUpgrade(request, socket, head, (ws) => {
      wssObserver.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// --- Observer WebSocket Handler ---
wssObserver.on('connection', (ws) => {
  ws.send(JSON.stringify({ t: 'time', now: nowMs() }));
  if (typeof nextBurnAt === 'number') {
    ws.send(JSON.stringify({ t: 'next_burn', at: new Date(nextBurnAt).toISOString(), now: nowMs() }));
    // Instantly send the cached transactions to the new user
ws.send(JSON.stringify({
    t: 'dev_transactions',
    transactions: devTransactionsCache
}));
  }
  ws.send(JSON.stringify({
    t: 'logo_current',
    imageUrl: currentLogo.imageUrl,
    expiresAt: new Date(currentLogo.expiresAt).toISOString(),
    setBy: currentLogo.setBy,
    phys: physicsFor(currentLogo.imageUrl, active?.startedAt || SERVER_T0),
    now: nowMs()
  }));
});

// --- Chat WebSocket Handler ---
wss.on('connection', (ws) => {
  const meta = { user: 'anon', room: 'global', bucket: { t0: Date.now(), n: 0 } };
  clients.set(ws, meta);

  // Greet the new user
  ws.send(JSON.stringify({ t: 'welcome', log, users: clients.size }));
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

  // Notify everyone of the new counts
  broadcastQueueSize(meta.room);
  broadcast({ t: 'count', n: clients.size }, meta.room);

  // --- Message Handling ---
  ws.on('message', async (buf) => {
    // [FIXED] Rate limit ALL incoming messages before processing
    const b = meta.bucket;
    const t = Date.now();
    if (t - b.t0 > 10000) { b.t0 = t; b.n = 0; } // Reset bucket every 10s
    if (++b.n > 10) { // Allow up to 10 messages per 10s
      ws.send(JSON.stringify({ t: 'error', text: 'Rate limit exceeded' }));
      return;
    }

    let msg = {};
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    // --- Message Router ---
    switch (msg.t) {
      case 'hello':
        meta.user = String(msg.user || 'anon').slice(0, 24);
        meta.room = String(msg.room || 'global');
        break;

      case 'chat':
        const text = String(msg.text || '').slice(0, 500).replace(/fuck|cunt|nigg|kike|spic|retard/gi, '****');
        const chatEvt = { type: 'user', user: meta.user, text, ts: msg.ts || new Date().toISOString() };
        pushLog(chatEvt);
        broadcast({ t: 'chat', ...chatEvt }, meta.room);
        break;

      // REPLACE THE ENTIRE 'logo_claim' case block
case 'logo_claim':
  try {
    const { tx, imageUrl } = msg;
    const MAX_URL_CHARS = 2 * 1024 * 1024; // ~2MB limit for base64
    const isHttpsImage = (url) => { try { const u = new URL(url); return u.protocol === 'https:' && /\.(png|jpg|jpeg|webp|gif|svg)(\?|#|$)/i.test(u.pathname); } catch { return false; } };
    const isDataImage = (url) => typeof url === 'string' && url.length < MAX_URL_CHARS && url.startsWith('data:image/') && /;base64,/.test(url);

    if (!isHttpsImage(imageUrl) && !isDataImage(imageUrl)) {
      ws.send(JSON.stringify({ t: 'error', text: 'Invalid image format or URL.' }));
      return;
    }

    // THIS IS THE KEY FIX: We now explicitly set the transaction version
    const parsed = await connection.getParsedTransaction(tx, { maxSupportedTransactionVersion: 0 });

    if (!parsed || parsed.meta?.err) {
      ws.send(JSON.stringify({ t: 'error', text: 'Transaction not confirmed or failed.' }));
      return;
    }

    let paid = 0n;
    for (const ix of parsed.transaction.message.instructions) {
      if (ix.program === 'system' && ix.parsed?.type === 'transfer' && ix.parsed.info?.destination === RECEIVER_PUBKEY.toString()) {
        paid += BigInt(ix.parsed.info.lamports || 0);
      }
    }

    if (paid < BigInt(MIN_LAMPORTS)) {
      ws.send(JSON.stringify({ t: 'error', text: 'Correct payment not found in transaction.' }));
      return;
    }

    const wasIdle = !active && !queue.length;
    const item = { imageUrl, setBy: meta.user || 'user', tx };
    queue.push(item);

    const pos = (active ? 1 : 0) + queue.length;
    ws.send(JSON.stringify({ t: 'logo_queue_pos', pos }));
    
    const systemEvt = { type: 'system', text: `${item.setBy} joined the logo queue (#${pos}).`, ts: new Date().toISOString() };
    pushLog(systemEvt);
    broadcast({ t: 'system', text: systemEvt.text, ts: systemEvt.ts }, meta.room);
    broadcastQueueSize(meta.room);

    if (wasIdle) startNext(meta.room);
  } catch (err) {
    console.error('logo_claim verify error', err);
    ws.send(JSON.stringify({ t: 'error', text: 'Verification error. See server logs.' }));
  }
  break;
    }
  });

  // --- Close Handling ---
  ws.on('close', () => {
    clients.delete(ws);
    broadcast({ t: 'count', n: clients.size }, 'global');
  });
});

// =================================================================
// 9. SERVER INITIALIZATION
// =================================================================
const PORT = process.env.PORT || 8787;
server.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
// Start the first burn timer cycle
scheduleNextBurn();

/// REPLACE THE OLD setInterval WITH THIS NEW VERSION

// This function will run in the background to periodically update the cache
async function refreshTransactionCache() {
  console.log('[Cache] Refreshing dev wallet transactions...');
  try {
    const transactions = await fetchDevWalletTransactions();
    if (transactions.length > 0) {
      devTransactionsCache = transactions;
      // Broadcast the new data to all connected clients
      broadcastObserver({
          t: 'dev_transactions',
          transactions: devTransactionsCache
      });
      console.log(`[Cache] Successfully updated with ${transactions.length} transactions.`);
    }
  } catch (e) {
    console.error('[Cache] Failed to refresh transaction cache:', e);
  }
}

// Wait 5 seconds on server start before the first fetch
setTimeout(refreshTransactionCache, 5000); 

// Set the periodic refresh to every 10 minutes (600 seconds)
setInterval(refreshTransactionCache, 600 * 1000);

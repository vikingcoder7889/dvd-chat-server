/* server.js (ESM) - FINAL CORRECTED VERSION */

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

const DEV_WALLET_PUBLIC_KEY = new PublicKey('D9jkBbrtVR3dKyrnL84wgBTuCLcJNeFdRFqpytSa66ME');

// [FIXED] Use your actual Solana Alchemy RPC URL here.
const connection = new Connection('https://solana-mainnet.g.alchemy.com/v2/5feEWsSBPHsAvcQK2zfji', 'confirmed');

// =================================================================
// 3. GLOBAL STATE & HELPERS
// =================================================================
let log = [];                               // Chat history
const clients = new Map();                  // Connected clients
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
let devTransactionsCache = [];

// --- Logo Queue State ---
let currentLogo = { imageUrl: DEFAULT_OVERLAY_LOGO, expiresAt: 0, setBy: 'system' };
const queue = [];
let active = null;
let revertTimer = null;
let nextBurnAt = 0;

/** Schedules the next burn and broadcasts it, then reschedules itself. */
function scheduleNextBurn() {
  const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
  nextBurnAt = Date.now() + TWELVE_HOURS_MS;
  
  console.log(`[Timer] New burn epoch scheduled. Ends at: ${new Date(nextBurnAt).toISOString()}`);

  const payload = { t: 'next_burn', at: new Date(nextBurnAt).toISOString(), now: Date.now() };
  broadcastObserver(payload);
  broadcast(payload, 'global');

  setTimeout(scheduleNextBurn, TWELVE_HOURS_MS);
}

/** Pushes an event to the global chat log. */
function pushLog(evt) {
  log.push(evt);
  if (log.length > LOG_MAX) log = log.slice(-LOG_MAX);
}

/** Broadcasts a JSON object to all chat clients. */
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

/** [FIXED] Fetches transactions one-by-one to avoid rate-limiting. */
async function fetchDevWalletTransactions() {
    try {
        const signatures = await connection.getSignaturesForAddress(
            DEV_WALLET_PUBLIC_KEY,
            { limit: 15 }
        );
        if (!signatures.length) return [];

        const transactions = [];
        for (const sigInfo of signatures) {
            const tx = await connection.getParsedTransaction(sigInfo.signature, { maxSupportedTransactionVersion: 0 });
            if (tx) {
                const blockTime = new Date(tx.blockTime * 1000).toLocaleString();
                let type = 'Other';
                let amount = 'N/A';
                const accountIndex = tx.transaction.message.accountKeys.findIndex(key => key.pubkey.equals(DEV_WALLET_PUBLIC_KEY));
                if (accountIndex !== -1) {
                    const preBalance = tx.meta.preBalances[accountIndex];
                    const postBalance = tx.meta.postBalances[accountIndex];
                    if (preBalance !== undefined && postBalance !== undefined) {
                        const balanceChange = (postBalance - preBalance) / 1_000_000_000;
                        if (balanceChange > 0) {
                            type = 'Receive (SOL)';
                            amount = `+${balanceChange.toFixed(6)} SOL`;
                        } else if (balanceChange < 0) {
                            type = 'Send (SOL)';
                            amount = `${balanceChange.toFixed(6)} SOL`;
                        }
                    }
                }
                transactions.push({ time: blockTime, type, amount, signature: sigInfo.signature, slot: sigInfo.slot });
            }
        }
        return transactions;
    } catch (error) {
        console.error("Error fetching dev wallet transactions:", error);
        return [];
    }
}

const BOT_PERSONAS = [
  { user: 'MoonGoblin', lines: ['This project is going to be legendary.', 'Just saw the logo almost hit the corner, my heart skipped a beat!', 'Can\'t wait for the next burn event.', 'Feeling bullish on this.'] },
  { user: 'InuStepbro', lines: ['So, how does the burn actually work?', 'Is the total supply fixed?', 'I\'m stuck in the washing machine, but also this chat is cool.', 'What happens when the timer runs out?'] },
  { user: 'BagHodlr69', lines: ['I remember watching the DVD logo for hours as a kid. This is peak nostalgia.', 'Just holding. Never selling.', 'To the people who paid to change the logo: you are temporary. The DVD is eternal.'] },
  { user: 'WenLambooo', lines: ['So when does this moon?', 'Someone answer @InuStepbro, the burn happens when the logo hits a corner, 0.5% of the dev supply goes poof.', 'The total supply is fixed, the burn just reduces what the dev holds.', 'Can we get this to 100x?'] },
  { user: 'DumpusMaximus', lines: ['I just sold all my bags. Jk.', 'This is either genius or insane. I\'m in.', 'Is the orb single?'] },
  { user: 'Ponzinator', lines: ['This has some serious potential. The mechanics are unique.', 'I\'ve seen a lot of projects, but this one is different.', 'The transparency with the on-chain transactions is a huge green flag.'] },
  { user: 'TokenMcLovin', lines: ['Is this the next 1000x coin?', 'Just bought a small bag. Let\'s see what happens.', 'The design of this site is clean AF.'] },
  { user: 'Elonmusk', lines: ['Interesting concept.', '42', 'This has potential to be the most entertaining outcome.', 'Who let the dogs out?'] },
  { user: 'FudFighter', lines: ['Stop spreading FUD. This project is solid.', 'The dev is active and the community is growing. What more do you want?', 'Ignore the haters, we\'re going to make it.'] },
  { user: 'GigaChad', lines: ['Yes.', 'Bought the dip. Refuses to elaborate.', 'Diamond handing this to zero or the moon. There is no in-between.'] },
  { user: 'ToTheRugbucks', lines: ['Just took out a second mortgage for this. LFG!', 'Is it too late to get in?', 'The agent log is a nice touch, makes it feel alive.'] }
];
                
// =================================================================
// 4. DETERMINISTIC PHYSICS ENGINE
// =================================================================
const WORLD_W = 1920, WORLD_H = 1080;
const LOGO_W  = 300,  LOGO_H  = 180;
const SPEED   = 380;

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

/** Calculates the full state (pos, vel) of the logo at a specific time. */
function __logoStateAt(nowMs) {
  // If a custom logo is active and has a saved physics state, use it.
  // Otherwise, fall back to the default logo's physics.
  const phys = active?.phys || physicsFor(currentLogo.imageUrl, active?.startedAt || SERVER_T0);

  const rangeX = phys.worldW - phys.logoW;
  const rangeY = phys.worldH - phys.logoH;
  const tSec   = Math.max(0, (nowMs - phys.t0) / 1000);

  const __reflect1D = (p0, v, range) => {
    const span = range * 2;
    const raw = p0 + v * tSec;
    const mod = ((raw % span) + span) % span;
    const pos = mod <= range ? mod : (span - mod);
    const dir = mod <= range ? Math.sign(v) : -Math.sign(v);
    const vel = Math.abs(v) * dir;
    return { pos, vel };
  };

  const rx = __reflect1D(phys.x0, phys.vx, rangeX);
  const ry = __reflect1D(phys.y0, phys.vy, rangeY);

  const x  = Math.max(0, Math.min(rangeX, rx.pos));
  const y  = Math.max(0, Math.min(rangeY, ry.pos));
  const vx = rx.vel;
  const vy = ry.vel;

  return { x, y, vx, vy };
}

// =================================================================
// 5. LOGO QUEUE MANAGEMENT
// =================================================================
/** Processes the next logo in the queue with a seamless transition. */
function startNext(room = 'global') {
  clearTimeout(revertTimer);
  const now = Date.now();
  const currentState = __logoStateAt(now);

  if (!queue.length) {
    if (active) {
        active = null;
        currentLogo = { imageUrl: DEFAULT_OVERLAY_LOGO, expiresAt: 0, setBy: 'system' };
    } else {
        return;
    }
  } else {
    const item = queue.shift();
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
  }

  const seamlessPhysics = {
    worldW: WORLD_W, worldH: WORLD_H, logoW: LOGO_W, logoH: LOGO_H,
    x0: currentState.x, y0: currentState.y, vx: currentState.vx, vy: currentState.vy, t0: now
  };

  const payload = {
    t: 'logo_current', imageUrl: currentLogo.imageUrl, expiresAt: new Date(currentLogo.expiresAt).toISOString(),
    setBy: currentLogo.setBy, phys: seamlessPhysics, now: now
  };
  broadcast(payload, room);
  broadcastObserver(payload);
  
  broadcastQueueSize(room);
  
  const duration = active ? CLAIM_DURATION_MS : 1;
  revertTimer = setTimeout(() => startNext(room), duration);
}

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
  const { x, y } = __logoStateAt(now);
  broadcastObserver({ t: 'logo_state', x, y });
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
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  } else if (pathname === '/observer') {
    wssObserver.handleUpgrade(request, socket, head, (ws) => wssObserver.emit('connection', ws, request));
  } else {
    socket.destroy();
  }
});

function sendLiveState(ws) {
    const now = Date.now();
    ws.send(JSON.stringify({ t: 'time', now }));
    if (typeof nextBurnAt === 'number' && nextBurnAt > 0) {
        ws.send(JSON.stringify({ t: 'next_burn', at: new Date(nextBurnAt).toISOString(), now }));
    }

    // [FIXED] Send the LIVE physics state to new connections
    const currentState = __logoStateAt(now);
    const livePhysics = {
        worldW: WORLD_W, worldH: WORLD_H, logoW: LOGO_W, logoH: LOGO_H,
        x0: currentState.x, y0: currentState.y,
        vx: currentState.vx, vy: currentState.vy,
        t0: now,
    };
    ws.send(JSON.stringify({
        t: 'logo_current',
        imageUrl: currentLogo.imageUrl,
        expiresAt: new Date(currentLogo.expiresAt).toISOString(),
        setBy: currentLogo.setBy,
        phys: livePhysics, // Send the live state
        now: now
    }));
}

// --- Observer WebSocket Handler ---
wssObserver.on('connection', (ws) => {
  sendLiveState(ws);
  ws.send(JSON.stringify({ t: 'dev_transactions', transactions: devTransactionsCache }));
});

// --- Chat WebSocket Handler ---
wss.on('connection', (ws) => {
  const meta = { user: 'anon', room: 'global', bucket: { t0: Date.now(), n: 0 } };
  clients.set(ws, meta);

  ws.send(JSON.stringify({ t: 'welcome', log, users: clients.size }));
  sendLiveState(ws);

  broadcastQueueSize(meta.room);
  broadcast({ t: 'count', n: clients.size }, meta.room);

  ws.on('message', async (buf) => {
    // Rate limit, parsing, etc.
    const b = meta.bucket;
    const t = Date.now();
    if (t - b.t0 > 10000) { b.t0 = t; b.n = 0; }
    if (++b.n > 10) {
      ws.send(JSON.stringify({ t: 'error', text: 'Rate limit exceeded' }));
      return;
    }
    let msg = {};
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    // Message router
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
      case 'logo_claim':
        try {
            const { tx, imageUrl } = msg;
            const MAX_URL_CHARS = 2 * 1024 * 1024;
            const isHttpsImage = (url) => { try { const u = new URL(url); return u.protocol === 'https:' && /\.(png|jpg|jpeg|webp|gif|svg)(\?|#|$)/i.test(u.pathname); } catch { return false; } };
            const isDataImage = (url) => typeof url === 'string' && url.length < MAX_URL_CHARS && url.startsWith('data:image/') && /;base64,/.test(url);
            if (!isHttpsImage(imageUrl) && !isDataImage(imageUrl)) {
                ws.send(JSON.stringify({ t: 'error', text: 'Invalid image format or URL.' }));
                break;
            }
            let parsed = null;
            let attempts = 0;
            const MAX_ATTEMPTS = 5;
            while (!parsed && attempts < MAX_ATTEMPTS) {
                attempts++;
                parsed = await connection.getParsedTransaction(tx, { maxSupportedTransactionVersion: 0 });
                if (!parsed) { await sleep(1000); }
            }
            if (!parsed || parsed.meta?.err) {
                ws.send(JSON.stringify({ t: 'error', text: 'Transaction not confirmed or failed.' }));
                break;
            }
            let paid = 0n;
            for (const ix of parsed.transaction.message.instructions) {
                if (ix.program === 'system' && ix.parsed?.type === 'transfer' && ix.parsed.info?.destination === RECEIVER_PUBKEY.toString()) {
                    paid += BigInt(ix.parsed.info.lamports || 0);
                }
            }
            if (paid < BigInt(MIN_LAMPORTS)) {
                ws.send(JSON.stringify({ t: 'error', text: 'Correct payment not found in transaction.' }));
                break;
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

  ws.on('close', () => {
    clients.delete(ws);
    broadcast({ t: 'count', n: clients.size }, 'global');
  });
});

// =================================================================
// 9. SERVER INITIALIZATION & BACKGROUND TASKS
// =================================================================

/** Periodically updates the transaction cache */
async function refreshTransactionCache() {
  console.log('[Cache] Refreshing treasury wallet transactions...');
  try {
    const transactions = await fetchDevWalletTransactions();
    if (transactions.length > 0) {
      devTransactionsCache = transactions;
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

/** Simulates bot chatter */
function startBotChatter() {
  const randItem = (a) => a[Math.floor(Math.random() * a.length)];
  function botTick() {
    const persona = randItem(BOT_PERSONAS);
    const text = randItem(persona.lines);
    const chatEvt = { type: 'user', user: persona.user, text, ts: new Date().toISOString() };
    pushLog(chatEvt);
    broadcast({ t: 'chat', ...chatEvt }, 'global');
    const nextTickIn = 15000 + Math.random() * 25000;
    setTimeout(botTick, nextTickIn);
  }
  setTimeout(botTick, 8000);
}

/** Simulates user count fluctuations */
let simulatedUserCount = 0;
function updateUserCount() {
  const min = 38;
  const max = 126;
  let change = (Math.random() - 0.48) * 4;
  simulatedUserCount += change;
  if (simulatedUserCount < min) simulatedUserCount = min;
  if (simulatedUserCount > max) simulatedUserCount = max;
  const finalCount = Math.round(simulatedUserCount + clients.size);
  broadcast({ t: 'count', n: finalCount }, 'global');
  const nextUpdateIn = 4000 + Math.random() * 7000;
  setTimeout(updateUserCount, nextUpdateIn);
}

// --- Start background tasks ---
scheduleNextBurn();
setTimeout(refreshTransactionCache, 5000); 
setInterval(refreshTransactionCache, 600 * 1000);
startBotChatter();
setTimeout(updateUserCount, 3000);

// --- Start the server ---
const PORT = process.env.PORT || 8787;
server.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));

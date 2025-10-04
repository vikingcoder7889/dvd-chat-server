/* server.final.js — minimal & robust observer sync */
import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';

const PORT = process.env.PORT || 8787;

const nowMs = () => Date.now();
const WORLD_W = 1920, WORLD_H = 1080;
const LOGO_W  = 300, LOGO_H  = 180;
const SPEED   = 380;
const DEFAULT_OVERLAY_LOGO = '/dvd_logo-bouncing.png';

const SERVER_T0 = Date.now();
let nextBurnAt = Date.now() + 12*60*60*1000;
let active = { imageUrl: DEFAULT_OVERLAY_LOGO, startedAt: SERVER_T0, setBy: 'system' };

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

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

app.get('/health', (_req,res)=>res.send('ok'));
app.get('/debug', (_req,res)=>{
  res.json({
    now: nowMs(),
    nextBurnAt,
    active,
    physics: physicsFor(active.imageUrl, active.startedAt)
  });
});

const server = http.createServer(app);

const wssChat = new WebSocketServer({ server, path: '/chat' });
const wssObserver = new WebSocketServer({ server, path: '/observer' });
const observers = new Set();

function sendObserver(obj) {
  const data = JSON.stringify(obj);
  for (const ws of observers) { try{ ws.send(data) }catch{} }
}

wssObserver.on('connection', (ws)=>{
  observers.add(ws);
  ws.send(JSON.stringify({ t:'time', now: nowMs() }));
  ws.send(JSON.stringify({ t:'next_burn', at: new Date(nextBurnAt).toISOString(), now: nowMs() }));
  ws.send(JSON.stringify({
    t:'logo_current',
    imageUrl: active.imageUrl,
    setBy: active.setBy,
    phys: physicsFor(active.imageUrl, active.startedAt),
    now: nowMs()
  }));
  ws.on('close', ()=>observers.delete(ws));
  ws.on('error', ()=>{ try{ws.close()}catch{} observers.delete(ws) });
});

setInterval(()=> sendObserver({ t:'time', now: nowMs() }), 2000);

function broadcastLogo() {
  const payload = {
    t:'logo_current',
    imageUrl: active.imageUrl,
    setBy: active.setBy,
    phys: physicsFor(active.imageUrl, active.startedAt),
    now: nowMs()
  };
  sendObserver(payload);
}

server.listen(PORT, ()=>{
  console.log('Observer server listening on :' + PORT);
});

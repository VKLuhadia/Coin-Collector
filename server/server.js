// server.js
// Authoritative Coin Collector game server with simulated latency and snapshot broadcasts.
// Uses WebSocket transport (ws). Server keeps canonical game state and validates all events.
// Run: npm install && node server.js

const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const cfg = require('./config');

const PORT = cfg.PORT;
const TICK_RATE = cfg.TICK_RATE;
const MS_PER_TICK = 1000 / TICK_RATE;
const ONE_WAY_LATENCY = cfg.LATENCY_MS;
const LATENCY_JITTER = cfg.LATENCY_JITTER_MS;
const PLAYER_SPEED = cfg.PLAYER_SPEED;
const PICKUP_RADIUS = cfg.PICKUP_RADIUS;
const MAP_W = cfg.MAP_WIDTH;
const MAP_H = cfg.MAP_HEIGHT;
const COIN_SPAWN_INTERVAL_MS = cfg.COIN_SPAWN_INTERVAL_MS;
const MAX_COINS = cfg.MAX_COINS;
const DEBUG = cfg.DEBUG;

const wss = new WebSocket.Server({ port: PORT });
console.log(`Server listening on ws://localhost:${PORT}`);

// Game state
let players = {}; // playerId -> { id, name, x, y, vx, vy, score, lastInput, lastSeen }
let coins = {};   // coinId -> { id, x, y }
let sockets = new Map(); // ws -> playerId

// Simple delayed queues for latency simulation
let incomingQueue = []; // { deliverAt, ws, raw }
let outgoingQueue = []; // { deliverAt, ws, packet }

// Utility: push outgoing with one-way latency + jitter
function sendWithLatency(ws, packet) {
  const jitter = Math.floor((Math.random() - 0.5) * 2 * LATENCY_JITTER);
  const deliverAt = Date.now() + ONE_WAY_LATENCY + jitter;
  outgoingQueue.push({ deliverAt, ws, packet });
}

// Utility: queue incoming messages with latency
function queueIncoming(ws, raw) {
  const jitter = Math.floor((Math.random() - 0.5) * 2 * LATENCY_JITTER);
  const deliverAt = Date.now() + ONE_WAY_LATENCY + jitter;
  incomingQueue.push({ deliverAt, ws, raw });
}

// Flush outgoing queue frequently (every 10ms)
setInterval(() => {
  const now = Date.now();
  while (outgoingQueue.length && outgoingQueue[0].deliverAt <= now) {
    const item = outgoingQueue.shift();
    if (item.ws.readyState === WebSocket.OPEN) {
      try {
        item.ws.send(JSON.stringify(item.packet));
      } catch (e) {
        // ignore send errors for closed sockets
      }
    }
  }
}, 10);

// Keep outgoing/incoming queues sorted by deliverAt for efficiency
function sortQueues() {
  incomingQueue.sort((a, b) => a.deliverAt - b.deliverAt);
  outgoingQueue.sort((a, b) => a.deliverAt - b.deliverAt);
}

// WebSocket server handling
wss.on('connection', (ws) => {
  // Assign temporary id until player sends 'join'
  const tmpId = uuidv4();
  sockets.set(ws, null);

  if (DEBUG) console.log(`[ws] connection: ${tmpId} (awaiting join)`);

  ws.on('message', (raw) => {
    // Instead of processing immediately, enqueue with latency
    queueIncoming(ws, raw);
    sortQueues();
  });

  ws.on('close', () => {
    const pid = sockets.get(ws);
    sockets.delete(ws);
    if (pid && players[pid]) {
      if (DEBUG) console.log(`[ws] player disconnected: ${pid}`);
      delete players[pid];
    } else {
      if (DEBUG) console.log(`[ws] connection closed (no player id)`);
    }
  });

  // send a welcome (immediate, but we should also simulate latency for fairness)
  sendWithLatency(ws, { type: 'welcome', serverTime: Date.now() });
});

// Process incoming queue (deliver messages to server logic)
function processIncomingQueue() {
  const now = Date.now();
  while (incomingQueue.length && incomingQueue[0].deliverAt <= now) {
    const item = incomingQueue.shift();
    try {
      const msg = JSON.parse(item.raw);
      handleClientMessage(item.ws, msg);
    } catch (e) {
      if (DEBUG) console.warn('failed to parse client message', e);
    }
  }
}

// Handle high-level messages (join, input, ping)
function handleClientMessage(ws, msg) {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'join') {
    // msg: { type: 'join', name: 'Alice' }
    if (Object.keys(players).length >= cfg.MAX_PLAYERS) {
      sendWithLatency(ws, { type: 'join_reject', reason: 'server_full' });
      return;
    }
    const id = uuidv4();
    // spawn player at random location
    const x = Math.random() * (MAP_W - 40) + 20;
    const y = Math.random() * (MAP_H - 40) + 20;
    players[id] = {
      id,
      name: msg.name || `player-${id.slice(0, 4)}`,
      x, y,
      vx: 0, vy: 0,
      score: 0,
      lastInput: { seq: 0, dx: 0, dy: 0 }, // last reported movement intent
      lastSeen: Date.now()
    };
    sockets.set(ws, id);
    if (DEBUG) console.log(`[join] ${players[id].name} (${id}) at (${x.toFixed(1)}, ${y.toFixed(1)})`);
    // send ack (with assigned id and current map/state)
    sendWithLatency(ws, {
      type: 'join_ack',
      id,
      serverTime: Date.now(),
      map: { width: MAP_W, height: MAP_H },
      players: Object.values(players).map(p => ({ id: p.id, name: p.name, x: p.x, y: p.y, score: p.score })),
      coins: Object.values(coins)
    });
    return;
  }

  if (msg.type === 'input') {
    // msg: { type:'input', seq: 12, dx: -1|0|1, dy: -1|0|1, ts: clientTs }
    const pid = sockets.get(ws);
    if (!pid || !players[pid]) return;
    // basic shape: store last input intent (server will apply movement each tick using last intent)
    // Do server-side validation of fields
    const seq = Number(msg.seq) || 0;
    const dx = Math.max(-1, Math.min(1, Number(msg.dx) || 0));
    const dy = Math.max(-1, Math.min(1, Number(msg.dy) || 0));
    // ensure seq moves forward
    if (seq <= players[pid].lastInput.seq) {
      // old input; discard
      return;
    }
    players[pid].lastInput = { seq, dx, dy, ts: msg.ts || Date.now() };
    players[pid].lastSeen = Date.now();
    // don't apply movement here — movement applied on tick loop
    return;
  }

  if (msg.type === 'ping') {
    // client ping — echo to let client compute RTT (we simulate latency when sending out)
    sendWithLatency(ws, { type: 'pong', ts: msg.ts, serverTime: Date.now() });
    return;
  }

  // other messages ignored for now (e.g., chat)
}

// Game loop tick: authoritative simulation + collision resolution + snapshots
let serverTick = 0;
let lastCoinSpawn = Date.now();

function gameTick() {
  serverTick++;
  const dt = MS_PER_TICK / 1000; // seconds

  // 1) apply movement for each player using their lastInput intent
  for (const pid in players) {
    const p = players[pid];
    const input = p.lastInput || { dx: 0, dy: 0 };
    const intendedDx = Number(input.dx) || 0;
    const intendedDy = Number(input.dy) || 0;

    // normalize diagonal movement to maintain same speed
    let len = Math.hypot(intendedDx, intendedDy);
    let ndx = 0, ndy = 0;
    if (len > 0.0001) {
      ndx = intendedDx / len;
      ndy = intendedDy / len;
    }
    const moveDist = PLAYER_SPEED * dt;
    // anti-cheat clamp (not strictly needed here because server is authoritative, but we'll enforce)
    const maxAllowedMove = moveDist * 1.2;
    const dx = ndx * moveDist;
    const dy = ndy * moveDist;
    const actualDx = Math.max(-maxAllowedMove, Math.min(maxAllowedMove, dx));
    const actualDy = Math.max(-maxAllowedMove, Math.min(maxAllowedMove, dy));

    p.x += actualDx;
    p.y += actualDy;

    // clamp to map bounds
    p.x = Math.max(0 + 8, Math.min(MAP_W - 8, p.x));
    p.y = Math.max(0 + 8, Math.min(MAP_H - 8, p.y));
  }

  // 2) resolve coin pickups (server authoritative)
  const pickedCoins = [];
  for (const coinId in coins) {
    const coin = coins[coinId];
    for (const pid in players) {
      const p = players[pid];
      const dist2 = (p.x - coin.x) ** 2 + (p.y - coin.y) ** 2;
      if (dist2 <= PICKUP_RADIUS * PICKUP_RADIUS) {
        // pickup validated by server — award score and remove coin
        p.score += 1;
        pickedCoins.push({ coinId, by: pid });
        delete coins[coinId];
        if (DEBUG) console.log(`[pickup] player=${p.name} (${pid}) coin=${coinId} score=${p.score}`);
        break; // coin picked by one player only
      }
    }
  }

  // 3) spawn coins if needed
  const now = Date.now();
  if (now - lastCoinSpawn >= COIN_SPAWN_INTERVAL_MS) {
    lastCoinSpawn = now;
    maybeSpawnCoin();
  }

  // 4) broadcast snapshot (every tick or configured)
  if (serverTick % cfg.SNAPSHOT_BROADCAST_RATE === 0) {
    broadcastSnapshot();
  }
}

// Helper: spawn coin if below max
function maybeSpawnCoin() {
  if (Object.keys(coins).length >= MAX_COINS) return;
  const id = uuidv4();
  // ensure coin spawns inside bounds with margin
  const margin = 20;
  const x = Math.random() * (MAP_W - margin * 2) + margin;
  const y = Math.random() * (MAP_H - margin * 2) + margin;
  coins[id] = { id, x, y };
  if (DEBUG) console.log(`[spawn] coin ${id} at (${x.toFixed(1)}, ${y.toFixed(1)})`);
  // (optionally) broadcast coin spawn event immediately
  // We'll include coins in snapshots so clients learn about them soon enough.
}

// Broadcast a snapshot to all connected clients (via latency-queue)
function broadcastSnapshot() {
  const snap = {
    type: 'snapshot',
    serverTick,
    serverTime: Date.now(),
    players: Object.values(players).map(p => ({
      id: p.id, name: p.name, x: p.x, y: p.y, score: p.score, lastInputSeq: p.lastInput.seq
    })),
    coins: Object.values(coins)
  };

  // queue the snapshot for each client with simulated latency
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      // We send snapshots frequently so keep them compact
      sendWithLatency(ws, snap);
    }
  });
}

// Periodically process incoming queue (deliver messages) and outgoing queue is flushed separately above
setInterval(processIncomingQueue, 5);

// Run the main game tick at configured frequency
setInterval(gameTick, MS_PER_TICK);

// Periodic housekeeping (e.g., remove stale players)
setInterval(() => {
  const now = Date.now();
  for (const pid in players) {
    const p = players[pid];
    // if no input/heartbeat for 60s, drop player
    if (now - p.lastSeen > 60000) {
      if (DEBUG) console.log(`[timeout] removing player ${p.id}`);
      delete players[pid];
      // find and close socket if exists
      for (const [ws, id] of sockets.entries()) {
        if (id === pid) {
          try { ws.close(); } catch (e) {}
          sockets.delete(ws);
        }
      }
    }
  }
}, 10000);

// Keep outgoing and incoming queues reasonably ordered
setInterval(sortQueues, 200);

// ---------- optional: simple CLI commands for debug ----------
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on('line', (line) => {
  if (line === 'players') {
    console.log('players:', Object.values(players).map(p => ({ id: p.id, name: p.name, score: p.score, x: p.x.toFixed(1), y: p.y.toFixed(1) })));
  } else if (line === 'coins') {
    console.log('coins:', Object.values(coins).map(c => ({ id: c.id, x: c.x.toFixed(1), y: c.y.toFixed(1) })));
  } else if (line === 'dump') {
    console.log(JSON.stringify({ players, coins }, null, 2));
  } else if (line.startsWith('spawn')) {
    maybeSpawnCoin();
  } else if (line === 'help') {
    console.log('commands: players, coins, spawn, dump, help');
  } else {
    console.log('unknown command (type help)');
  }
});

if (DEBUG) {
  console.log('Server debug CLI active. Type "help" for commands.');
}

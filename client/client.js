// client.js
// Client for Coin Collector (connects to the authoritative Node server).
// Implements: input sending, client-side prediction, reconciliation, and interpolation.
// Usage: open index.html in two browser tabs (or serve via simple static server).

/* --------------
  CONFIG (tune as needed)
   - KEEP movement speed same as server to reduce reconciliation corrections
-------------- */
const SERVER_URL = 'ws://localhost:8080'; // change if server at different host
const PLAYER_SPEED = 120;          // units/sec (must match server)
const CLIENT_SEND_RATE = 50;       // ms between input send packets (we sample & send current intent)
const INTERPOLATION_DELAY = 220;   // ms buffer for interpolating remote players (>= server LATENCY_MS)
const SNAPSHOT_BUFFER_MS = 2000;   // how long to keep snapshots
const PICKUP_RADIUS = 16;          // same as server for possible local debug draws

/* -----------------
  Runtime state
----------------- */
let ws = null;
let myId = null;
let joined = false;
let nameInput = null;

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

const statusEl = document.getElementById('status');
const latencyEl = document.getElementById('latency');
const scoresEl = document.getElementById('scores');
const debugEl = document.getElementById('debug');
const joinBtn = document.getElementById('joinBtn');
const debugBtn = document.getElementById('debugBtn');
const nameField = document.getElementById('name');

let debugMode = false;

/* Input state */
let keys = { up:false, down:false, left:false, right:false };
let currentInput = { dx: 0, dy: 0 };
let inputSeq = 0;
let lastSendAt = 0;
let pendingInputs = []; // { seq, dx, dy, ts } - used for reconciliation

/* Local predicted state */
let localState = { x: 0, y: 0, score: 0, name: '' };

/* Server snapshots buffer (array of snapshots sorted by serverTime asc) */
let snapshotBuffer = []; // each snapshot: { serverTick, serverTime, players: [{id,x,y,score,lastInputSeq}], coins: [...] }

/* Interpolation helpers */
function pushSnapshot(snap) {
  snapshotBuffer.push(snap);
  const cutoff = Date.now() - SNAPSHOT_BUFFER_MS;
  while (snapshotBuffer.length > 0 && snapshotBuffer[0].serverTime < cutoff) snapshotBuffer.shift();
}

/* Utility: linear interpolation */
function lerp(a,b,t) { return a + (b-a)*t; }
function lerpPos(a,b,t) { return { x: lerp(a.x,b.x,t), y: lerp(a.y,b.y,t) }; }

/* Networking: connect and handlers */
function connect() {
  ws = new WebSocket(SERVER_URL);
  statusEl.textContent = 'Status: connecting...';

  ws.addEventListener('open', () => {
    statusEl.textContent = 'Status: connected (not joined)';
    console.log('ws open');
    startPingLoop();
  });

  ws.addEventListener('message', (ev) => {
    // parse message
    let msg;
    try { msg = JSON.parse(ev.data); } catch(e) { console.warn('invalid msg', ev.data); return; }
    handleServerMessage(msg);
  });

  ws.addEventListener('close', () => {
    statusEl.textContent = 'Status: disconnected';
    console.log('ws close');
    ws = null;
    myId = null;
    joined = false;
  });

  ws.addEventListener('error', (e) => {
    console.warn('ws error', e);
  });
}

/* Send with simple guard */
function wsSend(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

/* Ping loop for RTT estimation */
let lastPingTs = 0;
let rtt = -1;
function startPingLoop() {
  setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const ts = Date.now();
    lastPingTs = ts;
    wsSend({ type: 'ping', ts });
  }, 1000);
}

/* Handle messages from server (remember server-side simulates 200ms latency) */
function handleServerMessage(msg) {
  if (!msg.type) return;
  if (msg.type === 'welcome') {
    // ignore
  } else if (msg.type === 'join_ack') {
    myId = msg.id;
    joined = true;
    statusEl.textContent = `Joined as ${nameField.value} (${myId.slice(0,6)})`;
    // set local state from server
    const me = (msg.players || []).find(p => p.id === myId);
    if (me) {
      localState.x = me.x; localState.y = me.y; localState.score = me.score; localState.name = me.name;
    }
  } else if (msg.type === 'join_reject') {
    statusEl.textContent = `Join rejected: ${msg.reason}`;
  } else if (msg.type === 'pong') {
    if (msg.ts === undefined) return;
    const now = Date.now();
    rtt = now - msg.ts;
    latencyEl.textContent = `RTT: ${rtt.toFixed(0)} ms`;
  } else if (msg.type === 'snapshot') {
    // store snapshot for interpolation & processing
    // serverTime is trusted authoritative time
    pushSnapshot(msg);
    processSnapshotForReconciliation(msg);
  } else {
    // unknown message
    // console.log('srv msg', msg);
  }
}

/* When snapshot arrives: reconciliation for local player */
function processSnapshotForReconciliation(snapshot) {
  if (!joined || !myId) return;
  const serverPlayer = (snapshot.players || []).find(p => p.id === myId);
  if (!serverPlayer) return;

  // update scores display
  updateScoresDisplay(snapshot.players);

  // Reconciliation:
  // serverPlayer.lastInputSeq tells us which client inputs have been acknowledged.
  const ackSeq = serverPlayer.lastInputSeq || 0;

  // Remove confirmed pending inputs
  while (pendingInputs.length && pendingInputs[0].seq <= ackSeq) pendingInputs.shift();

  // Correct local predicted position to server's authoritative position
  // Then re-apply the remaining pending inputs to catch up
  const serverX = serverPlayer.x;
  const serverY = serverPlayer.y;

  // If difference is significant, we reconcile
  const dx = serverX - localState.x;
  const dy = serverY - localState.y;
  const dist2 = dx*dx + dy*dy;

  // If difference small, skip heavy correction (avoid jitter)
  if (dist2 > 0.0001) {
    // snap to server pos then reapply pending inputs sequentially
    localState.x = serverX;
    localState.y = serverY;

    // Reapply each pending input for CLIENT_SEND_RATE duration (approx)
    // We assume the server simulates per-tick, but client sends inputs each CLIENT_SEND_RATE ms.
    const dt = CLIENT_SEND_RATE / 1000;
    for (const pi of pendingInputs) {
      // apply movement predicted for the duration
      const dirLen = Math.hypot(pi.dx, pi.dy);
      let ndx = 0, ndy = 0;
      if (dirLen > 0.0001) { ndx = pi.dx / dirLen; ndy = pi.dy / dirLen; }
      localState.x += ndx * PLAYER_SPEED * dt;
      localState.y += ndy * PLAYER_SPEED * dt;
    }
  }

  // update local score from server authoritative value
  localState.score = serverPlayer.score;
}

/* Update scores UI neatly */
function updateScoresDisplay(playersArr) {
  if (!playersArr) return;
  const s = playersArr.map(p => `${p.name.slice(0,8)}:${p.score}`).join(' | ');
  scoresEl.textContent = `Scores: ${s}`;
}

/* Input handling (WASD + arrow keys) */
window.addEventListener('keydown', (ev) => {
  if (ev.key === 'w' || ev.key === 'ArrowUp') keys.up = true;
  if (ev.key === 's' || ev.key === 'ArrowDown') keys.down = true;
  if (ev.key === 'a' || ev.key === 'ArrowLeft') keys.left = true;
  if (ev.key === 'd' || ev.key === 'ArrowRight') keys.right = true;
  updateCurrentInputFromKeys();
});

window.addEventListener('keyup', (ev) => {
  if (ev.key === 'w' || ev.key === 'ArrowUp') keys.up = false;
  if (ev.key === 's' || ev.key === 'ArrowDown') keys.down = false;
  if (ev.key === 'a' || ev.key === 'ArrowLeft') keys.left = false;
  if (ev.key === 'd' || ev.key === 'ArrowRight') keys.right = false;
  updateCurrentInputFromKeys();
});

function updateCurrentInputFromKeys() {
  let dx = 0, dy = 0;
  if (keys.up) dy -= 1;
  if (keys.down) dy += 1;
  if (keys.left) dx -= 1;
  if (keys.right) dx += 1;
  currentInput.dx = dx;
  currentInput.dy = dy;
}

/* Periodic input sender (sends current intent every CLIENT_SEND_RATE ms) */
setInterval(() => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!joined) return;
  inputSeq++;
  const packet = { type: 'input', seq: inputSeq, dx: currentInput.dx, dy: currentInput.dy, ts: Date.now() };
  wsSend(packet);
  // store pending input for reconciliation (we assume this input covers next CLIENT_SEND_RATE ms)
  pendingInputs.push({ seq: inputSeq, dx: currentInput.dx, dy: currentInput.dy, ts: Date.now() });
}, CLIENT_SEND_RATE);

/* Local prediction: update localState each animation frame using current keys */
let lastFrameTs = performance.now();
function localPredictionStep(now) {
  const dt = (now - lastFrameTs) / 1000;
  lastFrameTs = now;

  // Apply velocity from currentInput
  const dirLen = Math.hypot(currentInput.dx, currentInput.dy);
  let ndx = 0, ndy = 0;
  if (dirLen > 0.0001) { ndx = currentInput.dx / dirLen; ndy = currentInput.dy / dirLen; }

  localState.x += ndx * PLAYER_SPEED * dt;
  localState.y += ndy * PLAYER_SPEED * dt;

  // clamp to canvas bounds (optional)
  localState.x = Math.max(0, Math.min(canvas.width, localState.x));
  localState.y = Math.max(0, Math.min(canvas.height, localState.y));
}

/* Interpolation for remote players */
function getRemoteEntityPositions(renderTime) {
  // find snapshots surrounding renderTime
  if (snapshotBuffer.length === 0) return null;
  // we want two snapshots s0, s1 such that s0.serverTime <= renderTime <= s1.serverTime
  // If renderTime is older than first snapshot, just use first; if newer than last, use last (or extrapolate).
  let s0Index = -1;
  for (let i = 0; i < snapshotBuffer.length - 1; i++) {
    const a = snapshotBuffer[i], b = snapshotBuffer[i+1];
    if (a.serverTime <= renderTime && renderTime <= b.serverTime) { s0Index = i; break; }
  }
  if (s0Index === -1) {
    // renderTime out of bounds
    const last = snapshotBuffer[snapshotBuffer.length - 1];
    // return last-known
    const positions = {};
    (last.players||[]).forEach(p => positions[p.id] = { x: p.x, y: p.y, score: p.score, name: p.name });
    return positions;
  }
  const a = snapshotBuffer[s0Index];
  const b = snapshotBuffer[s0Index+1];
  const t = (renderTime - a.serverTime) / Math.max(1, (b.serverTime - a.serverTime));
  // build map of positions for all players using interpolation
  const positions = {};
  const mapA = {}; a.players.forEach(p => mapA[p.id] = p);
  const mapB = {}; b.players.forEach(p => mapB[p.id] = p);
  const allIds = new Set([...Object.keys(mapA), ...Object.keys(mapB)]);
  allIds.forEach(id => {
    const pa = mapA[id] || { x:0,y:0,score:0, name: (mapB[id] && mapB[id].name) || 'unknown' };
    const pb = mapB[id] || pa;
    positions[id] = {
      x: lerp(pa.x, pb.x, t),
      y: lerp(pa.y, pb.y, t),
      score: pb.score || pa.score,
      name: (pa.name || pb.name || 'unknown')
    };
  });
  return positions;
}

/* Main render loop */
function render(now) {
  requestAnimationFrame(render);
  // local prediction step
  localPredictionStep(now);

  // compute renderTime for interpolation
  const renderTime = Date.now() - INTERPOLATION_DELAY;

  // get interpolated remote positions
  const remotePositions = getRemoteEntityPositions(renderTime);

  // draw
  ctx.clearRect(0,0,canvas.width,canvas.height);

  // draw coins from latest snapshot (use last snapshot)
  const latest = snapshotBuffer.length ? snapshotBuffer[snapshotBuffer.length - 1] : null;
  if (latest && latest.coins) {
    for (const coin of latest.coins) {
      drawCoin(coin.x, coin.y);
    }
  }

  // draw remote players (from interpolation), but skip local id (we'll draw it predicted)
  if (remotePositions) {
    for (const id in remotePositions) {
      if (id === myId) continue; // local player handled separately
      const p = remotePositions[id];
      drawPlayer(p.x, p.y, p.name, false);
    }
  }

  // draw local player predicted
  drawPlayer(localState.x, localState.y, localState.name || nameField.value, true);

  // optionally draw server authoritative ghost for local player (debug)
  if (debugMode && snapshotBuffer.length) {
    // find last snapshot player pos for me
    const lastSnap = snapshotBuffer[snapshotBuffer.length - 1];
    const serverP = (lastSnap.players || []).find(p => p.id === myId);
    if (serverP) {
      drawPlayer(serverP.x, serverP.y, 'SERVER', false, 0.6, '#ff77aa');
    }
  }

  // update debug text
  debugEl.textContent = [
    `joined: ${joined} id: ${myId || '-'}`,
    `pendingInputs: ${pendingInputs.length}`,
    `snapshots buffered: ${snapshotBuffer.length}`,
    `local pos: ${localState.x.toFixed(1)}, ${localState.y.toFixed(1)}`,
    `last serverTick: ${snapshotBuffer.length ? snapshotBuffer[snapshotBuffer.length-1].serverTick : '-'}`,
    `INTERP_DELAY: ${INTERPOLATION_DELAY}ms`,
    `CLIENT_SEND_RATE: ${CLIENT_SEND_RATE}ms`,
    `rtt (ms): ${rtt >= 0 ? rtt.toFixed(0) : '-'}`,
  ].join('\n');
}

/* Drawing helpers */
function drawPlayer(x,y,name,isLocal,alpha=1.0, color=null) {
  const radius = 12;
  ctx.save();
  ctx.globalAlpha = alpha;
  if (!color) color = isLocal ? '#6ee7b7' : '#60a5fa';
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI*2);
  ctx.fill();

  // name
  ctx.font = '12px monospace';
  ctx.fillStyle = '#fff';
  ctx.fillText(name, x - radius, y - radius - 6);

  // if local show score near
  if (isLocal) {
    ctx.fillStyle = '#ffd166';
    ctx.fillText(`Score: ${localState.score}`, 8, 18);
  }
  ctx.restore();
}

function drawCoin(x,y) {
  ctx.save();
  ctx.beginPath();
  ctx.fillStyle = '#f6e05e';
  ctx.arc(x, y, 8, 0, Math.PI*2);
  ctx.fill();
  ctx.restore();
}

/* UI wiring */
joinBtn.addEventListener('click', () => {
  if (!ws) connect();
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    statusEl.textContent = 'Status: connecting...';
    // wait for open, then join when open event fires (we keep a small retry)
    const int = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        clearInterval(int);
        sendJoin();
      }
    }, 100);
  } else {
    sendJoin();
  }
});

debugBtn.addEventListener('click', () => { debugMode = !debugMode; });

function sendJoin() {
  const name = nameField.value || 'Player';
  wsSend({ type: 'join', name });
  localState.name = name;
  statusEl.textContent = 'Status: join requested...';
}

/* Start animation */
requestAnimationFrame((t) => {
  lastFrameTs = t;
  render(t);
});

/* If you want autoset initial local pos to center until server joins */
localState.x = canvas.width / 2;
localState.y = canvas.height / 2;

/* expose a quick connect on load for convenience */
window.addEventListener('load', () => {
  // optionally auto-connect on load
  // connect();
});

/* If user closes tab, try to gracefully close socket */
window.addEventListener('beforeunload', () => {
  try { if (ws) ws.close(); } catch(e) {}
});

// config.js
module.exports = {
    PORT: 8081,                 // WebSocket server port
    TICK_RATE: 20,              // server ticks per second (20 Hz)
    LATENCY_MS: 200,            // simulated one-way latency in ms (CRITICAL requirement)
    LATENCY_JITTER_MS: 10,      // small jitter to make simulation realistic
    MAP_WIDTH: 800,             // world bounds (units)
    MAP_HEIGHT: 600,
    PLAYER_SPEED: 120,          // units per second
    PICKUP_RADIUS: 16,          // collision radius for coin pickup (units)
    COIN_SPAWN_INTERVAL_MS: 2500, // spawn coin roughly every 2.5 seconds
    MAX_COINS: 10,              // maximum coins at once
    SNAPSHOT_BROADCAST_RATE: 1, // how many server ticks between snapshots (1 => every tick)
    MAX_PLAYERS: 8,             // server limit (optional)
    DEBUG: true                 // set to false to reduce console logs
  };
  
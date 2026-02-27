/* FULL FILE WITH KILL LOGIC ADDED — NOTHING ELSE CHANGED */

import express from "express";
import http from "http";
import { Server } from "socket.io";
import attachWhatsAppRoutes from './whatsappReminders.js';
import dotenv from "dotenv";
import cors from "cors";
import authRoutes from "./routes/authRoutes.js";
import tournamentRoutes from "./routes/tournamentRoutes.js";
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import supabase from "./supabaseClient.js";
import { loadTournaments, saveTournaments } from './persistentStore.js';
import { getPath, safeCells } from "./paths.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Attach WhatsApp reminder routes (optional; requires TWILIO_* env vars)
try {
  attachWhatsAppRoutes(app);
} catch (e) {
  console.warn('WhatsApp reminders not attached:', e && e.message);
}

// Supabase verification (optional)
if (supabase) {
  try {
    const { data, error } = await supabase.from("users").select("count", { count: "exact" }).limit(1);
    if (error) throw error;
    console.log("✅ Supabase Connected");
  } catch (err) {
    console.warn("⚠️ Supabase connection failed — running with in-memory fallback:", err.message);
  }
} else {
  console.warn("⚠️ Supabase client not configured — running with in-memory fallback");
}

const server = http.createServer(app);
const PORT = process.env.PORT || 3001;

// CORS origins: localhost for dev, dynamically allow all for production
const CORS_ORIGINS = process.env.NODE_ENV === 'production' 
  ? '*'  // Allow all origins in production (or specify your domain)
  : [
      "http://localhost:3000",
      "http://localhost:3002",
      "http://127.0.0.1:3000",
      "http://127.0.0.1:3002",
    ];

const io = new Server(server, {
  cors: {
    origin: CORS_ORIGINS,
    methods: ["GET", "POST"],
    credentials: process.env.NODE_ENV !== 'production', // true for dev, false for prod (with * origin)
  },
});

// Expose socket instance to route handlers via `req.app.locals.io`
app.locals.io = io;

// --- serve client build when available (optional) -------------------------
// If you build the React client and copy the `build` folder into the server
// directory, Express will serve the UI automatically. This attempts to serve
// the static files whenever the `build` directory exists (not only in
// `NODE_ENV=production`) so hosting platforms that run different envs still
// serve the client if present.
const buildPath = path.resolve('./build');
if (fs.existsSync(buildPath)) {
  app.use(express.static(buildPath));
  // serve index.html for any unknown route (client-side routing)
  app.get('*', (req, res) => {
    res.sendFile(path.join(buildPath, 'index.html'));
  });
  console.log('📦 Serving static files from', buildPath);
} else {
  console.warn('⚠️ build directory not found, skipping static serve');
}

// ✅ REST API Routes
app.use("/api/auth", authRoutes);
app.use("/api/tournaments", tournamentRoutes);

// Persistent special keys file path (relative to the server folder)
const SPECIAL_KEYS_FILE = path.resolve('./data/specialKeys.json');

function loadSpecialKeysFromFile() {
  try {
    if (!fs.existsSync(SPECIAL_KEYS_FILE)) return new Map();
    const raw = fs.readFileSync(SPECIAL_KEYS_FILE, 'utf8');
    const arr = JSON.parse(raw || '[]');
    const now = Date.now();
    const m = new Map();
    for (const it of arr || []) {
      if (!it || !it.key) continue;
      // ignore expired entries
      if (it.expires && Number(it.expires) <= now) continue;
      m.set(String(it.key), { used: !!it.used, expires: Number(it.expires) });
    }
    try { console.log(`🔁 Loaded ${m.size} special keys from ${SPECIAL_KEYS_FILE}`); } catch (e) {}
    return m;
  } catch (e) {
    console.warn('Failed to load specialKeys from file:', e && e.message);
    return new Map();
  }
}

function saveSpecialKeysToFile(map) {
  try {
    const arr = Array.from(map.entries()).map(([key, rec]) => ({ key, used: !!rec.used, expires: rec.expires }));
    fs.mkdirSync(path.dirname(SPECIAL_KEYS_FILE), { recursive: true });
    fs.writeFileSync(SPECIAL_KEYS_FILE, JSON.stringify(arr, null, 2), 'utf8');
  } catch (e) {
    console.warn('Failed to save specialKeys to file:', e && e.message);
  }
}

// Load persisted keys on startup (filtering expired)
const specialKeys = loadSpecialKeysFromFile();

function generate16DigitKey() {
  // generate secure 16-digit numeric string
  const buf = crypto.randomBytes(8); // 8 bytes = 64 bits
  // convert to positive 16-digit number string (pad if needed)
  const num = BigInt('0x' + buf.toString('hex')) % BigInt(10 ** 16);
  return String(num).padStart(16, '0');
}

// Admin endpoint: generate a single-use 16-digit key valid for 5 minutes
app.post('/api/admin/generate-key', (req, res) => {
  try {
    const expected = String(process.env.ADMIN_PHONE || '');
    const header = req.header('x-admin-phone') || '';
    if (expected && header !== expected) {
      return res.status(403).json({ error: 'Forbidden: invalid admin header' });
    }

    const key = generate16DigitKey();
    const ttl = 5 * 60 * 1000; // 5 minutes (reduced expiry)
    const expires = Date.now() + ttl;
    specialKeys.set(key, { used: false, expires });
    // cleanup after expiry
    setTimeout(() => {
      specialKeys.delete(key);
      try { saveSpecialKeysToFile(specialKeys); } catch (e) {}
    }, ttl + 1000);

    // persist keys to disk
    try { saveSpecialKeysToFile(specialKeys); } catch (e) {}

    // Debug log: show generated key and expiry so admin can verify server state
    try { console.log(`🔑 Generated special key=${key} expires=${new Date(expires).toISOString()}`); } catch (e) {}

    return res.json({ key, expiresAt: new Date(expires).toISOString() });
  } catch (e) {
    console.error('generate-key failed:', e && e.message);
    return res.status(500).json({ error: 'generate failed' });
  }
});

// Optional: validate key via HTTP (returns 200 if valid, marks used=false)
app.post('/api/admin/validate-key', (req, res) => {
  try {
    const { key } = req.body || {};
    if (!key) return res.status(400).json({ error: 'missing key' });
    const record = specialKeys.get(key);
    if (!record) return res.status(404).json({ error: 'invalid or expired' });
    if (record.used) return res.status(410).json({ error: 'already used' });
    if (Date.now() > record.expires) return res.status(404).json({ error: 'expired' });
    return res.json({ valid: true, expiresAt: new Date(record.expires).toISOString() });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'validate failed' });
  }
});

// DEV DEBUG: list current special admin keys (dev-only)
app.get('/api/admin/keys', (req, res) => {
  try {
    if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'not found' });
    const out = Array.from(specialKeys.entries()).map(([key, rec]) => ({ key, used: !!rec.used, expires: new Date(rec.expires).toISOString() }));
    return res.json({ keys: out });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'failed' });
  }
});

// Additional debug route that won't conflict with the mounted tournaments router
app.get('/api/debug/tournaments', async (req, res) => {
  console.log(`HTTP GET /api/debug/tournaments from ${req.ip} at ${new Date().toISOString()}`);
  try {
    try {
      const { data, error } = await supabase.from('tournaments').select('*').order('created_at', { ascending: false }).limit(50);
      console.log('Debug: supabase returned', (Array.isArray(data) ? data.length : 'no-data'), 'rows, error=', error);
      if (!error && Array.isArray(data)) {
        return res.json({ source: 'supabase', tournaments: data });
      }
    } catch (e) {
      console.warn('Debug: supabase query threw, will return in-memory tournaments:', e && e.message);
    }
    // When Supabase is not available we fall back to the local disk-backed
    // store (`server/data/tournaments.json`) via `persistentStore`. Load
    // the persisted file on each request so HTTP deletes (which update the
    // persisted file) are reflected immediately.
    const mem = loadTournaments() || {};
    return res.json({ source: 'disk', tournaments: Object.values(mem) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Debug: expose in-memory tournaments and Supabase fallback info
app.get('/api/tournaments/debug-info', async (req, res) => {
  console.log(`HTTP GET /api/tournaments/debug from ${req.ip} at ${new Date().toISOString()}`);
  try {
      // Try to read from Supabase first (if available)
    try {
      const { data, error } = await supabase.from('tournaments').select('*').order('created_at', { ascending: false }).limit(50);
      console.log('Debug: supabase returned', (Array.isArray(data) ? data.length : 'no-data'), 'rows, error=', error);
      if (!error && Array.isArray(data)) {
        console.log('Debug: returning supabase tournaments count=', data.length);
          return res.json({ source: 'supabase', tournaments: data });
      }
    } catch (e) {
      // ignore supabase errors — we'll return in-memory
      console.warn('Debug: supabase query threw, will return in-memory tournaments:', e && e.message);
    }

    // Fall back to the local disk-backed store if Supabase not available.
    // Read persisted store on each request to avoid stale in-memory copies.
      const mem = loadTournaments() || {};
      return res.json({ source: 'disk', tournaments: Object.values(mem) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Debug: delete tournaments by name (memory + supabase if available)
app.delete('/api/tournaments/debug/delete-by-name/:name', async (req, res) => {
  const raw = req.params.name || '';
  const name = decodeURIComponent(raw);
  console.log(`DEBUG DELETE BY NAME requested: ${name}`);
  const deleted = [];
  try {
    // Try Supabase first if configured
    if (supabase) {
      try {
        const { data: supDel, error: supErr } = await supabase.from('tournaments').delete().ilike('name', name).select();
        if (supErr) console.warn('Supabase delete-by-name warning:', supErr.message || supErr);
        if (Array.isArray(supDel) && supDel.length) {
          supDel.forEach((t) => deleted.push({ id: t.id, source: 'supabase' }));
        }
      } catch (e) {
        console.warn('Supabase delete-by-name threw:', e && e.message);
      }
    }

    // Delete from local in-memory/disk store
    try {
      const mem = tournamentsMemory || {};
      const keys = Object.keys(mem).filter((k) => String(mem[k]?.name) === String(name));
      for (const k of keys) {
        deleted.push({ id: k, source: 'memory' });
        delete mem[k];
      }
      if (keys.length) {
        // persist
        saveTournaments(mem);
        tournamentsMemory = mem;
      }
    } catch (e) {
      console.warn('Memory delete-by-name failed:', e && e.message);
    }

    if (deleted.length === 0) return res.status(404).json({ error: 'No tournaments found with that name' });
    return res.json({ deleted });
  } catch (err) {
    console.error('DEBUG delete-by-name failed:', err && err.message);
    return res.status(500).json({ error: err?.message || 'delete failed' });
  }
});

// Migrate in-memory tournaments into Supabase (if configured)
app.post('/api/tournaments/migrate-memory', async (req, res) => {
  try {
    const keys = Object.keys(tournamentsMemory || {});
    if (!keys.length) return res.json({ migrated: 0, message: 'No in-memory tournaments to migrate' });

    // Ensure Supabase is reachable and schema exists
    try {
      await supabase.from('tournaments').select('id').limit(1);
    } catch (e) {
      return res.status(500).json({ error: 'Supabase not available or schema missing. Run SQL schema first.' });
    }

    const report = [];
    for (const id of keys) {
      const t = tournamentsMemory[id];
      if (!t) continue;

      try {
        // Skip if already exists
        try {
          const { data: existing } = await supabase.from('tournaments').select('*').eq('id', t.id).single();
          if (existing) {
            report.push({ id: t.id, status: 'skipped - already exists' });
            continue;
          }
        } catch (e) {
          // ignore select errors and proceed
        }

        const payload = { id: t.id, name: t.name, total_players: t.total_players || 256, creator: t.creator || null, status: t.status || 'waiting', created_at: t.created_at };
        const { data: inserted, error: insErr } = await supabase.from('tournaments').insert([payload]).select().single();
        if (insErr) throw insErr;

        // Insert players if present
        if (Array.isArray(t.players) && t.players.length) {
          const pl = t.players.map((p) => ({ tournament_id: inserted.id, player_id: p.player_id || p.id || p.playerId || makeId('p_'), player_name: p.player_name || p.playerName || p.name || 'Player', joined_at: p.joined_at || new Date().toISOString() }));
          try {
            await supabase.from('tournament_players').insert(pl);
          } catch (pe) {
            // non-fatal
          }
        }

        // Insert matches if present
        if (Array.isArray(t.matches) && t.matches.length) {
          for (const m of t.matches) {
            const mpayload = { tournament_id: inserted.id, round_number: m.round_number || 1, match_index: m.match_index || 1, room_code: m.room_code || makeId('match_'), players: m.players || [], status: m.status || 'scheduled' };
            try {
              await supabase.from('tournament_matches').insert([mpayload]);
            } catch (me) {
              // ignore per-match errors
            }
          }
        }

        report.push({ id: t.id, status: 'migrated' });
      } catch (err) {
        report.push({ id: t.id, status: `error: ${err?.message || err}` });
      }
    }

    return res.json({ migrated: report.length, details: report });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Helper: small id generator for room codes / match ids
function makeId(prefix = '') {
  return `${prefix}${Math.random().toString(36).slice(2, 9)}`;
}

// 🧠 In-memory Ludo game state
let rooms = {};
// In-memory tournaments fallback when Supabase schema/tables are missing
let tournamentsMemory = loadTournaments() || {};
// Track scheduled match rooms for auto-start when players join
let matchRooms = {}; // { [roomCode]: { expected: number, connected: Set<socketId>, startTimer: Timeout|null } }

/**
 * Schedule the match to start automatically when enough players are connected.
 * - roomCode: match room code
 * - meta: { tournamentId, matchId, expected } used when emitting startMatch
 */
function maybeScheduleMatchStart(roomCode, meta = {}) {
  try {
    const info = matchRooms[roomCode];
    if (!info) return;

    const connectedCount = info.connected.size;
    // Determine expected players robustly: prefer explicit info.expected, then meta.expected,
    // then actual room player count (if available), finally fallback to 4.
    let expected = Number(info.expected) || Number(meta.expected) || 0;
    try {
      if (!expected) {
        const actual = getPlayerCount(roomCode);
        expected = Number(actual) || 0;
      }
    } catch (e) {}
    if (!expected || expected < 2) expected = Number(meta.expected) || 4;
    // persist normalized expected so future checks use consistent value
    info.expected = expected;

    // If already scheduled and enough players, do nothing (timer already set).
    if (info.startTimer) {
      // If we fell below expected after scheduling, cancel
      if (connectedCount < expected) {
        clearTimeout(info.startTimer);
        info.startTimer = null;
        io.to(roomCode).emit('matchStartCancelled', { roomCode, reason: 'players_left' });
        console.log(`⏸️ Cancelled match start for ${roomCode} (players left)`);
      }
      return;
    }

    // If now meet threshold, schedule start in 5 seconds
    if (connectedCount >= expected && !info.startTimer) {
      info.startTimer = setTimeout(() => {
        info.startTimer = null;
        try {
          io.to(roomCode).emit('startMatch', { roomCode, tournamentId: meta.tournamentId, matchId: meta.matchId });
          console.log(`🚀 startMatch emitted for ${roomCode} (auto-start after all players joined)`);
        } catch (e) {
          console.warn('Failed to emit startMatch for', roomCode, e && e.message);
        }
      }, 5000); // 5 seconds
      console.log(`⏱️ Scheduled start for ${roomCode} in 5s (players=${connectedCount}/${expected})`);
      // Also notify the room that match will start soon
      io.to(roomCode).emit('matchWillStart', { roomCode, countdown: 5 });
    }
  } catch (e) {
    console.warn('maybeScheduleMatchStart error:', e && e.message);
  }
}

// Helper: return number of players in a room
function getPlayerCount(roomCode) {
  const r = rooms[roomCode];
  return r ? r.players.length : 0;
}

// Helper: keep room.turn in sync with turnIndex
function updateRoomTurn(room) {
  if (!room) return;
  const idx = typeof room.turnIndex === 'number' ? room.turnIndex : 0;
  // Prefer an explicit turnOrder (array of player ids) when present
  try {
    const order = Array.isArray(room.turnOrder) && room.turnOrder.length ? room.turnOrder : null;
    if (order) {
      const pid = order[idx % order.length];
      room.turn = (room.players && room.players.length > 0) ? room.players.find((p) => p.id === pid) : null;
    } else {
      room.turn = (room.players && room.players.length > 0) ? room.players[idx % room.players.length] : null;
    }
  } catch (e) {
    room.turn = (room.players && room.players.length > 0) ? room.players[idx % room.players.length] : null;
  }
}

// Helper: check win conditions and return winners array (in order of finishing)
function checkWinCondition(room) {
  if (!room || !room.players) return null;

  // Find players who have all 4 tokens finished
  const finishedPlayers = room.players
    .map((p, idx) => ({
      player: p,
      index: idx,
      allFinished: Array.isArray(p.tokens) && p.tokens.length ? p.tokens.every((t) => t.isFinished === true) : false,
    }))
    .filter((entry) => entry.allFinished);

  if (finishedPlayers.length === 0) return null;

  const playerCount = room.players.length;
  const winnersNeeded = playerCount === 2 ? 1 : playerCount === 3 ? 2 : playerCount === 4 ? 3 : 1;

  if (finishedPlayers.length >= winnersNeeded) {
    // Game should end — return the finished players in order of finishing (using finishOrder)
    // Sort by finish position to ensure correct order
    const sortedWinners = finishedPlayers.sort((a, b) => {
      const posA = a.player.finishPosition || 999;
      const posB = b.player.finishPosition || 999;
      return posA - posB;
    });
    return sortedWinners.slice(0, winnersNeeded);
  }

  return null;
}


// Helper: assign tokens, initial dice and turn order for players in a room
function assignTokensAndInitRoom(room) {
  const playerCount = room.players.length;
  // Get the clockwise color order based on number of players
  let colors;
  if (playerCount === 2) {
    colors = ["blue", "green"];
  } else if (playerCount === 3) {
    colors = ["blue", "red", "green"];
  } else {
    colors = ["blue", "red", "green", "yellow"];
  }

  console.log(`🔄 assignTokensAndInitRoom: playerCount=${playerCount}, colors=${colors.join(',')}`);
  console.log(`   BEFORE re-assign: ${room.players.map(p => `${p.name}(${p.color})`).join(', ')}`);

  // ⭐ CRITICAL: Re-assign colors based on expected count, not what clients sent
  // This ensures 2 players get blue/green, not blue/red
  const usedColors = new Set();
  room.players.forEach((player, idx) => {
    // Find the next available color from the proper order
    let assignedColor = colors[0];
    for (const color of colors) {
      if (!usedColors.has(color)) {
        assignedColor = color;
        break;
      }
    }
    console.log(`   Player ${idx}: ${player.name} → ${assignedColor} (was ${player.color})`);
    player.color = assignedColor;
    usedColors.add(assignedColor);
  });

  console.log(`   AFTER re-assign: ${room.players.map(p => `${p.name}(${p.color})`).join(', ')}`);

  // Initialize tokens for each player
  room.players.forEach((player) => {
    player.tokens = Array(4)
      .fill(null)
      .map((_, i) => ({ id: `T${i + 1}`, position: -1, isFinished: false }));
    player.consecutiveSixes = 0;
  });

  try {
    console.log("Players in room:", room.players.map(p => ({ id: p.id, name: p.name, color: p.color })));
  } catch (e) {}

  room.dice = 1;
  room.turnIndex = 0;

  if (room.players.length > 0) {
    room.players[0].isHost = true;
  }

  // Sort players into proper clockwise order based on their colors
  try {
    room.players.sort((a, b) => colors.indexOf(a.color) - colors.indexOf(b.color));
    console.log("After sorting by color order:", room.players.map(p => p.color));
  } catch (e) {}

  // Reset turn index and sync the current turn
  room.turnIndex = 0;
  // Build explicit turnOrder (player ids) in clockwise color order
  try {
    room.turnOrder = room.players.map((p) => p.id);
  } catch (e) {
    room.turnOrder = null;
  }

  updateRoomTurn(room);

  return room;
}

io.on("connection", (socket) => {
  console.log("🟢 Client connected:", socket.id);

  socket.on("joinGame", (roomId) => {
    socket.join(roomId);
    if (!rooms[roomId]) {
      rooms[roomId] = { players: [], dice: 1, turnIndex: 0 };
    }

    const room = rooms[roomId];
    if (room.players.length < 4 && !room.players.find((p) => p.id === socket.id)) {
      const newPlayer = {
        id: socket.id,
        name: `Player${room.players.length + 1}`,
        tokens: Array(4)
          .fill(null)
          .map((_, i) => ({ id: `T${i + 1}`, position: -1, isFinished: false })),
        consecutiveSixes: 0,
      };
      room.players.push(newPlayer);
    }

    updateRoomTurn(room);
    io.to(roomId).emit("gameState", room);
    console.log(`👥 ${socket.id} joined room ${roomId}`);
  });

  // Create a new room (lobby)
  socket.on("createRoom", ({ username, roomCode }) => {
    if (!roomCode) return socket.emit("errorMessage", "Invalid room code");
    if (rooms[roomCode]) return socket.emit("errorMessage", "Room already exists");

    rooms[roomCode] = { players: [], dice: 1, turnIndex: 0 };
    updateRoomTurn(rooms[roomCode]);
    socket.join(roomCode);
    const newPlayer = { 
      id: socket.id, 
      name: username || "Player1", 
      isHost: true, 
      color: "blue",  // Host always gets blue
      consecutiveSixes: 0 
    };
    rooms[roomCode].players.push(newPlayer);

    // Send roomCreated + updated player list to creator
    socket.emit("roomCreated", { roomCode });
    socket.emit("roomUpdate", rooms[roomCode].players); // ensure creator sees themselves
    // Broadcast to room (though only creator is in it initially)
    io.to(roomCode).emit("roomUpdate", rooms[roomCode].players);
    console.log(`🆕 Room ${roomCode} created by ${socket.id} (${username}) - BLUE`);
  });

  // Join an existing room (lobby)
  socket.on("joinRoom", ({ username, roomCode }) => {
    const r = rooms[roomCode];
    if (!r) return socket.emit("errorMessage", "Room not found");
    if (r.players.length >= 4) return socket.emit("errorMessage", "Room is full");

    socket.join(roomCode);
    
    // Assign colors based on number of players that will be in the room
    const futurePlayerCount = r.players.length + 1;
    let colorOrder;
    if (futurePlayerCount === 2) {
      colorOrder = ["blue", "green"];
    } else if (futurePlayerCount === 3) {
      colorOrder = ["blue", "red", "green"];
    } else {
      colorOrder = ["blue", "red", "green", "yellow"];
    }
    
    console.log(`📥 joinRoom: futurePlayerCount=${futurePlayerCount}, colorOrder=${colorOrder.join(',')}, current players: ${r.players.map(p => p.color).join(',')}`);
    
    const usedColors = new Set(r.players.map(p => p.color));
    let assignedColor = "blue";
    for (const color of colorOrder) {
      if (!usedColors.has(color)) {
        assignedColor = color;
        break;
      }
    }
    
    console.log(`   → Assigned ${assignedColor} (usedColors: ${Array.from(usedColors).join(',')})`);
    
    const player = { 
      id: socket.id, 
      name: username || `Player${r.players.length + 1}`, 
      isHost: false, 
      color: assignedColor,
      consecutiveSixes: 0 
    };
    r.players.push(player);

    // Send roomJoined + updated player list to joining player
    socket.emit("roomJoined", { roomCode });
    socket.emit("roomUpdate", r.players); // ensure joining player gets the list
    // Broadcast to all other players in room
    io.to(roomCode).emit("roomUpdate", r.players);
    console.log(`👥 ${socket.id} (${username}) joined lobby ${roomCode} as ${assignedColor.toUpperCase()}, total players: ${r.players.length}`);
  });

  socket.on("ensureJoin", (payload) => {
    try {
      const roomCode = typeof payload === 'string' ? payload : payload?.roomCode;
      const name = payload?.name;
      if (!roomCode) return;
      socket.join(roomCode);
      console.log(`🔗 ensureJoin: socket ${socket.id} joined room ${roomCode} (name=${name || 'unknown'})`);

      const room = rooms[roomCode];
      if (room) {
        if (name) {
          const existing = room.players.find((p) => p.name === name || p.id === socket.id);
          if (existing) {
            console.log(`🔄 Reconciled player id for ${name}: ${existing.id} -> ${socket.id}`);
            existing.id = socket.id;
          } else {
            if (room.players.length < 4 && !room.players.find((p) => p.id === socket.id)) {
              const newPlayer = { id: socket.id, name: name, isHost: false, tokens: Array(4).fill(null).map((_, i) => ({ id: `T${i+1}`, position: -1, isFinished: false })), consecutiveSixes: 0 };
              room.players.push(newPlayer);
              console.log(`➕ Added missing player ${name} to room ${roomCode} with id ${socket.id}`);
            }
          }
        }

        updateRoomTurn(room);
        socket.emit("gameState", room);
        io.to(roomCode).emit("roomUpdate", room.players);
      }
    } catch (err) {
      console.error("ensureJoin error:", err.message);
    }
  });

  // Start match from lobby
  socket.on("startMatch", (payload) => {
    const roomCode = typeof payload === 'string' ? payload : payload?.roomCode;
    const tournamentId = typeof payload === 'object' ? payload?.tournamentId : undefined;
    const matchId = typeof payload === 'object' ? payload?.matchId : undefined;

    const r = rooms[roomCode];
    if (!r) return socket.emit("errorMessage", "Room not found");

    // require at least 2 players to start
    if (r.players.length < 2) return socket.emit("errorMessage", "Need 2 players!");

    console.log(`🎬 startMatch called for room ${roomCode}`);
    console.log(`   Players BEFORE assignTokensAndInitRoom: ${r.players.map(p => `${p.name}(${p.color})`).join(', ')}`);

    // Store tournament metadata if provided
    if (tournamentId) r.tournamentId = tournamentId;
    if (matchId) r.matchId = matchId;

    // Assign tokens, colors, dice and starting turn based on joined players
    assignTokensAndInitRoom(r);

    // Emit match start and initial game state to clients
    io.to(roomCode).emit("matchStarted");
    // Debug: log the players order and assigned colors to verify clockwise ordering
    try {
      console.log("🏁 matchStarted - players order:", r.players.map(p => ({ id: p.id, name: p.name, color: p.color })));
    } catch (e) {}
    // ensure turn is present and add roomCode to gameState for filtering
    updateRoomTurn(r);
    r.roomCode = roomCode; // add roomCode to gameState for client filtering
    io.to(roomCode).emit("gameState", r);
    io.emit("gameState", r); // broadcast to all clients (they filter by roomCode)
    io.to(roomCode).emit("roomUpdate", r.players);
    console.log(`🚀 Match started in room ${roomCode} with ${r.players.length} players` + (tournamentId ? ` (tournament=${tournamentId}, match=${matchId})` : ''));
  });

  // -----------------------------
  // Tournament: server-driven flow
  // -----------------------------

  socket.on('createTournament', async (payload) => {
    try {
      console.log('⤴️ Received createTournament from', socket.id, 'payload=', payload);
      const name = payload?.name || `Tournament ${new Date().toISOString()}`;
      const total_players = payload?.total_players || 256;
      const creator = payload?.creator || socket.id;
      // Try to persist in Supabase, but fall back to in-memory when the table/schema isn't available
      try {
        const { data, error } = await supabase.from('tournaments').insert([{ name, total_players, creator, status: 'waiting' }]).select().single();
        if (error) throw error;
        const t = data;
        const troom = `tournament_${t.id}`;
        socket.join(troom);
        socket.emit('tournamentCreated', { tournament: t });
        io.to(troom).emit('tournamentUpdate', { tournament: t, players: [] });
        // Notify all connected clients that a new tournament was created so UIs can update in real-time
        io.emit('tournamentAdded', { tournament: t });
        console.log(`🏆 Tournament created ${t.id} by ${socket.id} (supabase)`);
        console.log('⤵️ Emitting tournamentCreated and tournamentAdded for', t.id);
        return;
      } catch (supErr) {
        console.warn('Supabase createTournament failed, falling back to in-memory:', supErr?.message || supErr);
        // Create an in-memory tournament so client flow works during development/tests
        const t = {
          id: makeId('t_'),
          name,
          total_players,
          creator,
          status: 'waiting',
          created_at: new Date().toISOString(),
          players: [],
          matches: [],
        };
        tournamentsMemory[t.id] = t;
        try { saveTournaments(tournamentsMemory); } catch (e) {}
        const troom = `tournament_${t.id}`;
        socket.join(troom);
        socket.emit('tournamentCreated', { tournament: t });
        io.to(troom).emit('tournamentUpdate', { tournament: t, players: [] });
        // Notify all connected clients that a new in-memory tournament was created
        io.emit('tournamentAdded', { tournament: t });
        console.log(`🏆 Tournament created in-memory ${t.id} by ${socket.id}`);
        console.log('⤵️ Emitting tournamentCreated and tournamentAdded for (in-memory)', t.id);
        return;
      }
    } catch (err) {
      console.error('createTournament error:', err.message);
      socket.emit('errorMessage', 'createTournament failed');
    }
  });

  socket.on('joinTournament', async (payload, callback) => {
    try {
      const { tournamentId, playerName, joinKey, playerPhone } = payload || {};
      if (!tournamentId) {
        const msg = 'joinTournament: missing tournamentId';
        try { if (callback) callback({ error: msg }); } catch (e) {}
        return socket.emit('errorMessage', msg);
      }

      // If a joinKey is provided, validate it (one-time, 5-minute TTL)
      if (joinKey) {
        try {
          let rec = specialKeys.get(String(joinKey));
          try { console.log(`🔍 Validating joinKey=${joinKey} found=${!!rec} time=${new Date().toISOString()}`); } catch (e) {}
          // If not found in-memory, attempt to read persisted file to recover
          if (!rec) {
            try {
              if (fs.existsSync(SPECIAL_KEYS_FILE)) {
                const raw = fs.readFileSync(SPECIAL_KEYS_FILE, 'utf8') || '[]';
                const arr = JSON.parse(raw || '[]');
                const found = (arr || []).find((it) => String(it?.key) === String(joinKey));
                if (found) {
                  rec = { used: !!found.used, expires: Number(found.expires) };
                  specialKeys.set(String(joinKey), rec);
                  try { console.log(`🔁 Recovered key from file: ${joinKey} used=${rec.used} expires=${new Date(rec.expires).toISOString()}`); } catch (e) {}
                }
              }
            } catch (e) {
              console.warn('Failed to recover key from file:', e && e.message);
            }
          }

          if (!rec) {
            const msg = 'Invalid or expired special key';
            try { if (callback) callback({ error: msg }); } catch (e) {}
            try { console.log(`⚠️ joinTournament: key not found: ${joinKey}`); } catch (e) {}
            return socket.emit('errorMessage', msg);
          }
          try { console.log(`ℹ️ key record: used=${!!rec.used} expires=${new Date(rec.expires).toISOString()}`); } catch (e) {}
          if (rec.used) {
            const msg = 'Special key already used';
            try { if (callback) callback({ error: msg }); } catch (e) {}
            try { console.log(`⚠️ joinTournament: key already used: ${joinKey}`); } catch (e) {}
            return socket.emit('errorMessage', msg);
          }
          if (Date.now() > rec.expires) {
            specialKeys.delete(String(joinKey));
            try { saveSpecialKeysToFile(specialKeys); } catch (e) {}
            const msg = 'Special key expired';
            try { if (callback) callback({ error: msg }); } catch (e) {}
            try { console.log(`⚠️ joinTournament: key expired: ${joinKey} now=${new Date().toISOString()} expires=${new Date(rec.expires).toISOString()}`); } catch (e) {}
            return socket.emit('errorMessage', msg);
          }
          // mark used
          rec.used = true;
          specialKeys.set(String(joinKey), rec);
          try { saveSpecialKeysToFile(specialKeys); } catch (e) {}
          socket.emit('specialKeyAccepted', { key: String(joinKey) });
        } catch (e) {
          console.warn('joinTournament key validation failed:', e && e.message);
          return socket.emit('errorMessage', 'Special key validation error');
        }
      }
      // Try reading tournament from Supabase; if table missing or no result, fall back to in-memory
      let tournamentRow = null;
      try {
        const { data: t } = await supabase.from('tournaments').select('*').eq('id', tournamentId).single();
        tournamentRow = t || null;
      } catch (supErr) {
        console.warn('Supabase select tournaments failed, checking in-memory:', supErr?.message || supErr);
      }

      // If not found in Supabase, check in-memory store
      if (!tournamentRow) {
        if (!tournamentsMemory[tournamentId]) {
          const msg = 'Tournament not found';
          try { if (callback) callback({ error: msg }); } catch (e) {}
          return socket.emit('errorMessage', msg);
        }
        // add player into in-memory tournament (include phone if provided)
        const p = { tournament_id: tournamentId, player_id: socket.id, player_name: playerName || socket.id, joined_at: new Date().toISOString() };
        if (playerPhone) p.phone = playerPhone;
        tournamentsMemory[tournamentId].players.push(p);
        try { saveTournaments(tournamentsMemory); } catch (e) {}
        const troom = `tournament_${tournamentId}`;
        socket.join(troom);
        io.to(troom).emit('tournamentUpdate', { tournament: tournamentsMemory[tournamentId], players: tournamentsMemory[tournamentId].players });
        socket.emit('joinedTournament', { tournament: tournamentsMemory[tournamentId], player: p });
        try { if (callback) callback({ ok: true, tournament: tournamentsMemory[tournamentId], player: p }); } catch (e) {}
        console.log(`➕ ${socket.id} joined in-memory tournament ${tournamentId} as ${playerName}`);
        return;
      }

      // Persist player into Supabase
      const playerPayload = { tournament_id: tournamentId, player_id: socket.id, player_name: playerName || socket.id };
      const { data: pData, error: pErr } = await supabase.from('tournament_players').insert([playerPayload]).select().single();
      if (pErr) {
        const msg = `joinTournament failed: ${pErr.message}`;
        try { if (callback) callback({ error: msg }); } catch (e) {}
        return socket.emit('errorMessage', msg);
      }

      const troom = `tournament_${tournamentId}`;
      socket.join(troom);

      // fetch current players to broadcast
      const { data: players } = await supabase.from('tournament_players').select('*').eq('tournament_id', tournamentId);
      // attach phone for the joining player if provided by client (can't persist if column missing)
      const playersWithPhone = Array.isArray(players) ? players.map((pl) => {
        if (pl.player_id === socket.id && playerPhone) return { ...pl, phone: playerPhone };
        return pl;
      }) : players;
      io.to(troom).emit('tournamentUpdate', { tournament: tournamentRow, players: playersWithPhone });
      // include phone on immediate joined event
      const joinedPayload = pData && playerPhone ? { ...pData, phone: playerPhone } : pData;
      socket.emit('joinedTournament', { tournament: tournamentRow, player: joinedPayload });
      try { if (callback) callback({ ok: true, tournament: tournamentRow, player: pData }); } catch (e) {}
      console.log(`➕ ${socket.id} joined tournament ${tournamentId} as ${playerName}`);
    } catch (err) {
      console.error('joinTournament error:', err.message);
      const msg = 'joinTournament failed';
      try { if (callback) callback({ error: msg }); } catch (e) {}
      socket.emit('errorMessage', msg);
    }
  });

  // startTournament: schedule round 1 matches and auto-create rooms and invite players
  socket.on('startTournament', async ({ tournamentId }) => {
    try {
      if (!tournamentId) return socket.emit('errorMessage', 'startTournament: missing id');
      // Try to fetch tournament and players from Supabase; if not available, check in-memory fallback
      let t = null;
      let players = null;
      try {
        const { data: trow } = await supabase.from('tournaments').select('*').eq('id', tournamentId).single();
        t = trow || null;
        const { data: prow } = await supabase.from('tournament_players').select('*').eq('tournament_id', tournamentId);
        players = prow || [];
      } catch (supErr) {
        console.warn('Supabase startTournament failed, checking in-memory:', supErr?.message || supErr);
      }

      if (!t) {
        if (!tournamentsMemory[tournamentId]) return socket.emit('errorMessage', 'Tournament not found');
        t = tournamentsMemory[tournamentId];
        players = tournamentsMemory[tournamentId].players || [];
      }

      if (!players || players.length === 0) return socket.emit('errorMessage', 'No players in tournament');

      // randomize and chunk into 4-player matches
      const shuffled = [...players].sort(() => Math.random() - 0.5);
      const matches = [];
      for (let i = 0; i < shuffled.length; i += 4) {
        const group = shuffled.slice(i, i + 4);
        const matchIndex = Math.floor(i / 4) + 1;
        const roomCode = `match_${makeId('m_')}`;
        const matchPayload = {
          tournament_id: tournamentId,
          round_number: 1,
          match_index: matchIndex,
          room_code: roomCode,
          players: group,
          status: 'scheduled',
        };
        try {
          const { data: matchRow, error: matchErr } = await supabase.from('tournament_matches').insert([matchPayload]).select().single();
          if (matchErr) throw matchErr;
          matches.push({ match: matchRow, players: group });
        } catch (matchErr) {
          console.warn('Supabase insert tournament_matches failed, creating in-memory match:', matchErr?.message || matchErr);
          // fallback: create in-memory match object
          const matchRow = { id: makeId('mm_'), ...matchPayload };
          if (!tournamentsMemory[tournamentId]) tournamentsMemory[tournamentId] = { id: tournamentId, matches: [] };
          tournamentsMemory[tournamentId].matches = tournamentsMemory[tournamentId].matches || [];
          tournamentsMemory[tournamentId].matches.push(matchRow);
          try { saveTournaments(tournamentsMemory); } catch (e) {}
          matches.push({ match: matchRow, players: group });
        }
      }

      // mark tournament in_progress
      try {
        await supabase.from('tournaments').update({ status: 'in_progress' }).eq('id', tournamentId);
      } catch (upErr) {
        console.warn('Supabase update tournaments failed, updating in-memory status:', upErr?.message || upErr);
        if (tournamentsMemory[tournamentId]) {
          tournamentsMemory[tournamentId].status = 'in_progress';
          try { saveTournaments(tournamentsMemory); } catch (e) {}
        }
      }

      const troom = `tournament_${tournamentId}`;
      // Notify players in the tournament room
      io.to(troom).emit('tournamentStarted', { tournamentId, matches: matches.map(m => m.match) });
      // Also broadcast globally so admin UIs and other clients can update their lists
      try {
        io.emit('tournamentStarted', { tournamentId, matches: matches.map(m => m.match), tournament: t });
      } catch (e) {
        console.warn('Global tournamentStarted emit failed:', e && e.message);
      }

      // For each match, try to join connected players into the match room and notify them
      for (const m of matches) {
        const roomCode = m.match.room_code;
        const groupSize = Array.isArray(m.players) ? m.players.length : 4;
        // initialize matchRooms tracking (expected players = group length or 4)
        matchRooms[roomCode] = matchRooms[roomCode] || { expected: groupSize || 4, connected: new Set(), startTimer: null };

        // Determine color order based on group size
        let colorOrder;
        if (groupSize === 2) {
          colorOrder = ["blue", "green"];
        } else if (groupSize === 3) {
          colorOrder = ["blue", "red", "green"];
        } else {
          colorOrder = ["blue", "red", "green", "yellow"];
        }

        for (const p of m.players) {
          try {
            const targetSocket = io.sockets.sockets.get(p.player_id);
            if (targetSocket) {
              targetSocket.join(roomCode);
              matchRooms[roomCode].connected.add(targetSocket.id);

              // Ensure the server-side room exists and contains normalized player objects
              if (!rooms[roomCode]) {
                rooms[roomCode] = { players: [], dice: 1, turnIndex: 0, roomCode };
                updateRoomTurn(rooms[roomCode]);
              }
              const r = rooms[roomCode];
              const playerName = p.player_name || p.playerName || p.player_id || p.name || 'Player';
              if (!r.players.find((pp) => pp.id === targetSocket.id)) {
                // Assign color from the appropriate color order
                const usedColors = new Set(r.players.map(pl => pl.color));
                let assignedColor = colorOrder[0];
                for (const color of colorOrder) {
                  if (!usedColors.has(color)) {
                    assignedColor = color;
                    break;
                  }
                }
                r.players.push({ id: targetSocket.id, name: playerName, isHost: r.players.length === 0, color: assignedColor, consecutiveSixes: 0 });
              }

              // Emit scheduled match info and a normalized room update
              targetSocket.emit('matchScheduled', { tournamentId, matchId: m.match.id, roomCode, players: r.players });
              io.to(roomCode).emit('roomUpdate', r.players);

              // also instruct client to navigate to match room
              targetSocket.emit('joinMatchRoom', { roomCode, matchId: m.match.id });
            }
          } catch (e) {
            console.warn('could not auto-join player to room:', p.player_id);
          }
        }

        // If enough connected now, schedule auto-start; otherwise server will wait for further confirmations
        maybeScheduleMatchStart(roomCode, { tournamentId, matchId: m.match.id, expected: matchRooms[roomCode].expected });
      }

      console.log(`🏁 Tournament ${tournamentId} started with ${matches.length} matches in round 1`);
    } catch (err) {
      console.error('startTournament error:', err.message);
      socket.emit('errorMessage', 'startTournament failed');
    }
  });

  // Admin: delete tournament by id (requires ADMIN_PHONE env var OR default phone)
  socket.on('deleteTournament', async ({ tournamentId, adminPhone, token } = {}) => {
    try {
      if (!tournamentId) return socket.emit('errorMessage', 'deleteTournament: missing id');
      const expected = String(process.env.ADMIN_PHONE || '8264955651');

      // If token provided, verify it and check phone
      if (token) {
        try {
          const decoded = jwt.verify(token, process.env.JWT_SECRET || 'defaultsecret');
          if (!decoded || String(decoded.phone) !== expected) return socket.emit('errorMessage', 'deleteTournament: forbidden');
        } catch (e) {
          return socket.emit('errorMessage', 'deleteTournament: invalid token');
        }
      } else {
        if (!adminPhone || String(adminPhone) !== expected) {
          return socket.emit('errorMessage', 'deleteTournament: forbidden');
        }
      }

      // Try Supabase first
      try {
        await supabase.from('tournament_players').delete().eq('tournament_id', tournamentId);
        await supabase.from('tournament_matches').delete().eq('tournament_id', tournamentId);
        const { data, error } = await supabase.from('tournaments').delete().eq('id', tournamentId).select().single();
        if (error) throw error;
        // notify clients
        io.emit('tournamentRemoved', { tournamentId, source: 'supabase' });
        socket.emit('deleteTournamentAck', { tournamentId, status: 'deleted', source: 'supabase' });
        return;
      } catch (supErr) {
        console.warn('Supabase delete failed or unavailable, falling back to disk:', supErr?.message || supErr);
      }

      // Fallback: remove from in-memory disk-backed store
      if (tournamentsMemory && tournamentsMemory[tournamentId]) {
        delete tournamentsMemory[tournamentId];
        try { saveTournaments(tournamentsMemory); } catch (e) { console.warn('Failed to save after delete:', e && e.message); }
        io.emit('tournamentRemoved', { tournamentId, source: 'memory' });
        socket.emit('deleteTournamentAck', { tournamentId, status: 'deleted', source: 'memory' });
        return;
      }

      socket.emit('deleteTournamentAck', { tournamentId, status: 'not_found' });
    } catch (err) {
      console.error('deleteTournament error:', err && err.message);
      socket.emit('errorMessage', 'deleteTournament failed');
    }
  });

  // reportMatchResult: accept match result and advance winners when a round completes
  socket.on('reportMatchResult', async ({ tournamentId, matchId, placements }) => {
    try {
      if (!tournamentId || !matchId || !placements) return socket.emit('errorMessage', 'reportMatchResult: missing data');
      
      console.log(`📊 reportMatchResult: tournamentId=${tournamentId}, matchId=${matchId}, placements=`, placements);

      // Try to update in Supabase; if unavailable, update in-memory
      let matchRow = null;
      try {
        const { data, error } = await supabase.from('tournament_matches').update({ result: placements, status: 'finished' }).eq('id', matchId).select().single();
        if (!error) {
          matchRow = data;
        } else {
          throw error;
        }
      } catch (supErr) {
        console.warn('Supabase update match failed, using in-memory:', supErr?.message || supErr);
        // Update in-memory match if it exists
        if (tournamentsMemory[tournamentId]) {
          const match = tournamentsMemory[tournamentId].matches && tournamentsMemory[tournamentId].matches.find(m => m.id === matchId);
          if (match) {
            match.result = placements;
            match.status = 'finished';
            try { saveTournaments(tournamentsMemory); } catch (e) {}
            matchRow = match;
          }
        }
      }

      if (!matchRow) return socket.emit('errorMessage', 'Match not found');

      const currentRound = matchRow.round_number;

      // Check if all matches in this round are finished
      let allFinished = false;
      let finishedMatches = [];
      
      try {
        const { data, error } = await supabase.from('tournament_matches')
          .select('*')
          .eq('tournament_id', tournamentId)
          .eq('round_number', currentRound);
        
        if (!error && Array.isArray(data)) {
          finishedMatches = data;
          allFinished = data.every(m => m.status === 'finished');
        } else {
          throw error;
        }
      } catch (supErr) {
        console.warn('Supabase query matches failed, using in-memory:', supErr?.message || supErr);
        // Use in-memory matches
        if (tournamentsMemory[tournamentId] && tournamentsMemory[tournamentId].matches) {
          finishedMatches = tournamentsMemory[tournamentId].matches.filter(m => m.round_number === currentRound);
          allFinished = finishedMatches.every(m => m.status === 'finished');
        }
      }

      if (!allFinished) {
        console.log(`⏳ Round ${currentRound} not finished yet (${finishedMatches.filter(m => m.status === 'finished').length}/${finishedMatches.length} done)`);
        return socket.emit('reportResultAck', { matchId, message: 'Waiting for other matches to finish...' });
      }

      // All matches finished — collect winners and advance to next round
      console.log(`✅ Round ${currentRound} complete! Advancing winners to round ${currentRound + 1}`);

      const winners = [];
      for (const m of finishedMatches) {
        const res = m.result || [];
        // The first-place finisher (position === 1) advances
        const winner = Array.isArray(res) ? res.find(r => r.position === 1) : null;
        if (winner && winner.player_id) {
          winners.push(winner.player_id);
        }
      }

      if (winners.length === 0) {
        console.warn('No winners found; cannot advance round');
        return socket.emit('reportResultAck', { matchId, message: 'No winners to advance' });
      }

      // If ≤4 winners, it's the final round
      if (winners.length <= 4) {
        console.log(`🏆 TOURNAMENT COMPLETE! Final match with ${winners.length} winners`);
        const troom = `tournament_${tournamentId}`;
        io.to(troom).emit('tournamentFinished', { tournamentId, winners });
        return socket.emit('reportResultAck', { matchId, message: 'Tournament complete!' });
      }

      // Otherwise, create next round matches with the winners
      const nextRound = currentRound + 1;
      const nextMatches = [];

      // Chunk winners into groups of 4
      for (let i = 0; i < winners.length; i += 4) {
        const group = winners.slice(i, i + 4);
        const matchIndex = Math.floor(i / 4) + 1;
        const roomCode = `match_${makeId('m_')}`;

        // Build player objects for this group
        let groupPlayers = [];
        for (const playerId of group) {
          // Try to get player from Supabase
          try {
            const { data: prow, error: perr } = await supabase.from('tournament_players')
              .select('*')
              .eq('tournament_id', tournamentId)
              .eq('player_id', playerId)
              .single();
            if (!perr && prow) {
              groupPlayers.push(prow);
            }
          } catch (e) {
            // Fallback: use in-memory player or create stub
            const p = tournamentsMemory[tournamentId]?.players?.find(pp => pp.player_id === playerId);
            if (p) groupPlayers.push(p);
          }
        }

        const matchPayload = {
          tournament_id: tournamentId,
          round_number: nextRound,
          match_index: matchIndex,
          room_code: roomCode,
          players: groupPlayers,
          status: 'scheduled',
        };

        // Try to insert into Supabase
        try {
          const { data: newMatch, error: merr } = await supabase.from('tournament_matches')
            .insert([matchPayload])
            .select()
            .single();
          if (!merr && newMatch) {
            nextMatches.push({ match: newMatch, players: groupPlayers });
          } else {
            throw merr;
          }
        } catch (supErr) {
          console.warn('Supabase insert next round match failed, using in-memory:', supErr?.message || supErr);
          // Fallback: create in-memory match
          const newMatch = { id: makeId('mm_'), ...matchPayload };
          if (!tournamentsMemory[tournamentId].matches) tournamentsMemory[tournamentId].matches = [];
          tournamentsMemory[tournamentId].matches.push(newMatch);
          try { saveTournaments(tournamentsMemory); } catch (e) {}
          nextMatches.push({ match: newMatch, players: groupPlayers });
        }
      }

      // Notify tournament room of next round and auto-join players
      const troom = `tournament_${tournamentId}`;
      io.to(troom).emit('roundScheduled', { round: nextRound, matches: nextMatches.map(m => m.match) });

      for (const m of nextMatches) {
        const roomCode = m.match.room_code;
        const groupSize = m.players.length || 4;
        matchRooms[roomCode] = { expected: groupSize, connected: new Set(), startTimer: null };

        // Determine color order based on group size
        let colorOrder;
        if (groupSize === 2) {
          colorOrder = ["blue", "green"];
        } else if (groupSize === 3) {
          colorOrder = ["blue", "red", "green"];
        } else {
          colorOrder = ["blue", "red", "green", "yellow"];
        }

        for (const p of m.players) {
          try {
            const targetSocket = io.sockets.sockets.get(p.player_id);
            if (targetSocket) {
              targetSocket.join(roomCode);
              matchRooms[roomCode].connected.add(targetSocket.id);

              // Ensure the server-side room exists and contains normalized player objects
              if (!rooms[roomCode]) {
                rooms[roomCode] = { players: [], dice: 1, turnIndex: 0, roomCode };
                updateRoomTurn(rooms[roomCode]);
              }
              const r = rooms[roomCode];
              const playerName = p.player_name || p.playerName || p.player_id || p.name || 'Player';
              if (!r.players.find((pp) => pp.id === targetSocket.id)) {
                // Assign color from the appropriate color order
                const usedColors = new Set(r.players.map(pl => pl.color));
                let assignedColor = colorOrder[0];
                for (const color of colorOrder) {
                  if (!usedColors.has(color)) {
                    assignedColor = color;
                    break;
                  }
                }
                r.players.push({ id: targetSocket.id, name: playerName, isHost: r.players.length === 0, color: assignedColor, consecutiveSixes: 0 });
              }

              // Emit scheduled match info and a normalized room update
              targetSocket.emit('matchScheduled', { tournamentId, matchId: m.match.id, roomCode, players: r.players });
              io.to(roomCode).emit('roomUpdate', r.players);

              targetSocket.emit('joinMatchRoom', { roomCode, matchId: m.match.id });
            }
          } catch (e) {
            console.warn('Could not auto-join player to next round match:', e && e.message);
          }
        }

        // Schedule auto-start for next round match
        maybeScheduleMatchStart(roomCode, { tournamentId, matchId: m.match.id });
      }

      console.log(`🎮 Round ${nextRound} scheduled with ${nextMatches.length} matches`);
      socket.emit('reportResultAck', { matchId, message: `Advanced to round ${nextRound}` });
    } catch (err) {
      console.error('reportMatchResult error:', err.message);
      socket.emit('errorMessage', 'reportMatchResult failed: ' + err.message);
    }
  });

  socket.on("rollDice", (payload) => {
  // Accept roomCode from payload
  const roomCode = typeof payload === "string" ? payload : payload?.roomCode;
  if (!roomCode) {
    console.log(`🚨 rollDice: no roomCode in payload`, payload);
    return;
  }

  const room = rooms[roomCode];
  if (!room) {
    console.log(`🚨 rollDice: room not found for roomCode=${roomCode}`);
    return;
  }

  // Prevent concurrent rolls
  if (room.isRolling) {
    console.log(`🚨 rollDice: already rolling for room=${roomCode}`);
    return;
  }

  // Check if it's this player's turn
  const currentPlayer = room.players[room.turnIndex];
  if (!currentPlayer || currentPlayer.id !== socket.id) {
    console.log(
      `🚨 rollDice: not your turn. current=${currentPlayer?.id}, socket=${socket.id}`
    );
    return;
  }

  room.isRolling = true;
  
  // 🎲 Admin Cheat: Check if admin is using cheat
  let diceValue = Math.floor(Math.random() * 6) + 1;
  if (payload?.isAdminCheat && payload?.cheatValue) {
    const cheatValue = parseInt(payload.cheatValue);
    if (cheatValue >= 1 && cheatValue <= 6) {
      diceValue = cheatValue;
      console.log(`🔓 ADMIN CHEAT DETECTED: Using selected value ${diceValue}`);
    }
  }
  
  room.dice = diceValue;

  console.log(
    `🎯 rollDice: roomCode=${roomCode}, socket=${socket.id}, value=${diceValue}`
  );

  // Check if this roll will result in a 3-six penalty
  let isThreeSixPenalty = false;
  if (diceValue === 6) {
    const nextSixCount = currentPlayer.consecutiveSixes + 1;
    if (nextSixCount >= 3) {
      isThreeSixPenalty = true;
      console.log(`⚠️ PREDICTION: ${currentPlayer.name} will be penalized for 3 sixes!`);
    }
  }

  const rollPayload = { 
    roomCode, 
    value: diceValue, 
    roller: socket.id,
    isThreeSixPenalty: isThreeSixPenalty
  };

  // Broadcast dice result
  io.to(roomCode).emit("diceRolled", rollPayload);
  io.emit("diceRolled", rollPayload); // global (clients filter)

  // We expect EXACTLY ONE moveDone after this roll
  room.awaitingMove = true;
  // Whether the move sent by client has been validated by server (reset for each roll)
  room.moveValidated = false;

  setTimeout(() => {
    room.isRolling = false;

    // -------------------------------
    //  🎲 HANDLE CONSECUTIVE SIX LOGIC
    // -------------------------------
    if (diceValue === 6) {
      currentPlayer.consecutiveSixes += 1;
      console.log(
        `🎲 ${currentPlayer.name} rolled a 6! Consecutive = ${currentPlayer.consecutiveSixes}`
      );

      // 3 SIX PENALTY — NO MOVE ALLOWED THIS TURN
      if (currentPlayer.consecutiveSixes >= 3) {
        console.log(`⛔ ${currentPlayer.name} rolled THREE 6s → penalty!`);
        currentPlayer.consecutiveSixes = 0;

        // skip the move and skip the extra turn
        room.awaitingMove = false;

        // pass turn immediately (advance using turnOrder length if present)
        try {
          const len = Array.isArray(room.turnOrder) && room.turnOrder.length ? room.turnOrder.length : room.players.length;
          room.turnIndex = (room.turnIndex + 1) % len;
        } catch (e) {
          room.turnIndex = (room.turnIndex + 1) % room.players.length;
        }

        io.to(roomCode).emit(
          "errorMessage",
          `${currentPlayer.name} rolled 3 sixes! Turn skipped.`
        );

        updateRoomTurn(room);
        io.to(roomCode).emit("gameState", room);
        return; // IMPORTANT: stop here
      }

      // NORMAL 6 → extra turn given
      console.log(`🎲 Extra turn granted to ${currentPlayer.name}`);
    } else {
      // reset on non-6
      currentPlayer.consecutiveSixes = 0;

      // server WAITs for moveDone — client decides whether movement possible
      console.log(
        `ℹ️ Waiting for moveDone (rolled ${diceValue}). awaiting=${room.awaitingMove}`
      );
    }

    updateRoomTurn(room);
    io.to(roomCode).emit("gameState", room);
  }, 600);
});

  // NOTE: Testing cheat `setDice` removed – dice rolls must use normal `rollDice` flow.

  socket.on("updateTokenPosition", ({ roomId, playerId, tokenId, position }) => {
  const room = rooms[roomId];
  if (!room) return;
  
  const player = room.players.find((p) => p.id === playerId);
  if (!player) return;

  // Verify it's currently this player's turn
  const currentPlayer = room.players[room.turnIndex];
  if (currentPlayer.id !== playerId) {
    console.log(`🚨 updateTokenPosition: not your turn! current=${currentPlayer.id}, attempted=${playerId}`);
    try { socket.emit('errorMessage', 'It is not your turn!'); } catch (e) {}
    return;
  }

  // Check if we're waiting for a move - if not, reject the move
  if (!room.awaitingMove) {
    console.log(`⛔ updateTokenPosition rejected: not awaiting a move (likely 3-six penalty)`);
    try { socket.emit('errorMessage', 'You cannot move now - your turn has been passed!'); } catch (e) {}
    return;
  }

  // ------------------------------
  // Recompute final index on server instead of trusting client 'position'
  // This fixes kill detection when clients animate locally.
  // ------------------------------
  let prevPos = -1;
  let finalIndex = -1;

  // Resolve token index (accept numeric index or id string like 'T1')
  let tokenIndex = -1;
  if (typeof tokenId === 'number') tokenIndex = tokenId;
  else if (typeof tokenId === 'string' && tokenId.startsWith('T')) {
    const n = parseInt(tokenId.slice(1), 10);
    if (!isNaN(n)) tokenIndex = n - 1;
  }

  if (!(tokenIndex >= 0 && tokenIndex < player.tokens.length)) {
    console.log(`🚨 updateTokenPosition: invalid tokenId ${tokenId} from ${player.name}`);
    try { socket.emit('errorMessage', 'Invalid token selected'); } catch (e) {}
    return;
  }

  const token = player.tokens[tokenIndex];
  const path = getPath(player.color) || [];
  prevPos = typeof token.position === 'number' ? token.position : -1;
  const dice = typeof room.dice === 'number' ? room.dice : 0;

  // If token already finished, ignore further updates
  if (token.isFinished) {
    console.log(`⛔ Ignored updateTokenPosition for finished token ${tokenIndex} of ${player.name}`);
    try { socket.emit('errorMessage', 'This token has already finished and cannot be moved.'); } catch (e) {}
    return; // finished tokens cannot be moved back to base
  }

  // Reject client attempts to send the token back to base (-1). Only server should set base when a kill happens.
  if (typeof position === 'number' && position === -1 && prevPos >= 0) {
    console.log(`⛔ Client attempted to move token ${tokenIndex} of ${player.name} back to base`);
    try { socket.emit('errorMessage', 'Invalid move: cannot move token back to base'); } catch (e) {}
    return;
  }

  // compute desired final index according to rules:
  // - if token was in base (-1) and dice === 6 → moves to index 0
  // - if token was on board (>=0) → moves forward by dice
  // - otherwise fallback to client-provided position
  let desiredIndex = prevPos;
  if (prevPos === -1 && dice === 6) {
    desiredIndex = 0;
  } else if (prevPos >= 0) {
    desiredIndex = prevPos + dice;
  } else if (typeof position === 'number') {
    desiredIndex = position;
  }

  // Validate exact finish requirement: cannot move past home; must roll exact number
  if (Array.isArray(path) && typeof desiredIndex === 'number') {
    const lastIndex = path.length - 1;
    if (desiredIndex > lastIndex) {
      // Reject the move: require exact roll to enter home
      try { socket.emit('errorMessage', 'Invalid move: must roll exact number to enter home'); } catch (e) {}
      console.log(`⛔ Rejecting move for ${player.name}: desiredIndex ${desiredIndex} > lastIndex ${lastIndex}`);
      return; // do not modify token position nor emit playerMoved/gameState
    }
  }

  // Move is valid — commit
  finalIndex = desiredIndex;
  token.position = finalIndex;

  // If reached final home cell, mark finished
  if (typeof finalIndex === 'number' && Array.isArray(path) && finalIndex === path.length - 1) {
    token.isFinished = true;
    console.log(`🏆 Token ${tokenIndex} finished for ${player.name}!`);

    // Grant an extra turn to the player who reached home with a token
    try {
      room.homeExtraTurn = true; // separate flag for reaching home
    } catch (e) {}

    // If this completed all 4 tokens for the player, record their finish position
    try {
      const allFinished = player.tokens.every((t) => t.isFinished === true);
      if (allFinished) {
        player.finished = true;
        if (!Array.isArray(room.finishOrder)) room.finishOrder = [];

        const already = room.finishOrder.find((f) => f.playerId === player.id);
        if (!already) {
          const pos = room.finishOrder.length + 1;
          const entry = {
            playerId: player.id,
            playerName: player.name,
            playerColor: player.color,
            position: pos,
          };
          room.finishOrder.push(entry);
          player.finishPosition = pos;
          // Notify clients a player finished so UI can show medal immediately
          io.to(roomId).emit("playerFinished", entry);
          console.log(`🏁 Player finished: ${player.name} -> position ${pos}`);
        }
      }
    } catch (e) {
      console.warn('finishRecording failed:', e && e.message);
    }
  }

  // Mark that this room now has a validated move (used by moveDone)
  try { room.moveValidated = true; } catch (e) {}
  try {
    // build explicit intermediate steps to guide client animation
    const toPos = player.tokens[tokenId]?.position;
    const stepsArr = [];
    for (let i = (typeof prevPos === 'number' ? prevPos : -1) + 1; i <= (typeof toPos === 'number' ? toPos : -1); i++) {
      stepsArr.push(i);
    }

    const movePayload = {
      roomId,
      playerId: player.id,
      color: player.color,
      tokenId,
      from: prevPos,
      to: toPos,
      steps: stepsArr,
      dice: room.dice,
    };
    console.log("⬆️ Emitting playerMoved:", movePayload);
    // Emit only to the room (no global emit) – clients in the room will animate
    io.to(roomId).emit("playerMoved", movePayload);
  } catch (e) {
    console.warn("Failed to emit playerMoved:", e && e.message);
  }

  // ---------------------------------------------
// ★ FINAL VERIFIED WORKING LUDO KILL LOGIC ★
// With STACKED TOKEN SAFETY - 2+ tokens same color on non-safe cell = safe
// -------------------------------------------------------
{
  const tok = player.tokens[tokenId];
  const landedIndex = typeof tok?.position === "number" ? tok.position : null;

  if (landedIndex !== null && landedIndex !== -1) {
    const path = getPath(player.color);
    const landedCell = path[landedIndex];

    const isSafe = safeCells.includes(landedCell);
    const isHomeStretch = landedIndex >= path.length - 6;  // ⭐ skip killing here

    console.log("Landed on:", landedCell, "Safe?", isSafe, "HomeStretch?", isHomeStretch);

    if (!isSafe && !isHomeStretch) {
      room.players.forEach((enemy) => {
        if (enemy.color === player.color) return; // skip self

        const enemyPath = getPath(enemy.color);

        enemy.tokens.forEach((enemyToken, idx) => {
          if (enemyToken.position === -1) return; // enemy in base

          // Skip if enemy is in their home stretch or already finished
          const enemyInHome = (typeof enemyToken.position === 'number') && enemyToken.position >= enemyPath.length - 6;
          if (enemyInHome || enemyToken.isFinished) {
            console.log(`🔒 Skip kill: ${enemy.color}[${idx}] is in home/finished (pos=${enemyToken.position}, isFinished=${!!enemyToken.isFinished})`);
            return;
          }

          const enemyCell = enemyPath[enemyToken.position];

          console.log(
            `Checking kill: ${player.color} landed ${landedCell} vs ${enemy.color}[${idx}] = ${enemyCell}`
          );

          if (enemyCell === landedCell) {
            // 🛡️ CHECK IF THIS CELL IS SAFE DUE TO STACKED TOKENS
            // Count how many tokens of the SAME color (enemy.color) are on THIS SAME POSITION
            let stackedTokenCount = 0;
            enemy.tokens.forEach((token) => {
              // Count only tokens that have the SAME position as the token being checked
              if (token.position === enemyToken.position && token.position !== -1) {
                stackedTokenCount++;
              }
            });

            console.log(`🔍 Stacked token check on cell ${landedCell}: ${enemy.color} has ${stackedTokenCount} token(s) at position ${enemyToken.position}`);

            if (stackedTokenCount >= 2) {
              console.log(`🛡️ SAFE: ${enemy.color}[${idx}] is SAFE on cell ${landedCell} (${stackedTokenCount} tokens stacked) - NO KILL!`);
              return; // Don't kill - cell is protected
            }

            console.log(`💥 KILL: ${player.color} killed ${enemy.color} token ${idx}`);

            enemy.tokens[idx].position = -1;
            enemy.tokens[idx].isFinished = false;

            // 📢 BROADCAST updated gameState immediately to all clients so they see correct token positions
            io.to(roomId).emit("gameState", room);

            // Grant an extra turn to the player who performed the kill
            try {
              room.killExtraTurn = true;
            } catch (e) {}
            console.log(`🎯 Extra turn granted to ${player.name} for kill`);

            io.to(roomId).emit("tokenKilled", {
              killedColor: enemy.color,
              killedToken: idx,
              byColor: player.color,
              cell: landedCell,
            });
          }
        });
      });
    }
  }
}

  // ---------------------------------------------------
  // 📢 Broadcast gameState IMMEDIATELY so all clients sync up (especially important after kills)
  io.to(roomId).emit("gameState", room);
  
  // Broadcast final state after a short delay to allow clients to animate the move
  try {
    const stepsToMove = (typeof finalIndex === 'number' ? finalIndex : -1) - (typeof prevPos === 'number' ? prevPos : -1);
    const stepDuration = 300; // should match client per-step duration
    const totalAnimationTime = Math.max(0, stepsToMove) * stepDuration + 100;
    console.log(`⏱️ Scheduling additional gameState emit in ${totalAnimationTime}ms for room ${roomId}`);
    setTimeout(() => {
      io.to(roomId).emit("gameState", room);
    }, totalAnimationTime);
  } catch (e) {
    console.warn('Failed to schedule gameState emit:', e && e.message);
  }
});

  socket.on("moveDone", ({ roomId, playerId, tokenId, position, noExtraTurnOn6 }) => {
  const room = rooms[roomId];
  if (!room) return;

  console.log(
    `⏭️ moveDone from ${playerId}, token=${tokenId}, dice=${room.dice}, awaiting=${room.awaitingMove}`
  );

  // Debug: log tokenId types to help diagnose pass vs invalid tokens
  try {
    console.log(`moveDone payload types: tokenId type=${typeof tokenId}, tokenId value=`, tokenId);
  } catch (e) {}
  
  // Coerce tokenId strings like "2" to numbers for robustness
  let receivedTokenId = tokenId;
  if (typeof receivedTokenId === 'string') {
    const m = receivedTokenId.match(/^\d+$/);
    if (m) {
      receivedTokenId = parseInt(receivedTokenId, 10);
      console.log(`Coerced tokenId string to number: ${receivedTokenId}`);
    }
  }

  // Determine if this is a pass move (no token selected/moved)
  const isPassMove =
    receivedTokenId === null ||
    typeof receivedTokenId === 'undefined' ||
    receivedTokenId === -1 ||
    typeof receivedTokenId !== 'number';

  // Ignore duplicates or early moveDone
  if (!room.awaitingMove) {
    console.log(`⛔ Ignored moveDone — not awaiting.`);
    return;
  }

  const currentPlayer = room.players[room.turnIndex];

  // Only current player can finish move
  if (!currentPlayer || currentPlayer.id !== playerId) {
    console.log(`⛔ Ignored moveDone — not current player.`);
    return;
  }

  // Ensure the move was validated by server (exact finish, not moving finished tokens, etc.)
  // Skip this check for pass moves — they don't require validation
  if (!isPassMove && room.moveValidated === false) {
    try {
      socket.emit('errorMessage', 'Move not valid or not validated by server. Choose a different token or retry.');
    } catch (e) {}
    console.log(`⛔ moveDone ignored — server did not validate move for player ${playerId} (receivedTokenId=${receivedTokenId})`);
    // keep room.awaitingMove = true so player can try another move
    return;
  }

  // Move accepted → stop accepting more moveDone
  room.awaitingMove = false;

  // TURN LOGIC
  try {
    const len = Array.isArray(room.turnOrder) && room.turnOrder.length ? room.turnOrder.length : room.players.length;
    const currentPlayerFinished = currentPlayer.tokens.every((t) => t.isFinished === true);

    // 🏆 PRIORITY: Check if client says "6 was rolled but no valid moves" - override all other extra turn logic
    if (noExtraTurnOn6) {
      console.log(`⏭️ 🏆 Player rolled 6 but no valid moves available - NO extra turn granted!`);
      let nextIndex = (room.turnIndex + 1) % len;
      let iterations = 0;
      while (iterations < len) {
        const nextPlayer = room.players[nextIndex];
        const allTokensFinished = nextPlayer.tokens.every((t) => t.isFinished === true);
        if (allTokensFinished) {
          nextIndex = (nextIndex + 1) % len;
          iterations++;
          continue;
        }
        break;
      }
      room.turnIndex = nextIndex;
      room.homeExtraTurn = false;  // Clear any extra turn flags
      room.killExtraTurn = false;
    }

    // 1) Kill extra-turn always keeps the turn
    else if (room.killExtraTurn) {
      console.log(`🎯 Kill extra-turn: keeping turn with ${currentPlayer?.name}`);
      room.killExtraTurn = false;
    }

    // 2) Home-reach extra-turn: only keep it if player still has movable tokens
    else if (room.homeExtraTurn) {
      if (!currentPlayerFinished) {
        console.log(`🎲 Home extra-turn: keeping turn with ${currentPlayer?.name}`);
        room.homeExtraTurn = false;
      } else {
        // Player has finished all tokens — skip them
        let nextIndex = (room.turnIndex + 1) % len;
        let iterations = 0;
        while (iterations < len) {
          const nextPlayer = room.players[nextIndex];
          const allTokensFinished = nextPlayer.tokens.every((t) => t.isFinished === true);
          if (allTokensFinished) {
            nextIndex = (nextIndex + 1) % len;
            iterations++;
            continue;
          }
          break;
        }
        room.homeExtraTurn = false;
        room.turnIndex = nextIndex;
        console.log(`⏭️ Skipping finished player, next → ${room.players[room.turnIndex].name}`);
      }
    }

    // 3) Normal non-6 pass
    else if (room.dice !== 6) {
      let nextIndex = (room.turnIndex + 1) % len;
      let iterations = 0;
      while (iterations < len) {
        const nextPlayer = room.players[nextIndex];
        const allTokensFinished = nextPlayer.tokens.every((t) => t.isFinished === true);
        if (allTokensFinished) {
          nextIndex = (nextIndex + 1) % len;
          iterations++;
          continue;
        }
        break;
      }
      room.turnIndex = nextIndex;
      console.log(`🔄 Turn passed → ${room.players[room.turnIndex].name}`);
    }

    // 4) Dice == 6: same player, unless they have finished all tokens
    else {
      if (currentPlayerFinished) {
        let nextIndex = (room.turnIndex + 1) % len;
        let iterations = 0;
        while (iterations < len) {
          const nextPlayer = room.players[nextIndex];
          const allTokensFinished = nextPlayer.tokens.every((t) => t.isFinished === true);
          if (allTokensFinished) {
            nextIndex = (nextIndex + 1) % len;
            iterations++;
            continue;
          }
          break;
        }
        room.turnIndex = nextIndex;
        console.log(`⏭️ ${currentPlayer.name} rolled 6 but finished: skipping to ${room.players[room.turnIndex].name}`);
      } else {
        console.log(`🎲 Extra turn → same player (${currentPlayer.name})`);
      }
    }
  } catch (e) {
    // Fallback: advance by one
    try {
      room.turnIndex = (room.turnIndex + 1) % room.players.length;
    } catch (ex) {}
  }

  // Update the "whose turn" flags
  updateRoomTurn(room);

  // Check win condition
  const winners = checkWinCondition(room);
  if (winners) {
    // Game has ended
    const winnerPositions = winners.map((w, pos) => ({
      position: pos + 1,
      playerName: w.player.name,
      playerColor: w.player.color,
    }));
    console.log(`🏆 GAME ENDED! Winners:`, winnerPositions);
    
    room.gameEnded = true;
    room.winners = winnerPositions;

    io.to(roomId).emit("gameEnded", {
      winners: winnerPositions,
      message: `Game Over! ${winnerPositions.map((w) => `${w.position}. ${w.playerName} (${w.playerColor})`).join(", ")}`,
      tournamentId: room.tournamentId,
      matchId: room.matchId,
    });
    return; // Stop here, don't advance turn further
  }

  // Broadcast final state — emit immediately for pass moves (no animation), delayed for actual moves
  const broadcastDelay = isPassMove ? 0 : 400; // ms
  setTimeout(() => {
    try {
      io.to(roomId).emit("gameState", room);
    } catch (e) {
      console.warn('moveDone: failed to emit gameState:', e && e.message);
    }
  }, broadcastDelay);
});

  socket.on("disconnect", () => {
    console.log("🔴 Disconnected:", socket.id);
    for (let roomId in rooms) {
      const room = rooms[roomId];
      room.players = room.players.filter((p) => p.id !== socket.id);
      // Rebuild turnOrder and ensure turnIndex is valid
      try {
        room.turnOrder = room.players.map((p) => p.id);
        const len = room.turnOrder.length || room.players.length || 1;
        room.turnIndex = room.turnIndex % len;
      } catch (e) {}

      updateRoomTurn(room);
      io.to(roomId).emit("gameState", room);
      io.to(roomId).emit("roomUpdate", room.players);
    }

    // Remove socket from any matchRooms tracking and cancel scheduled start if necessary
    try {
      for (const mc of Object.keys(matchRooms)) {
        const info = matchRooms[mc];
        if (info && info.connected && info.connected.has(socket.id)) {
          info.connected.delete(socket.id);
          // If a start was scheduled and we dropped below expected, cancel timer
          if (info.startTimer && info.connected.size < (info.expected || 4)) {
            clearTimeout(info.startTimer);
            info.startTimer = null;
            io.to(mc).emit('matchStartCancelled', { roomCode: mc, reason: 'player_disconnected' });
            console.log(`⏸️ Cancelled scheduled start for ${mc} due to disconnect (${socket.id})`);
          }
        }
        // cleanup empty matchRooms if no connected and no timer
        if (info && info.connected.size === 0 && !info.startTimer) {
          delete matchRooms[mc];
        }
      }
    } catch (e) {
      console.warn('disconnect matchRooms cleanup failed:', e && e.message);
    }
  });

  // Join a match room by code (e.g., from JoinMatchByCode page)
  socket.on('joinMatchRoom', ({ roomCode, playerName } = {}) => {
    try {
      if (!roomCode) return socket.emit('errorMessage', 'Invalid room code');
      
      // Join the socket to the room
      socket.join(roomCode);
      
      // Initialize matchRooms tracking if not already present
      matchRooms[roomCode] = matchRooms[roomCode] || { expected: 4, connected: new Set(), startTimer: null };
      matchRooms[roomCode].connected.add(socket.id);
      
      console.log(`🎮 joinMatchRoom: ${socket.id} (${playerName}) joined ${roomCode} (connected ${matchRooms[roomCode].connected.size}/${matchRooms[roomCode].expected})`);
      // Ensure server-side room exists and add normalized player object BEFORE emitting
      if (!rooms[roomCode]) {
        rooms[roomCode] = { players: [], dice: 1, turnIndex: 0, roomCode };
        updateRoomTurn(rooms[roomCode]);
      }
      const r = rooms[roomCode];
      if (!r.players.find(p => p.id === socket.id)) {
        // Assign color based on current + new player count
        const futurePlayerCount = r.players.length + 1;
        let colorOrder;
        if (futurePlayerCount === 2) {
          colorOrder = ["blue", "green"];
        } else if (futurePlayerCount === 3) {
          colorOrder = ["blue", "red", "green"];
        } else {
          colorOrder = ["blue", "red", "green", "yellow"];
        }
        
        const usedColors = new Set(r.players.map(p => p.color));
        let assignedColor = "blue";
        for (const color of colorOrder) {
          if (!usedColors.has(color)) {
            assignedColor = color;
            break;
          }
        }
        
        r.players.push({ id: socket.id, name: playerName || 'Player', isHost: r.players.length === 0, color: assignedColor, consecutiveSixes: 0 });
      }

      // Emit success back to the joining client and broadcast updated room
      socket.emit('roomJoined', { roomCode });
      socket.emit('roomUpdate', r.players);
      io.to(roomCode).emit('playerJoinedMatch', { playerId: socket.id, playerName, roomCode });
      io.to(roomCode).emit('roomUpdate', r.players);

      // ⭐ NEW: If this is a tournament match and all players are now present, re-initialize the room
      // This ensures colors are correctly assigned based on final player count
      const info = matchRooms[roomCode];
      if (info && r.players.length >= (info.expected || 4)) {
        console.log(`✅ All players connected for ${roomCode}, re-initializing room`);
        assignTokensAndInitRoom(r);
        io.to(roomCode).emit('gameState', r);
        io.to(roomCode).emit('roomUpdate', r.players);
      }

      // Check if we should schedule auto-start
      maybeScheduleMatchStart(roomCode, { roomCode });
    } catch (e) {
      console.warn('joinMatchRoom error:', e && e.message);
      socket.emit('errorMessage', 'Failed to join match room');
    }
  });

  // Clients call this after they have joined the match room locally (or after they navigate to it).
  socket.on('confirmJoinMatch', ({ roomCode, matchId } = {}) => {
    try {
      if (!roomCode) return;
      socket.join(roomCode); // ensure server-side membership
      matchRooms[roomCode] = matchRooms[roomCode] || { expected: 4, connected: new Set(), startTimer: null };
      matchRooms[roomCode].connected.add(socket.id);
      console.log(`🔗 confirmJoinMatch: ${socket.id} joined ${roomCode} (connected ${matchRooms[roomCode].connected.size}/${matchRooms[roomCode].expected})`);
      // Schedule start if threshold satisfied
      maybeScheduleMatchStart(roomCode, { matchId });
    } catch (e) {
      console.warn('confirmJoinMatch error:', e && e.message);
    }
  });

  // Receive announced moves that include explicit per-step positions from a client
  socket.on("announceMove", (payload) => {
    try {
      const roomId = payload?.roomId;
       // Initialize room if it doesn't exist (for tournament matches before startMatch is called)
       if (!rooms[roomCode]) {
         rooms[roomCode] = { players: [], dice: 1, turnIndex: 0, roomCode };
         updateRoomTurn(rooms[roomCode]);
       }
       const r = rooms[roomCode];
       if (!r.players.find(p => p.id === socket.id)) {
         r.players.push({ id: socket.id, name: playerName || 'Player', isHost: r.players.length === 0, color: 'blue', consecutiveSixes: 0 });
       }
       io.to(roomCode).emit('roomUpdate', r.players);
      // NOTE: DO NOT re-broadcast here. The updateTokenPosition handler already broadcasts
      // playerMoved with proper steps. Re-broadcasting here causes double animations on remote clients.
      // This event was mainly for server-side tracking if needed; we don't re-emit it.
      console.log("📋 announceMove received from", payload?.color, "token", payload?.tokenId);
    } catch (e) {
      console.warn("announceMove failed:", e && e.message);
    }
  });

  // End of io.on('connection') handlers
});

const listenPort = Number(process.env.PORT) || PORT || 3001;

function startServer(port) {
  server.listen(port, "0.0.0.0", () => {
    console.log(`🚀 Server running on port ${port} (bound to 0.0.0.0)`);
  });

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      const alt = Number(port) + 1;
      console.warn(`⚠️ Port ${port} in use — retrying on ${alt}`);
      // try next port once
      server.close(() => startServer(alt));
    } else {
      console.error('Server error:', err && err.message);
      process.exit(1);
    }
  });
}

startServer(listenPort);

import express from 'express';
import jwt from 'jsonwebtoken';
import supabase from '../supabaseClient.js';
import { loadTournaments, saveTournaments } from '../persistentStore.js';
import crypto from 'crypto';
import { scheduleTournamentReminder } from '../whatsappReminders.js';

const router = express.Router();

// Create a tournament record
router.post('/create', async (req, res) => {
  try {
    const { name, total_players = 256, creator, starts_at } = req.body;
    const payload = {
      name: name || `Tournament ${new Date().toISOString()}`,
      total_players,
      creator: creator || null,
      status: 'waiting',
      starts_at: starts_at || null,
    };
    // Try to insert into Supabase first (if configured)
    try {
      const { data, error } = await supabase.from('tournaments').insert([payload]).select().single();
      if (error) throw error;
      // Schedule a reminder 15 minutes before start (if start time provided)
      try {
        scheduleTournamentReminder(data.id, { minutesBefore: 15, message: req.body.reminderMessage }).catch((e) => console.warn('scheduleReminder failed:', e && e.message));
      } catch (e) {}
      return res.json({ tournament: data, source: 'supabase' });
    } catch (supErr) {
      // Fallback: persist to disk-backed store so HTTP create works when Supabase/schema missing
      try {
        const mem = loadTournaments() || {};
        // create a simple id (keep format similar to server makeId)
        const id = `t_${crypto.randomBytes(6).toString('hex')}`;
        const t = { id, name: payload.name, total_players: payload.total_players, creator: payload.creator, status: payload.status, created_at: new Date().toISOString(), starts_at: payload.starts_at || null, players: [], matches: [] };
        mem[id] = t;
        saveTournaments(mem);
        console.log('HTTP create: persisted tournament to disk (fallback)', t.id);
        // schedule reminder for memory-backed tournament
        try {
          scheduleTournamentReminder(t.id, { minutesBefore: 15, message: req.body.reminderMessage }).catch((e) => console.warn('scheduleReminder failed:', e && e.message));
        } catch (e) {}
        return res.json({ tournament: t, source: 'disk' });
      } catch (e) {
        console.error('HTTP create fallback failed:', e && e.message);
        return res.status(500).json({ error: supErr?.message || 'create failed' });
      }
    }
  } catch (err) {
    console.error('create tournament failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// Get tournament by id
router.get('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    // Try Supabase first, but if Supabase is not configured or the row
    // isn't found, fall back to the local disk-backed store so the
    // frontend can still read tournaments in development.
    let tournament = null;
    let players = [];
    try {
      const { data, error } = await supabase.from('tournaments').select('*').eq('id', id).single();
      if (!error && data) tournament = data;
    } catch (e) {
      // supabase unavailable — we'll fall back below
    }

    // If we got a tournament from Supabase, attempt to fetch its players
    if (tournament) {
      try {
        const { data: pData, error: pErr } = await supabase.from('tournament_players').select('*').eq('tournament_id', id);
        if (!pErr && Array.isArray(pData)) {
          // for each player row, attempt to resolve phone from users table by player_id
          players = await Promise.all(pData.map(async (pr) => {
            const out = { ...pr };
            try {
              const pid = pr.player_id;
              if (pid) {
                const { data: u, error: uErr } = await supabase.from('users').select('phone').eq('id', pid).single();
                if (!uErr && u && u.phone) out.phone = u.phone;
              }
            } catch (e) {
              // ignore per-player lookup errors
            }
            return out;
          }));
        }
      } catch (e) {
        // ignore players lookup failure — leave players empty
      }
      return res.json({ tournament, players });
    }

    // Supabase didn't return a tournament — try disk-backed store (memory fallback)
    try {
      const mem = loadTournaments() || {};
      const t = mem[id] || Object.values(mem).find((x) => x && (String(x.id) === String(id) || String(x.name) === String(id)));
      if (!t) return res.status(404).json({ error: 'Tournament not found in Supabase or memory' });
      // ensure players array exists
      let memPlayers = Array.isArray(t.players) ? t.players : (t.players ? Object.values(t.players) : []);
      // Attempt to enrich disk-backed players with phone numbers from users table
      try {
        if (supabase && Array.isArray(memPlayers) && memPlayers.length > 0) {
          memPlayers = await Promise.all(memPlayers.map(async (pl) => {
            if (!pl) return pl;
            try {
              // already has phone
              if (pl.phone || pl.player_phone || pl.phoneNumber) return pl;
              // try by player_id -> users.id
              if (pl.player_id) {
                try {
                  const { data: u, error: uErr } = await supabase.from('users').select('phone').eq('id', pl.player_id).single();
                  if (!uErr && u && u.phone) return { ...pl, phone: u.phone };
                } catch (e) {}
              }
              // try by player_name -> users.username
              const uname = pl.player_name || pl.playerName || pl.name || pl.username;
              if (uname) {
                try {
                  const { data: u2, error: u2Err } = await supabase.from('users').select('phone').eq('username', String(uname)).single();
                  if (!u2Err && u2 && u2.phone) return { ...pl, phone: u2.phone };
                } catch (e) {}
              }
            } catch (e) {}
            return pl;
          }));
        }
      } catch (e) {
        // ignore enrichment failures
      }
      return res.json({ tournament: t, players: memPlayers });
    } catch (e) {
      return res.status(500).json({ error: e?.message || 'read fallback failed' });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Update tournament start time and reschedule reminders
router.post('/:id/update', async (req, res) => {
  try {
    const id = req.params.id;
    const { starts_at } = req.body || {};
    
    console.log('📅 Tournament update endpoint called:', { id, starts_at });
    
    if (!starts_at) {
      return res.status(400).json({ error: 'starts_at is required in body' });
    }

    // Validate that starts_at is a valid date
    const startDate = new Date(starts_at);
    if (isNaN(startDate.getTime())) {
      return res.status(400).json({ error: 'Invalid date format for starts_at' });
    }

    let updated = null;

    // Try to update in Supabase first
    try {
      const { data, error } = await supabase
        .from('tournaments')
        .update({ starts_at })
        .eq('id', id)
        .select()
        .single();
      
      if (!error && data) {
        updated = data;
        console.log('✅ Tournament updated in Supabase');
        // Try to reschedule reminder for updated start time
        try {
          const { scheduleTournamentReminder } = await import('../whatsappReminders.js');
          await scheduleTournamentReminder(id, { minutesBefore: 15 }).catch((e) => console.warn('Reschedule failed:', e?.message));
        } catch (e) {}
      }
    } catch (e) {
      console.log('⚠️ Supabase update failed, trying disk store:', e?.message);
      // fall through to disk fallback
    }

    // If Supabase didn't work, try memory/disk store
    if (!updated) {
      try {
        const { loadTournaments, saveTournaments } = await import('../persistentStore.js');
        const mem = loadTournaments() || {};
        const t = mem[id] || Object.values(mem).find((x) => x && (String(x.id) === String(id) || String(x.name) === String(id)));
        
        if (!t) {
          console.log('❌ Tournament not found:', id);
          return res.status(404).json({ error: 'Tournament not found' });
        }

        t.starts_at = starts_at;
        saveTournaments(mem);
        updated = t;
        console.log('✅ Tournament updated in disk store');

        // Try to reschedule reminder
        try {
          const { scheduleTournamentReminder } = await import('../whatsappReminders.js');
          await scheduleTournamentReminder(id, { minutesBefore: 15 }).catch((e) => console.warn('Reschedule failed:', e?.message));
        } catch (e) {}
      } catch (e) {
        console.error('❌ Failed to update tournament:', e?.message);
        return res.status(500).json({ error: e?.message || 'Failed to update tournament' });
      }
    }

    console.log('✅ Tournament update completed successfully');
    return res.json({ ok: true, tournament: updated });
  } catch (err) {
    console.error('❌ Tournament update error:', err?.message);
    return res.status(500).json({ error: err.message });
  }
});

// List upcoming tournaments
router.get('/', async (req, res) => {
  try {
    try {
      const { data, error } = await supabase.from('tournaments').select('*').order('created_at', { ascending: false }).limit(50);
      if (!error && Array.isArray(data)) return res.json({ source: 'supabase', tournaments: data });
    } catch (e) {
      // ignore and fall through to disk fallback
    }
    // Supabase not available or query failed — return disk-backed tournaments
    const mem = loadTournaments() || {};
    return res.json({ source: 'disk', tournaments: Object.values(mem) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Update a player's phone for a tournament (admin-friendly endpoint)
// PATCH /api/tournaments/:id/player/:playerId/phone
router.patch('/:id/player/:playerId/phone', async (req, res) => {
  try {
    const id = req.params.id;
    const playerId = req.params.playerId;
    const phone = req.body && (req.body.phone || req.body.playerPhone || req.body.phoneNumber);
    if (!phone) return res.status(400).json({ error: 'missing phone in body' });

    // Try to update in Supabase first (if available)
    try {
      const { data, error } = await supabase.from('tournament_players').update({ phone }).eq('tournament_id', id).eq('player_id', playerId).select().single();
      if (!error && data) {
        // emit update
        try {
          const io = req && req.app && req.app.locals && req.app.locals.io;
          if (io && typeof io.to === 'function') {
            // attempt to fetch current players to include in event
            const { data: players } = await supabase.from('tournament_players').select('*').eq('tournament_id', id);
            io.to(`tournament_${id}`).emit('tournamentUpdate', { tournamentId: id, players: players || [] });
          }
        } catch (e) {}
        return res.json({ ok: true, player: data, source: 'supabase' });
      }
    } catch (e) {
      // ignore supabase update failure and fall back to disk
    }

    // Fallback: update disk-backed store
    try {
      const mem = loadTournaments() || {};
      const t = mem[id] || Object.values(mem).find((x) => x && (String(x.id) === String(id) || String(x.name) === String(id)));
      if (!t) return res.status(404).json({ error: 'tournament not found' });
      if (!Array.isArray(t.players)) t.players = Array.isArray(t.players) ? t.players : (t.players ? Object.values(t.players) : []);
      const p = t.players.find((pl) => String(pl.player_id || pl.id || pl.playerId) === String(playerId));
      if (!p) return res.status(404).json({ error: 'player not found in tournament' });
      p.phone = String(phone);
      saveTournaments(mem);
      // emit socket update if possible
      try {
        const io = req && req.app && req.app.locals && req.app.locals.io;
        if (io && typeof io.to === 'function') io.to(`tournament_${t.id}`).emit('tournamentUpdate', { tournament: t, players: t.players });
      } catch (e) {}
      return res.json({ ok: true, player: p, source: 'memory' });
    } catch (e) {
      return res.status(500).json({ error: e?.message || 'update failed' });
    }
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'update player phone failed' });
  }
});

// Delete a tournament (admin only) -- require `x-admin-phone` header matching ADMIN_PHONE
router.delete('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    console.log(`DELETE /api/tournaments/${id} called. Authorization header present: ${!!req.header('authorization')}, x-admin-phone: ${req.header('x-admin-phone')}`);

    // First try JWT auth: Authorization: Bearer <token>
    const authHeader = req.header('authorization');
    const expected = String(process.env.ADMIN_PHONE || '8264955651');
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'defaultsecret');
        if (decoded && String(decoded.phone) === expected) {
          // authorized as admin
        } else {
          return res.status(403).json({ error: 'Forbidden: not admin' });
        }
      } catch (e) {
        return res.status(401).json({ error: 'Invalid token' });
      }
    } else {
      // Fallback: header x-admin-phone
      const adminPhone = req.header('x-admin-phone');
      if (!adminPhone || String(adminPhone) !== expected) {
        return res.status(403).json({ error: 'Forbidden: invalid admin phone' });
      }
    }
    // attempt to delete via Supabase
    try {
      // delete dependent rows first for safety
      await supabase.from('tournament_players').delete().eq('tournament_id', id);
      await supabase.from('tournament_matches').delete().eq('tournament_id', id);
      const { data, error } = await supabase.from('tournaments').delete().eq('id', id).select().single();
      if (error) throw error;
      // Notify connected socket clients (if available)
      try {
        const io = req && req.app && req.app.locals && req.app.locals.io;
        if (io && typeof io.emit === 'function') io.emit('tournamentRemoved', { tournamentId: id, source: 'supabase' });
      } catch (e) {
        console.warn('Failed to emit tournamentRemoved (supabase):', e && e.message);
      }
      return res.json({ deleted: true, tournament: data, source: 'supabase' });
    } catch (supErr) {
      // Supabase not available or failed — try disk-backed store
      try {
        const mem = loadTournaments() || {};
        console.log('Memory keys:', Object.keys(mem));
        // Direct match first
        if (mem[id]) {
          delete mem[id];
          saveTournaments(mem);
          console.log(`Deleted ${id} from memory (direct match)`);
          try {
            const io = req && req.app && req.app.locals && req.app.locals.io;
            if (io && typeof io.emit === 'function') io.emit('tournamentRemoved', { tournamentId: id, source: 'memory' });
          } catch (e) {}
          return res.json({ deleted: true, tournamentId: id, source: 'memory' });
        }
        // Try to find by stored object id or by name as a fallback (helps when client sends slightly different id)
        const foundKey = Object.keys(mem).find((k) => {
          const t = mem[k];
          if (!t) return false;
          if (String(t.id) === String(id)) return true;
          if (String(k) === String(id)) return true;
          if (String(t.name) === String(id)) return true;
          // allow short-id suffix match
          if (String(t.id).endsWith(String(id))) return true;
          return false;
        });
        if (foundKey) {
          delete mem[foundKey];
          saveTournaments(mem);
          console.log(`Deleted ${foundKey} (matched for '${id}') from memory`);
          try {
            const io = req && req.app && req.app.locals && req.app.locals.io;
            if (io && typeof io.emit === 'function') io.emit('tournamentRemoved', { tournamentId: foundKey, source: 'memory', matchedFor: id });
          } catch (e) {
            console.warn('Failed to emit tournamentRemoved (memory):', e && e.message);
          }
          return res.json({ deleted: true, tournamentId: foundKey, source: 'memory', matchedFor: id });
        }
        console.log(`Tournament ${id} not found in memory`);
        return res.status(404).json({ error: 'Tournament not found in Supabase or memory' });
      } catch (e) {
        console.error('Delete memory fallback failed:', e && e.message);
        return res.status(500).json({ error: 'Delete failed', details: e?.message || e });
      }
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Soft-trash a tournament (admin only) - set status to 'trashed'
router.patch('/trash/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const expected = String(process.env.ADMIN_PHONE || '8264955651');
    // auth: JWT or x-admin-phone
    const authHeader = req.header('authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'defaultsecret');
        if (!decoded || String(decoded.phone) !== expected) return res.status(403).json({ error: 'Forbidden: not admin' });
      } catch (e) {
        return res.status(401).json({ error: 'Invalid token' });
      }
    } else {
      const adminPhone = req.header('x-admin-phone');
      if (!adminPhone || String(adminPhone) !== expected) return res.status(403).json({ error: 'Forbidden: invalid admin phone' });
    }

    // Try Supabase update first
    try {
      const { data: existing, error: selErr } = await supabase.from('tournaments').select('*').eq('id', id).single();
      if (!selErr && existing) {
        const { data, error } = await supabase.from('tournaments').update({ status: 'trashed' }).eq('id', id).select().single();
        if (error) throw error;
        try {
          const io = req && req.app && req.app.locals && req.app.locals.io;
          if (io && typeof io.emit === 'function') io.emit('tournamentTrashed', { tournamentId: id, tournament: data, source: 'supabase' });
        } catch (e) {}
        return res.json({ trashed: true, tournament: data, source: 'supabase' });
      }
    } catch (e) {
      // ignore and fallthrough to memory
    }

    // Memory-backed store fallback
    try {
      const mem = loadTournaments() || {};
      const t = mem[id] || Object.values(mem).find((x) => x && (String(x.id) === String(id) || String(x.name) === String(id)));
      if (!t) return res.status(404).json({ error: 'Tournament not found' });
      t.status = 'trashed';
      saveTournaments(mem);
      try {
        const io = req && req.app && req.app.locals && req.app.locals.io;
        if (io && typeof io.emit === 'function') io.emit('tournamentTrashed', { tournamentId: id, tournament: t, source: 'memory' });
      } catch (e) {}
      return res.json({ trashed: true, tournament: t, source: 'memory' });
    } catch (e) {
      return res.status(500).json({ error: 'Trash failed', details: e?.message || e });
    }
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'trash failed' });
  }
});

// Restore a trashed tournament back to waiting (admin only)
router.patch('/restore/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const expected = String(process.env.ADMIN_PHONE || '8264955651');
    const authHeader = req.header('authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'defaultsecret');
        if (!decoded || String(decoded.phone) !== expected) return res.status(403).json({ error: 'Forbidden: not admin' });
      } catch (e) {
        return res.status(401).json({ error: 'Invalid token' });
      }
    } else {
      const adminPhone = req.header('x-admin-phone');
      if (!adminPhone || String(adminPhone) !== expected) return res.status(403).json({ error: 'Forbidden: invalid admin phone' });
    }

    try {
      const { data: existing, error: selErr } = await supabase.from('tournaments').select('*').eq('id', id).single();
      if (!selErr && existing) {
        const { data, error } = await supabase.from('tournaments').update({ status: 'waiting' }).eq('id', id).select().single();
        if (error) throw error;
        try {
          const io = req && req.app && req.app.locals && req.app.locals.io;
          if (io && typeof io.emit === 'function') io.emit('tournamentRestored', { tournamentId: id, tournament: data, source: 'supabase' });
        } catch (e) {}
        return res.json({ restored: true, tournament: data, source: 'supabase' });
      }
    } catch (e) {}

    const mem = loadTournaments() || {};
    const t = mem[id] || Object.values(mem).find((x) => x && (String(x.id) === String(id) || String(x.name) === String(id)));
    if (!t) return res.status(404).json({ error: 'Tournament not found' });
    t.status = 'waiting';
    saveTournaments(mem);
    try {
      const io = req && req.app && req.app.locals && req.app.locals.io;
      if (io && typeof io.emit === 'function') io.emit('tournamentRestored', { tournamentId: id, tournament: t, source: 'memory' });
    } catch (e) {}
    return res.json({ restored: true, tournament: t, source: 'memory' });
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'restore failed' });
  }
});

// DEBUG: Unauthenticated delete (development only) - remove memory-backed tournament by id
// Use only for testing when Supabase is not configured. Example:
// GET /api/tournaments/debug/delete/t_dmoxker
router.get('/debug/delete/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const mem = loadTournaments() || {};
    if (!mem[id]) return res.status(404).json({ error: 'Not found in memory' });
    delete mem[id];
    saveTournaments(mem);
    console.log(`DEBUG: deleted ${id} from memory via debug endpoint`);
    return res.json({ deleted: true, tournamentId: id });
  } catch (e) {
    console.error('DEBUG delete failed:', e && e.message);
    return res.status(500).json({ error: e?.message || 'delete failed' });
  }
});

// API: start tournament by id (admin action)
// This updates the tournament status to 'in_progress' (supabase or memory) and emits a global tournamentStarted event.
router.post('/start/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'missing id' });
    // Try supabase update
    let tournament = null;
    try {
      const { data: t, error } = await supabase.from('tournaments').select('*').eq('id', id).single();
      if (!error && t) {
        await supabase.from('tournaments').update({ status: 'in_progress' }).eq('id', id);
        tournament = t;
        tournament.status = 'in_progress';
      }
    } catch (e) {
      // ignore
    }

    // If not in supabase, try memory store
    if (!tournament) {
      try {
        const mem = loadTournaments() || {};
        const t = mem[id] || Object.values(mem).find((x) => x && (x.id === id || x.name === id));
        if (t) {
          t.status = 'in_progress';
          saveTournaments(mem);
          tournament = t;
        }
      } catch (e) {}
    }

    if (!tournament) return res.status(404).json({ error: 'tournament not found' });

    // Emit socket event to all clients
    try {
      const io = req && req.app && req.app.locals && req.app.locals.io;
      if (io && typeof io.emit === 'function') {
        io.emit('tournamentStarted', { tournamentId: id, tournament });
      }
    } catch (e) {}

    return res.json({ started: true, tournament });
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'start failed' });
  }
});

export default router;

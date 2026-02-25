import dotenv from 'dotenv';
import supabase from './supabaseClient.js';

dotenv.config();

// Support both Twilio and WhatsApp Cloud API (Meta). Preference: Twilio if configured,
// otherwise use Cloud API when WHATSAPP_CLOUD_TOKEN and WHATSAPP_PHONE_NUMBER_ID are set.
// Test mode: Simulate messages without actual provider

let twilioClient = null;
const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM; // e.g. 'whatsapp:+14155238886'

const WHATSAPP_CLOUD_TOKEN = process.env.WHATSAPP_CLOUD_TOKEN; // Meta Graph API token
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID; // Meta Phone-Number-ID
const WHATSAPP_TEST_MODE = process.env.WHATSAPP_TEST_MODE === 'true'; // Enable mock/test mode

// Heuristic: detect when user mistakenly set raw sender phone number (e.g. 8288970850)
// into WHATSAPP_PHONE_NUMBER_ID. Meta expects a Phone Number ID (internal ID),
// not the E.164 phone. If we detect a likely raw phone number, provide a
// clearer error message to help debugging.
function isLikelyRawPhoneNumberId(val) {
  if (!val) return false;
  const s = String(val).trim();
  // if it has a plus or starts with whatsapp: it's probably not the internal ID
  if (/^[\+]/.test(s)) return true;
  // if it's all digits and shortish (<=12) it's likely a raw phone
  if (/^\d{6,12}$/.test(s)) return true;
  return false;
}

// Cache for discovered phone-number-ids keyed by raw phone string
const discoveredPhoneNumberIdCache = new Map();

// Try to discover Phone-Number-ID using the Graph API and the access token.
// This will query the token's accessible WhatsApp Business Accounts and their phone numbers.
async function discoverPhoneNumberIdFor(rawPhone) {
  if (!rawPhone) return null;
  if (discoveredPhoneNumberIdCache.has(rawPhone)) return discoveredPhoneNumberIdCache.get(rawPhone);
  if (!WHATSAPP_CLOUD_TOKEN) return null;
  const fetch = await getFetch();
  try {
    // Query for whatsapp_business_accounts and their phone_numbers
    const url = `https://graph.facebook.com/v17.0/me?fields=whatsapp_business_accounts{phone_numbers{display_phone_number,id}}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${WHATSAPP_CLOUD_TOKEN}` } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn('PhoneNumber discovery failed:', j?.error || res.status);
      return null;
    }

    const accounts = j?.whatsapp_business_accounts || [];
    for (const acct of accounts) {
      const pnums = acct?.phone_numbers || [];
      for (const p of pnums) {
        const display = String(p?.display_phone_number || '').replace(/[^0-9]/g, '');
        const target = String(rawPhone || '').replace(/[^0-9]/g, '');
        if (display && target && (display.endsWith(target) || target.endsWith(display) || display === target)) {
          discoveredPhoneNumberIdCache.set(rawPhone, p.id);
          console.log(`🔎 Discovered Phone-Number-ID ${p.id} for raw phone ${rawPhone}`);
          return p.id;
        }
      }
    }
    // not found
    return null;
  } catch (e) {
    console.warn('Failed to discover phone-number-id:', e && e.message);
    return null;
  }
}
function ensureTwilioClient() {
  if (!twilioClient) {
    if (!ACCOUNT_SID || !AUTH_TOKEN || !TWILIO_WHATSAPP_FROM) return null;
    // lazy require so server can run even if package not installed until feature used
    // eslint-disable-next-line global-require
    const Twilio = require('twilio');
    twilioClient = new Twilio(ACCOUNT_SID, AUTH_TOKEN);
  }
  return twilioClient;
}

// wrapper to get a fetch function (Node 18+ has global fetch)
let _fetch = typeof fetch === 'function' ? fetch : null;
async function getFetch() {
  if (_fetch) return _fetch;
  try {
    const mod = await import('node-fetch');
    _fetch = mod.default || mod;
    return _fetch;
  } catch (e) {
    throw new Error('Fetch is not available. Install node-fetch or run on Node 18+.');
  }
}

async function sendWhatsAppMessage(toNumber, body) {
  // Test/Mock Mode: Simulate message sending
  if (WHATSAPP_TEST_MODE) {
    console.log(`📱 [TEST MODE] WhatsApp message to ${toNumber}:`);
    console.log(`   "${body}"`);
    return { 
      sid: `test_${Date.now()}`, 
      status: 'queued',
      to: toNumber,
      message_id: `mock_${Math.random().toString(36).substring(7)}`
    };
  }

  // Prefer Twilio if available
  const tClient = ensureTwilioClient();
  if (tClient) {
    const to = String(toNumber).trim().startsWith('whatsapp:') ? String(toNumber).trim() : `whatsapp:${String(toNumber).trim()}`;
    return tClient.messages.create({ from: TWILIO_WHATSAPP_FROM, to, body });
  }

  // Otherwise use WhatsApp Cloud API (Meta)
  if (!WHATSAPP_CLOUD_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error('No WhatsApp provider configured. Set Twilio envs or WHATSAPP_CLOUD_TOKEN and WHATSAPP_PHONE_NUMBER_ID, or enable WHATSAPP_TEST_MODE=true for testing');
  }

  // If the configured value looks like a raw phone, try to discover the correct Phone-Number-ID automatically
  let effectivePhoneNumberId = WHATSAPP_PHONE_NUMBER_ID;
  if (isLikelyRawPhoneNumberId(WHATSAPP_PHONE_NUMBER_ID)) {
    console.log('⚠️ WHATSAPP_PHONE_NUMBER_ID looks like a raw phone number. Attempting discovery via Graph API...');
    const discovered = await discoverPhoneNumberIdFor(WHATSAPP_PHONE_NUMBER_ID).catch(() => null);
    if (discovered) {
      effectivePhoneNumberId = discovered;
    } else {
      const msg = `WHATSAPP_PHONE_NUMBER_ID appears to be a raw phone number (${WHATSAPP_PHONE_NUMBER_ID}) and discovery failed. Please set the Phone-Number-ID (Meta Developers -> WhatsApp -> Phone Numbers).`;
      const e = new Error(msg);
      e.meta = { guidance: 'Set WHATSAPP_PHONE_NUMBER_ID to the Phone Number ID (not the phone)', provided: WHATSAPP_PHONE_NUMBER_ID };
      throw e;
    }
  }

  const fetch = await getFetch();
  const to = String(toNumber).trim().replace(/^whatsapp:/, '');
  const url = `https://graph.facebook.com/v17.0/${effectivePhoneNumberId}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to: to,
    text: { body: String(body) },
    type: 'text',
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${WHATSAPP_CLOUD_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = j?.error?.message || `WhatsApp Cloud API error (${res.status})`;
    const e = new Error(err);
    e.meta = j;
    throw e;
  }
  return j;
}

// Try to get phone numbers for tournament players from Supabase or memory fallback
async function resolvePlayerPhones(tournamentId) {
  const phones = new Set();
  
  // Helper function to extract phone from various player object formats
  const extractPhoneFromPlayer = (p) => {
    if (!p) return null;
    const candidates = [
      p.phone,
      p.player_phone,
      p.phone_number,
      p.phoneNumber,
      p.playerPhone,
      p.player_phone_number,
      p.user_phone,
      p.mobile,
      p.mobileNumber,
      p.msisdn,
      p.phone_no,
      p.contact?.phone,
      p.contact?.phoneNumber,
      p.contact?.mobile,
      p.user?.phone,
      p.user?.phoneNumber,
      p.user?.mobile,
      p.player?.phone,
      p.player?.phoneNumber,
    ];
    
    for (const candidate of candidates) {
      if (candidate) {
        const normalized = String(candidate).trim();
        if (normalized) return normalized;
      }
    }
    return null;
  };
  
  try {
    // try supabase players table first
    const { data: players, error: pErr } = await supabase.from('tournament_players').select('*').eq('tournament_id', tournamentId);
    if (!pErr && Array.isArray(players)) {
      console.log(`📊 Found ${players.length} players in Supabase for tournament ${tournamentId}`);
      for (const p of players) {
        // try direct phone field first
        const directPhone = extractPhoneFromPlayer(p);
        if (directPhone) {
          phones.add(directPhone);
          console.log(`  ✓ Extracted phone from Supabase player: ${directPhone}`);
          continue;
        }
        
        // try to resolve user phone by player_id
        const pid = p.player_id;
        if (!pid) continue;
        try {
          const { data: u, error: uErr } = await supabase.from('users').select('phone').eq('id', pid).single();
          if (!uErr && u && u.phone) {
            phones.add(u.phone);
            console.log(`  ✓ Resolved phone from user table: ${u.phone}`);
          }
        } catch (e) {
          // ignore
        }
      }
    }
  } catch (e) {
    // ignore supabase errors
    console.log(`⚠️ Supabase query failed: ${e?.message}`);
  }
  
  // If no phones found in Supabase, try memory/disk-backed store
  if (phones.size === 0) {
    try {
      const mem = (await import('./persistentStore.js')).loadTournaments();
      const tournament = mem && mem[tournamentId] ? mem[tournamentId] : null;
      
      if (!tournament) {
        console.log(`❌ Tournament ${tournamentId} not found in memory store`);
        return Array.from(phones);
      }
      
      console.log(`📊 Found tournament ${tournamentId} in memory store`);
      
      if (tournament.players && Array.isArray(tournament.players)) {
        console.log(`   Processing ${tournament.players.length} players from disk store`);
        for (let i = 0; i < tournament.players.length; i++) {
          const p = tournament.players[i];
          
          // First try direct phone field
          const directPhone = extractPhoneFromPlayer(p);
          if (directPhone) {
            phones.add(directPhone);
            console.log(`    ✓ Player ${i} has direct phone: ${directPhone}`);
            continue;
          }
          
          // Try to look up phone by player_name in users table
          const playerName = p.player_name || p.name || p.username;
          if (playerName) {
            try {
              const { data: u, error: uErr } = await supabase.from('users').select('phone').eq('username', String(playerName)).single();
              if (!uErr && u && u.phone) {
                phones.add(u.phone);
                console.log(`    ✓ Player ${i} (${playerName}): resolved phone ${u.phone} from users table`);
                continue;
              }
            } catch (e) {
              // ignore per-player lookup
            }
          }
          
          // Try to look up by player_id
          const pid = p.player_id;
          if (pid) {
            try {
              const { data: u, error: uErr } = await supabase.from('users').select('phone').eq('id', String(pid)).single();
              if (!uErr && u && u.phone) {
                phones.add(u.phone);
                console.log(`    ✓ Player ${i}: resolved phone ${u.phone} from user ID`);
                continue;
              }
            } catch (e) {
              // ignore per-player lookup
            }
          }
          
          console.log(`    ✗ Player ${i}: No phone found (name: ${playerName}, id: ${pid})`);
        }
      } else {
        console.log(`   ❌ Tournament has no players array or not an array`);
      }
    } catch (e) {
      console.warn('Failed to check disk-backed tournament for phones:', e?.message);
    }
  }
  
  console.log(`📱 Total phones resolved for tournament ${tournamentId}: ${phones.size}`);
  return Array.from(phones);
}

// Send a reminder to an array of numbers (E.164 without whatsapp: prefix)
async function sendReminderToNumbers(numbers = [], message = '') {
  if (!numbers || !numbers.length) return { sent: 0 };
  const results = [];
  for (const n of numbers) {
    try {
      const r = await sendWhatsAppMessage(n, message);
      results.push({ to: n, sid: r.sid, status: r.status });
    } catch (e) {
      // include any Graph API meta object if present to help debugging
      const meta = e && e.meta ? e.meta : null;
      results.push({ to: n, error: String(e.message || e), meta });
    }
  }
  return { sent: results.filter((r) => !r.error).length, results };
}

// Attach express routes to the app
export default function attachWhatsAppRoutes(app) {
  console.log('🔗 Attaching WhatsApp reminder routes...');
  
  // send ad-hoc reminder to explicit numbers
  app.post('/api/reminders/send', async (req, res) => {
    try {
      const { numbers, message } = req.body || {};
      if (!Array.isArray(numbers) || numbers.length === 0) return res.status(400).json({ error: 'numbers required' });
      if (!message) return res.status(400).json({ error: 'message required' });
      const result = await sendReminderToNumbers(numbers, message);
      return res.json(result);
    } catch (e) {
      return res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // Schedule a reminder for a tournament at X minutes before its start time
  // Body: { minutesBefore: number, message?: string }
  // This uses in-memory timers (won't survive server restart).
  app.post('/api/reminders/schedule/:id', async (req, res) => {
    try {
      const id = req.params.id;
      const { minutesBefore = 10, message } = req.body || {};
      if (!id) return res.status(400).json({ error: 'missing tournament id' });

      // Try to fetch tournament row from Supabase first
      let tournament = null;
      try {
        const { data: t } = await supabase.from('tournaments').select('*').eq('id', id).single();
        tournament = t || null;
      } catch (e) {
        // ignore
      }

      // If not in supabase, try memory file
      if (!tournament) {
        try {
          const mem = (await import('./persistentStore.js')).loadTournaments();
          tournament = mem && mem[id] ? mem[id] : null;
        } catch (e) {}
      }

      if (!tournament) return res.status(404).json({ error: 'tournament not found' });

      // determine start time field
      const startRaw = tournament.starts_at || tournament.start_time || tournament.scheduled_at || tournament.created_at;
      const startTime = startRaw ? new Date(startRaw) : null;
      if (!startTime || isNaN(startTime)) {
        // If no valid start time, schedule immediate send
        const nums = await resolvePlayerPhones(id);
        const result = await sendReminderToNumbers(nums, message || `Reminder: Tournament ${tournament.name || id} is starting soon.`);
        return res.json({ scheduled: false, sentNow: true, result });
      }

      const when = new Date(startTime.getTime() - (Number(minutesBefore) || 10) * 60000);
      const now = new Date();
      const delay = when - now;
      const payloadMsg = message || `Reminder: Tournament ${tournament.name || id} starts at ${startTime.toISOString()}. Please join on time.`;

      if (delay <= 0) {
        // time already passed — send immediately
        const nums = await resolvePlayerPhones(id);
        const result = await sendReminderToNumbers(nums, payloadMsg);
        return res.json({ scheduled: false, sentNow: true, result });
      }

      // clear existing timer if present
      if (scheduled.has(id)) {
        clearTimeout(scheduled.get(id));
        scheduled.delete(id);
      }

      const timer = setTimeout(async () => {
        try {
          const nums = await resolvePlayerPhones(id);
          await sendReminderToNumbers(nums, payloadMsg);
        } catch (e) {
          console.error('scheduled reminder failed for', id, e && e.message);
        } finally {
          scheduled.delete(id);
        }
      }, delay);

      scheduled.set(id, timer);
      return res.json({ scheduled: true, sendAt: when.toISOString(), minutesBefore: Number(minutesBefore) });
    } catch (e) {
      return res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // send reminder to all players of a tournament (attempt to resolve phones via Supabase)
  app.post('/api/reminders/tournament/:id', async (req, res) => {
    try {
      const id = req.params.id;
      const { message } = req.body || {};
      console.log('📨 Send reminder endpoint called for tournament:', id);
      
      if (!id) return res.status(400).json({ error: 'missing tournament id' });
      const numbers = await resolvePlayerPhones(id);
      console.log(`📞 Resolved ${numbers.length} player phone numbers for tournament ${id}`);
      
      if (!numbers.length) {
        console.log('❌ No player phones found for tournament:', id);
        return res.status(404).json({ error: 'no player phones found' });
      }
      
      const msg = message || `Reminder: Tournament ${id} is starting soon. Join on time!`;
      console.log('📤 Sending reminders to', numbers.length, 'players');
      const result = await sendReminderToNumbers(numbers, msg);
      console.log('✅ Reminders sent successfully:', result);
      return res.json(result);
    } catch (e) {
      console.error('❌ Reminder send failed:', e?.message);
      return res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // Debug endpoint: attempt to discover Phone-Number-ID for configured WHATSAPP_PHONE_NUMBER_ID
  app.get('/api/reminders/discover_phone_number_id', async (req, res) => {
    try {
      const configured = WHATSAPP_PHONE_NUMBER_ID || null;
      if (!configured) return res.status(400).json({ error: 'WHATSAPP_PHONE_NUMBER_ID not configured in server env' });
      if (!isLikelyRawPhoneNumberId(configured)) {
        return res.json({ configured, note: 'Configured value does not look like a raw phone number; assuming it is a Phone-Number-ID' });
      }
      const discovered = await discoverPhoneNumberIdFor(configured);
      if (!discovered) return res.status(404).json({ error: 'could not discover phone-number-id for configured value', configured });
      return res.json({ configured, discovered });
    } catch (e) {
      return res.status(500).json({ error: e?.message || String(e), meta: e && e.meta });
    }
  });

  console.log('✅ WhatsApp reminder routes attached successfully');
}

// Keep scheduled timers at module scope so other code can reuse scheduling
const scheduled = new Map();

// Programmatic scheduler: schedule a reminder for a tournament id (same logic as the HTTP route)
export async function scheduleTournamentReminder(id, opts = {}) {
  const { minutesBefore = 15, message } = opts || {};
  if (!id) throw new Error('missing tournament id');

  // Try to fetch tournament row from Supabase first
  let tournament = null;
  try {
    const { data: t } = await supabase.from('tournaments').select('*').eq('id', id).single();
    tournament = t || null;
  } catch (e) {
    // ignore
  }

  // If not in supabase, try memory file
  if (!tournament) {
    try {
      const mem = (await import('./persistentStore.js')).loadTournaments();
      tournament = mem && mem[id] ? mem[id] : null;
    } catch (e) {}
  }

  if (!tournament) throw new Error('tournament not found');

  // determine start time field
  const startRaw = tournament.starts_at || tournament.start_time || tournament.scheduled_at || tournament.created_at;
  const startTime = startRaw ? new Date(startRaw) : null;
  if (!startTime || isNaN(startTime)) {
    // send immediate
    const nums = await resolvePlayerPhones(id);
    const result = await sendReminderToNumbers(nums, message || `Reminder: Tournament ${tournament.name || id} is starting soon.`);
    return { scheduled: false, sentNow: true, result };
  }

  const when = new Date(startTime.getTime() - (Number(minutesBefore) || 15) * 60000);
  const now = new Date();
  const delay = when - now;
  const payloadMsg = message || `Reminder: Tournament ${tournament.name || id} starts at ${startTime.toISOString()}. Please join on time.`;

  if (delay <= 0) {
    const nums = await resolvePlayerPhones(id);
    const result = await sendReminderToNumbers(nums, payloadMsg);
    return { scheduled: false, sentNow: true, result };
  }

  // clear existing timer if present
  if (scheduled.has(id)) {
    clearTimeout(scheduled.get(id));
    scheduled.delete(id);
  }

  const timer = setTimeout(async () => {
    try {
      const nums = await resolvePlayerPhones(id);
      await sendReminderToNumbers(nums, payloadMsg);
    } catch (e) {
      console.error('scheduled reminder failed for', id, e && e.message);
    } finally {
      scheduled.delete(id);
    }
  }, delay);

  scheduled.set(id, timer);
  return { scheduled: true, sendAt: when.toISOString(), minutesBefore: Number(minutesBefore) };
}

export { sendWhatsAppMessage, sendReminderToNumbers, resolvePlayerPhones };

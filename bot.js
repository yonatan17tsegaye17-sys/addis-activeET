const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Telegraf } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

// ---- Env (same names you already use) ----
const BOT_TOKEN = process.env.BOT_TOKEN;
const APP_URL = process.env.APP_URL || 'https://addis-active.vercel.app';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || null; // optional

const bot = new Telegraf(BOT_TOKEN || 'missing-token');
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

let INDEX_HTML = '<h1>Addis Active</h1><p>public/index.html not found.</p>';
try {
  INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
} catch (e) {
  console.error('Could not read public/index.html', e);
}

const ACTIVITY_TYPES = ['RUNNING', 'WALKING', 'CYCLING', 'FOOTBALL', 'HIKING', 'SWIMMING', 'GYM', 'OTHER'];
const REAL_STATUSES = new Set(['UPCOMING', 'LIVE', 'COMPLETED']); // DEMO/DRAFT give no XP
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- Telegram initData validation (server-side) ----
function verifyInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  const a = Buffer.from(calc, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null; // 24h
  try {
    return JSON.parse(params.get('user'));
  } catch (e) {
    return null;
  }
}

async function upsertUser(tg) {
  const { data, error } = await supabase
    .from('users')
    .upsert(
      {
        telegram_id: tg.id,
        first_name: tg.first_name || null,
        last_name: tg.last_name || null,
        username: tg.username || null,
        photo_url: tg.photo_url || null
      },
      { onConflict: 'telegram_id' }
    )
    .select('id, first_name, username, onboarded_at')
    .single();
  if (error) throw error;
  return data;
}

// XP is computed from real rows, never stored or client-supplied.
function computeXp(participations, records) {
  let xp = 0;
  for (const p of participations) {
    if (p.activities && REAL_STATUSES.has(p.activities.status)) xp += 10;
  }
  const perDay = {};
  for (const r of records) {
    const day = String(r.performed_at).slice(0, 10);
    perDay[day] = (perDay[day] || 0) + 1;
    if (perDay[day] > 3) continue; // manual logs are self-reported: max 3/day count
    xp += 20 + Math.min(Math.floor(Number(r.distance_km || 0)), 10) * 3;
  }
  return xp;
}

const json = (res, code, body) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(code).json(body);
};

// ---- GET /api/bootstrap ----
async function bootstrap(req, res) {
  const tgUser = verifyInitData(req.headers['x-telegram-init-data']);

  const [places, acts, comms] = await Promise.all([
    supabase
      .from('places')
      .select('id,slug,name,area,place_type,description,activity_types,featured,data_status,verification,tags,media:media_id(media_type,url,thumbnail,caption,video_status,is_placeholder)')
      .neq('verification', 'ARCHIVED')
      .order('featured', { ascending: false })
      .order('name'),
    supabase
      .from('activities')
      .select('id,name,description,category,date,time,place_id,community_id,location,status')
      .neq('status', 'CANCELLED')
      .order('date', { ascending: true, nullsFirst: false }),
    supabase
      .from('communities')
      .select('id,slug,name,description,activity_type,tagline,schedule,social_links,data_status,verification,primary_place_id')
      .neq('verification', 'ARCHIVED')
      .order('name')
  ]);
  for (const r of [places, acts, comms]) if (r.error) throw r.error;

  let me = null;
  let joined = [];
  let records = [];
  if (tgUser) {
    const u = await upsertUser(tgUser);
    const [pr, rr] = await Promise.all([
      supabase
        .from('participations')
        .select('activity_id,status,activities(status)')
        .eq('user_id', u.id)
        .neq('status', 'CANCELLED'),
      supabase
        .from('activity_records')
        .select('id,type,distance_km,duration_seconds,place_id,performed_at')
        .eq('user_id', u.id)
        .order('performed_at', { ascending: false })
        .limit(500)
    ]);
    if (pr.error) throw pr.error;
    if (rr.error) throw rr.error;
    const xp = computeXp(pr.data, rr.data);
    me = { onboarded: !!u.onboarded_at, first_name: u.first_name, username: u.username, xp, level: Math.floor(xp / 100) + 1 };
    joined = pr.data.map((x) => x.activity_id);
    records = rr.data;
  }

  return json(res, 200, {
    success: true,
    me,
    joined,
    records,
    places: places.data,
    activities: acts.data,
    communities: comms.data
  });
}

// ---- POST /api/join ----
async function join(req, res) {
  const tgUser = verifyInitData(req.headers['x-telegram-init-data']);
  if (!tgUser) return json(res, 401, { success: false, error: 'Open Addis Active from Telegram to join.' });

  const { activityId } = req.body || {};
  if (typeof activityId !== 'string' || !UUID_RE.test(activityId)) {
    return json(res, 400, { success: false, error: 'Invalid activity.' });
  }

  const user = await upsertUser(tgUser);
  const { data: act, error: actErr } = await supabase
    .from('activities')
    .select('id,name,status')
    .eq('id', activityId)
    .maybeSingle();
  if (actErr) throw actErr;
  if (!act) return json(res, 404, { success: false, error: 'Activity not found.' });
  if (act.status === 'CANCELLED' || act.status === 'COMPLETED') {
    return json(res, 409, { success: false, error: 'This activity is no longer open.' });
  }

  const { error } = await supabase
    .from('participations')
    .insert({ user_id: user.id, activity_id: act.id, status: 'JOINED' });

  if (error) {
    if (error.code === '23505') return json(res, 200, { success: true, message: `You already joined ${act.name}.` });
    throw error;
  }
  const demo = !REAL_STATUSES.has(act.status);
  return json(res, 200, {
    success: true,
    message: demo
      ? `Saved: ${act.name}. This is a DEMO activity, not an official event, so it earns no XP.`
      : `You're in: ${act.name}.`
  });
}

// ---- POST /api/log ----
async function logActivity(req, res) {
  const tgUser = verifyInitData(req.headers['x-telegram-init-data']);
  if (!tgUser) return json(res, 401, { success: false, error: 'Open Addis Active from Telegram to log activities.' });

  const { type, distanceKm, minutes, placeId, performedAt } = req.body || {};
  if (!ACTIVITY_TYPES.includes(type)) return json(res, 400, { success: false, error: 'Choose an activity type.' });

  const dist = distanceKm === '' || distanceKm == null ? null : Number(distanceKm);
  const mins = minutes === '' || minutes == null ? null : Number(minutes);
  if (dist !== null && (!Number.isFinite(dist) || dist < 0 || dist > 300)) {
    return json(res, 400, { success: false, error: 'Distance must be between 0 and 300 km.' });
  }
  if (mins !== null && (!Number.isFinite(mins) || mins < 1 || mins > 1440)) {
    return json(res, 400, { success: false, error: 'Duration must be between 1 and 1440 minutes.' });
  }
  if (dist === null && mins === null) {
    return json(res, 400, { success: false, error: 'Enter a distance or a duration.' });
  }

  let when = new Date();
  if (performedAt) {
    const d = new Date(performedAt);
    const now = Date.now();
    if (isNaN(d) || d.getTime() > now + 5 * 60 * 1000 || d.getTime() < now - 30 * 86400 * 1000) {
      return json(res, 400, { success: false, error: 'Date must be within the last 30 days.' });
    }
    when = d;
  }
  if (placeId && !UUID_RE.test(placeId)) return json(res, 400, { success: false, error: 'Invalid place.' });

  const user = await upsertUser(tgUser);
  const { error } = await supabase.from('activity_records').insert({
    user_id: user.id,
    place_id: placeId || null,
    type,
    distance_km: dist,
    duration_seconds: mins === null ? null : Math.round(mins * 60),
    source: 'manual',
    performed_at: when.toISOString()
  });
  if (error) throw error;
  return json(res, 200, { success: true, message: 'Activity saved.' });
}

// ---- Telegram bot (onboarding lives in onboarding.js) ----
require('./onboarding')(bot, { supabase, upsertUser, appUrl: APP_URL });

// ---- Entry point ----
module.exports = async (req, res) => {
  const p = new URL(req.url, 'http://localhost').pathname;
  try {
    if (p === '/api/bootstrap' && req.method === 'GET') return await bootstrap(req, res);
    if (p === '/api/join' && req.method === 'POST') return await join(req, res);
    if (p === '/api/log' && req.method === 'POST') return await logActivity(req, res);

    if (req.method === 'POST') {
      if (WEBHOOK_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) {
        return res.status(401).send('Unauthorized');
      }
      await bot.handleUpdate(req.body);
      return res.status(200).send('OK');
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(INDEX_HTML);
  } catch (err) {
    console.error('Handler error:', err);
    return json(res, 500, { success: false, error: 'Something went wrong. Please try again.' });
  }
};

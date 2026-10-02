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

const icons = require('./icons');
const MANIFEST = JSON.stringify({
  name: 'Addis Active', short_name: 'Addis Active', start_url: '/', scope: '/', display: 'standalone',
  background_color: '#0a1020', theme_color: '#0a1020',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
  ]
});
// Network-first service worker: always fetch fresh, fall back to cache when offline. Never caches /api.
const SW = [
  "const C='addis-active-v2';",
  "self.addEventListener('install',()=>self.skipWaiting());",
  "self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim())));",
  "self.addEventListener('fetch',e=>{const u=new URL(e.request.url);",
  "if(e.request.method!=='GET'||u.origin!==location.origin||u.pathname.startsWith('/api/'))return;",
  "e.respondWith(fetch(e.request).then(r=>{const c=r.clone();caches.open(C).then(x=>x.put(e.request,c));return r}).catch(()=>caches.match(e.request).then(m=>m||caches.match('/'))))});"
].join('\n');

const ACTIVITY_TYPES = ['RUNNING', 'WALKING', 'CYCLING', 'FOOTBALL', 'HIKING', 'SWIMMING', 'GYM', 'STRENGTH', 'OTHER'];
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

// ---- Website sign-in: Telegram Login Widget -> signed session token ----
const sessionKey = () => crypto.createHmac('sha256', 'aa-session').update(BOT_TOKEN || '').digest();
function signSession(u) {
  const body = Buffer.from(JSON.stringify({
    id: u.id, first_name: u.first_name || null, last_name: u.last_name || null,
    username: u.username || null, photo_url: u.photo_url || null, exp: Date.now() + 30 * 86400e3
  })).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', sessionKey()).update(body).digest('base64url');
}
function verifySession(tok) {
  const [body, sig] = String(tok).split('.');
  if (!body || !sig) return null;
  const calc = crypto.createHmac('sha256', sessionKey()).update(body).digest('base64url');
  const a = Buffer.from(calc), b = Buffer.from(sig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch (e) {
    return null;
  }
}
function verifyLoginWidget(d) {
  if (!d || !d.hash || !BOT_TOKEN) return null;
  const { hash, ...rest } = d;
  const s = Object.keys(rest).sort().map((k) => `${k}=${rest[k]}`).join('\n');
  const key = crypto.createHash('sha256').update(BOT_TOKEN).digest();
  const a = Buffer.from(crypto.createHmac('sha256', key).update(s).digest('hex'), 'hex');
  const b = Buffer.from(String(hash), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Date.now() / 1000 - Number(d.auth_date || 0) > 86400) return null;
  return { id: Number(d.id), first_name: d.first_name, last_name: d.last_name, username: d.username, photo_url: d.photo_url };
}
// Mini app (signed initData) OR website (signed session token)
function authTg(req) {
  const init = verifyInitData(req.headers['x-telegram-init-data']);
  if (init) return init;
  const m = /^Bearer (.+)$/.exec(req.headers['authorization'] || '');
  return m ? verifySession(m[1]) : null;
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
function computeXp(participations, records, goals = []) {
  let xp = 0;
  xp += 50 * goals.filter((g) => g.done).length; // achieved goals
  for (const p of participations) {
    if (p.activities && REAL_STATUSES.has(p.activities.status)) xp += 10;
  }
  const perDay = {};
  for (const r of records) {
    const day = String(r.performed_at).slice(0, 10);
    perDay[day] = (perDay[day] || 0) + 1;
    if (perDay[day] > 3) continue; // manual logs are self-reported: max 3/day count
    xp += 20 + Math.min(Math.floor(Number(r.distance_km || 0)), 10) * 3;
    if (r.source === 'gps') xp += 10; // GPS-recorded moves are more verifiable
  }
  return xp;
}

const json = (res, code, body) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(code).json(body);
};

// ---- Goals + challenges (progress is always computed from real records) ----
const GOAL_TYPES = ['SINGLE_DISTANCE', 'DISTANCE_TOTAL', 'DAYS_ACTIVE', 'ACTIVITY_COUNT'];
const GOAL_UNITS = ['km', 'days', 'activities'];
const etDay = (iso) => new Date(new Date(iso).getTime() + 3 * 3600e3).toISOString().slice(0, 10); // Addis = UTC+3
function weekStartET() {
  const d = new Date(Date.now() + 3 * 3600e3);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
function goalProgress(g, records) {
  const since = new Date(g.created_at).getTime();
  const rs = records.filter((r) => new Date(r.performed_at).getTime() >= since && (!g.activity_type || r.type === g.activity_type));
  let v;
  if (g.goal_type === 'SINGLE_DISTANCE') v = Math.max(0, ...rs.map((r) => Number(r.distance_km || 0)));
  else if (g.goal_type === 'DISTANCE_TOTAL') v = rs.reduce((s, r) => s + Number(r.distance_km || 0), 0);
  else if (g.goal_type === 'DAYS_ACTIVE') v = new Set(rs.map((r) => etDay(r.performed_at))).size;
  else v = rs.length;
  return Number(v.toFixed(2));
}
function computeChallenges(records, parts) {
  const ws = weekStartET();
  const wk = records.filter((r) => etDay(r.performed_at) >= ws);
  const days = new Set(wk.map((r) => etDay(r.performed_at))).size;
  const weekend = wk.some((r) => { const d = new Date(etDay(r.performed_at) + 'T00:00:00Z').getUTCDay(); return d === 0 || d === 6; });
  const month = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 7);
  const comm = parts.filter((p) => p.activities && REAL_STATUSES.has(p.activities.status) && p.activities.community_id && String(p.joined_at).slice(0, 7) === month).length;
  return [
    { name: 'MOVE ADDIS', desc: 'Be active 3 days this week', progress: Math.min(days, 3), target: 3 },
    { name: 'WEEKEND MOVER', desc: 'Log an activity this weekend', progress: weekend ? 1 : 0, target: 1 },
    { name: 'COMMUNITY MONTH', desc: 'Join 4 community activities this month', progress: Math.min(comm, 4), target: 4 }
  ].map((c) => ({ ...c, done: c.progress >= c.target }));
}

// ---- GET /api/bootstrap ----
async function bootstrap(req, res) {
  const tgUser = authTg(req);

  const [places, acts, comms] = await Promise.all([
    supabase
      .from('places')
      .select('id,slug,name,area,place_type,latitude,longitude,description,activity_types,featured,data_status,verification,tags,media:media_id(media_type,url,thumbnail,caption,video_status,is_placeholder)')
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
  let goals = [];
  let chal = [];
  if (tgUser) {
    const u = await upsertUser(tgUser);
    const [pr, rr] = await Promise.all([
      supabase
        .from('participations')
        .select('activity_id,status,joined_at,activities(status,community_id)')
        .eq('user_id', u.id)
        .neq('status', 'CANCELLED'),
      supabase
        .from('activity_records')
        .select('id,type,distance_km,duration_seconds,place_id,performed_at,source')
        .eq('user_id', u.id)
        .order('performed_at', { ascending: false })
        .limit(500)
    ]);
    if (pr.error) throw pr.error;
    if (rr.error) throw rr.error;
    const gr = await supabase
      .from('goals')
      .select('id,name,goal_type,activity_type,target,unit,deadline,frequency,plan,status,created_at')
      .eq('user_id', u.id)
      .neq('status', 'ABANDONED')
      .order('created_at', { ascending: false });
    if (gr.error) throw gr.error;
    goals = gr.data.map((g) => {
      const progress = goalProgress(g, rr.data);
      return { ...g, target: Number(g.target), progress, done: progress >= Number(g.target) };
    });
    chal = computeChallenges(rr.data, pr.data);
    const xp = computeXp(pr.data, rr.data, goals);
    const tc = await supabase.from('cell_owners').select('cx', { count: 'exact', head: true }).eq('user_id', u.id);
    me = { territory: tc.count || 0, onboarded: !!u.onboarded_at, first_name: u.first_name, username: u.username, xp, level: Math.floor(xp / 100) + 1 };
    joined = pr.data.map((x) => x.activity_id);
    records = rr.data;
  }

  return json(res, 200, {
    success: true,
    me,
    joined,
    records,
    goals,
    challenges: chal,
    // coordinates are only exposed for places marked VERIFIED
    places: places.data.map((p) => (p.verification === 'VERIFIED' ? p : { ...p, latitude: null, longitude: null })),
    activities: acts.data,
    communities: comms.data
  });
}

// ---- POST /api/join ----
async function join(req, res) {
  const tgUser = authTg(req);
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
  const tgUser = authTg(req);
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

// ---- POST /api/track (GPS) ----
const MAXV = { RUNNING: 9, WALKING: 4, HIKING: 4, CYCLING: 20, FOOTBALL: 9, SWIMMING: 3, GYM: 9, STRENGTH: 9, OTHER: 9 }; // max m/s
function hav(a, b) {
  const R = 6371000, r = (x) => (x * Math.PI) / 180;
  const dl = r(b.lat - a.lat), dg = r(b.lng - a.lng);
  const q = Math.sin(dl / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dg / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(q));
}
async function track(req, res) {
  const tgUser = authTg(req);
  if (!tgUser) return json(res, 401, { success: false, error: 'Open Addis Active from Telegram to track.' });
  const { type, points } = req.body || {};
  if (!ACTIVITY_TYPES.includes(type)) return json(res, 400, { success: false, error: 'Choose an activity type.' });
  if (!Array.isArray(points) || points.length < 2 || points.length > 6000) {
    return json(res, 400, { success: false, error: 'Not enough GPS data.' });
  }
  const pts = [];
  for (const p of points) {
    const lat = Number(p.lat), lng = Number(p.lng), t = Number(p.t);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(t) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    if (pts.length && t <= pts[pts.length - 1].t) continue;
    pts.push({ lat, lng, t });
  }
  if (pts.length < 2) return json(res, 400, { success: false, error: 'Not enough GPS data.' });
  const now = Date.now();
  if (pts[0].t < now - 86400000 || pts[pts.length - 1].t > now + 300000) {
    return json(res, 400, { success: false, error: 'Invalid track time.' });
  }
  let dist = 0, secs = 0, bad = 0, segs = 0;
  const okSegs = [];
  for (let i = 1; i < pts.length; i++) {
    const dt = (pts[i].t - pts[i - 1].t) / 1000;
    if (dt < 1 || dt > 120) continue; // gaps (screen locked) are not counted
    segs++;
    const d = hav(pts[i - 1], pts[i]);
    if (d / dt > MAXV[type]) { bad++; continue; }
    dist += d; secs += dt; okSegs.push([pts[i - 1], pts[i], d]);
  }
  if (!segs) return json(res, 400, { success: false, error: 'Not enough continuous GPS data. Keep the screen on while tracking.' });
  if (bad / segs > 0.2) return json(res, 400, { success: false, error: 'The GPS track looks unrealistic for this activity, so it was not saved.' });
  if (dist < 50) return json(res, 400, { success: false, error: 'Too short to save (under 50 m).' });
  const step = Math.ceil(pts.length / 500);
  const user = await upsertUser(tgUser);
  const { error } = await supabase.from('activity_records').insert({
    user_id: user.id,
    type,
    distance_km: Number((dist / 1000).toFixed(2)),
    duration_seconds: Math.round(secs),
    gps_track: pts.filter((_, i) => i % step === 0),
    source: 'gps',
    performed_at: new Date(pts[0].t).toISOString()
  });
  if (error) throw error;
  // Claim map zones from the validated part of the track
  const cells = new Set();
  for (const [a, c2, d] of okSegs) {
    const n = Math.max(1, Math.ceil(d / 60));
    for (let k = 0; k <= n; k++) {
      const f = k / n;
      cells.add(`${Math.floor((a.lng + (c2.lng - a.lng) * f) / CELL)},${Math.floor((a.lat + (c2.lat - a.lat) * f) / CELL)}`);
    }
    if (cells.size >= 400) break;
  }
  const intensity = Math.min(5, 1 + Math.floor(((dist / secs) * 3.6) / 4));
  const day = etDay(new Date(pts[0].t).toISOString());
  const rows = [...cells].map((c) => { const [cx, cy] = c.split(',').map(Number); return { user_id: user.id, cx, cy, day, intensity }; });
  let zones = 0;
  if (rows.length) {
    const cr = await supabase.from('cell_visits').upsert(rows, { onConflict: 'user_id,cx,cy,day' });
    if (cr.error) console.error('cell_visits', cr.error); else zones = rows.length;
  }
  return json(res, 200, { success: true, message: `Saved: ${(dist / 1000).toFixed(2)} km in ${Math.round(secs / 60)} min. ${zones} map zone${zones === 1 ? '' : 's'} visited.` });
}

// ---- POST /api/goal ----
async function createGoal(req, res) {
  const tgUser = authTg(req);
  if (!tgUser) return json(res, 401, { success: false, error: 'Open Addis Active from Telegram to set goals.' });
  const { name, goalType, activityType, target, unit, deadline, frequency, plan } = req.body || {};
  const t = Number(target);
  if (typeof name !== 'string' || !name.trim() || name.length > 60) return json(res, 400, { success: false, error: 'Give your goal a short name.' });
  if (!GOAL_TYPES.includes(goalType) || !GOAL_UNITS.includes(unit)) return json(res, 400, { success: false, error: 'Invalid goal.' });
  if (!Number.isFinite(t) || t <= 0 || t > 100000) return json(res, 400, { success: false, error: 'Invalid target.' });
  if (activityType && !ACTIVITY_TYPES.includes(activityType)) return json(res, 400, { success: false, error: 'Invalid activity.' });
  if (deadline && (isNaN(new Date(deadline)) || new Date(deadline) > new Date(Date.now() + 400 * 86400e3))) return json(res, 400, { success: false, error: 'Invalid deadline.' });
  const cleanPlan = Array.isArray(plan) && plan.length <= 16 ? plan.map((x) => String(x).slice(0, 240)) : null;
  const user = await upsertUser(tgUser);
  const { count } = await supabase.from('goals').select('id', { count: 'exact', head: true }).eq('user_id', user.id).eq('status', 'ACTIVE');
  if ((count || 0) >= 10) return json(res, 409, { success: false, error: 'You already have 10 active goals.' });
  const { error } = await supabase.from('goals').insert({
    user_id: user.id, name: name.trim(), goal_type: goalType, activity_type: activityType || null,
    target: t, unit, deadline: deadline || null, frequency: frequency ? String(frequency).slice(0, 40) : null,
    plan: cleanPlan, status: 'ACTIVE'
  });
  if (error) throw error;
  return json(res, 200, { success: true, message: 'Goal saved. Every logged move now counts toward it.' });
}

// ---- GET /api/territory (anonymised: other movers are never named) ----
const CELL = 0.0025; // degrees, ~275 m
async function territory(req, res) {
  const tgUser = authTg(req);
  const uid = tgUser ? (await upsertUser(tgUser)).id : null;
  const q = new URL(req.url, 'http://localhost').searchParams;
  const [s, w, n, e] = ['s', 'w', 'n', 'e'].map((k) => Number(q.get(k)));
  if ([s, w, n, e].some((v) => !Number.isFinite(v)) || n < s || e < w || n - s > 0.2 || e - w > 0.2) {
    return json(res, 400, { success: false, error: 'Invalid area.' });
  }
  const { data, error } = await supabase
    .from('cell_owners')
    .select('cx,cy,user_id,score')
    .gte('cx', Math.floor(w / CELL)).lte('cx', Math.floor(e / CELL))
    .gte('cy', Math.floor(s / CELL)).lte('cy', Math.floor(n / CELL))
    .limit(5000);
  if (error) throw error;
  return json(res, 200, { success: true, cells: data.map((c) => ({ x: c.cx, y: c.cy, m: c.user_id === uid ? 1 : 0, s: c.score })) });
}

// ---- GET /api/leaderboard (anonymous: shows zone counts, never names) ----
async function leaderboard(req, res) {
  const tgUser = authTg(req);
  const uid = tgUser ? (await upsertUser(tgUser)).id : null;
  let rows = [];
  for (let i = 0; i < 20; i++) {
    const { data, error } = await supabase.from('cell_owners').select('user_id').order('cx').order('cy').range(i * 1000, i * 1000 + 999);
    if (error) throw error;
    rows = rows.concat(data);
    if (data.length < 1000) break;
  }
  const counts = {};
  for (const r of rows) counts[r.user_id] = (counts[r.user_id] || 0) + 1;
  const arr = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const idx = arr.findIndex(([id]) => id === uid);
  return json(res, 200, {
    success: true,
    movers: arr.length,
    rank: idx >= 0 ? idx + 1 : null,
    top: arr.slice(0, 10).map(([id, n]) => ({ zones: n, me: id === uid ? 1 : 0 }))
  });
}

// ---- POST /api/web-login ----
async function webLogin(req, res) {
  const u = verifyLoginWidget(req.body);
  if (!u) return json(res, 401, { success: false, error: 'Sign-in could not be verified.' });
  await upsertUser(u);
  return json(res, 200, { success: true, token: signSession(u) });
}

// ---- Telegram bot (onboarding lives in onboarding.js) ----
require('./onboarding')(bot, { supabase, upsertUser, appUrl: APP_URL });

// ---- Entry point ----
module.exports = async (req, res) => {
  const p = new URL(req.url, 'http://localhost').pathname;
  try {
    if (p === '/api/bootstrap' && req.method === 'GET') return await bootstrap(req, res);
    if (p === '/api/config' && req.method === 'GET') return json(res, 200, { success: true, botUsername: process.env.BOT_USERNAME || null });
    if (p === '/api/web-login' && req.method === 'POST') return await webLogin(req, res);
    if (p === '/api/join' && req.method === 'POST') return await join(req, res);
    if (p === '/api/log' && req.method === 'POST') return await logActivity(req, res);
    if (p === '/api/track' && req.method === 'POST') return await track(req, res);
    if (p === '/api/goal' && req.method === 'POST') return await createGoal(req, res);
    if (p === '/api/territory' && req.method === 'GET') return await territory(req, res);
    if (p === '/api/leaderboard' && req.method === 'GET') return await leaderboard(req, res);

    if (req.method === 'POST') {
      if (WEBHOOK_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) {
        return res.status(401).send('Unauthorized');
      }
      await bot.handleUpdate(req.body);
      return res.status(200).send('OK');
    }

    if (req.method === 'GET') {
      if (p === '/manifest.webmanifest') {
        res.setHeader('Content-Type', 'application/manifest+json');
        res.setHeader('Cache-Control', 'no-cache');
        return res.status(200).send(MANIFEST);
      }
      if (p === '/sw.js') {
        res.setHeader('Content-Type', 'application/javascript');
        res.setHeader('Cache-Control', 'no-cache');
        return res.status(200).send(SW);
      }
      if (p === '/icon-192.png' || p === '/icon-512.png') {
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.status(200).send(Buffer.from(icons[p.includes('512') ? 512 : 192], 'base64'));
      }
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(INDEX_HTML);
  } catch (err) {
    console.error('Handler error:', err);
    return json(res, 500, { success: false, error: 'Something went wrong. Please try again.' });
  }
};

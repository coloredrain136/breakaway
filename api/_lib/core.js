// Breakaway shared server code. Files in api/_lib are not routes.
export const APP_VERSION = 'breakaway-1';

export const RACE_COLS = [
  'id', 'name', 'rider_name', 'race_date', 'planned_start', 'status', 'started_at', 'finished_at',
  'course_name', 'course_miles', 'course_version', 'max_mph', 'mute', 'has_pending', 'last_push_at',
  'data_epoch', 'cur_ts', 'cur_lat', 'cur_lon', 'cur_prog_m', 'cur_speed_mps', 'recent_mps', 'avg_mps',
  'last_ingest_at', 'last_ingest_count', 'last_ingest_stored', 'last_ingest_note', 'last_battery',
  'last_battery_state', 'ingest_total'
].join(',');

export const QUICK_EMOJI = ['🔥', '👏', '💪', '🚴', '❄️'];
export const PRE_WINDOW_MS = 30 * 60 * 1000;   // points kept from 30 min before planned start
export const POST_WINDOW_MS = 2 * 60 * 1000;   // and 2 min after finish
export const PUSH_GAP_MS = 2 * 60 * 1000;      // max one push per 2 min
export const TAPS_ONLY_GAP_MS = 5 * 60 * 1000; // taps-only bundles at most every 5 min
export const MI = 1609.344;

// ---------- Supabase (PostgREST) ----------
function sbHeaders(extra = {}) {
  const key = process.env.SUPABASE_SECRET_KEY || '';
  const h = { apikey: key, 'Content-Type': 'application/json', ...extra };
  // New-style keys (sb_secret_…) go in apikey only; legacy service_role JWTs also need Bearer.
  if (key && !key.startsWith('sb_')) h.Authorization = 'Bearer ' + key;
  return h;
}

export async function db(method, path, body, prefer) {
  const base = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  if (!base) throw new Error('SUPABASE_URL is not set');
  const r = await fetch(`${base}/rest/v1/${path}`, {
    method,
    headers: sbHeaders(prefer ? { Prefer: prefer } : {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`DB ${method} ${path.split('?')[0]} ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

export async function dbCount(path) {
  const base = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const r = await fetch(`${base}/rest/v1/${path}${path.includes('?') ? '&' : '?'}limit=1&select=id`, {
    headers: sbHeaders({ Prefer: 'count=exact' })
  });
  if (!r.ok) throw new Error(`DB count ${r.status}`);
  const cr = r.headers.get('content-range') || '';
  const n = parseInt(cr.split('/')[1], 10);
  return Number.isFinite(n) ? n : 0;
}

export const enc = encodeURIComponent;

export async function getRace(withCourse = false) {
  const cols = withCourse ? RACE_COLS + ',course' : RACE_COLS;
  const rows = await db('GET', `breakaway_races?active=eq.true&order=id.desc&limit=1&select=${cols}`);
  return rows && rows[0] ? rows[0] : null;
}

export async function patchRace(id, patch, extraFilter = '') {
  return db('PATCH', `breakaway_races?id=eq.${id}${extraFilter}&select=${RACE_COLS}`,{ ...patch, updated_at: new Date().toISOString() }, 'return=representation');
}

// ---------- HTTP helpers ----------
export function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

export function bodyOf(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = null; } }
  if (b && typeof b === 'object' && !Buffer.isBuffer(b)) return b;
  if (Buffer.isBuffer(b)) { try { return JSON.parse(b.toString('utf8')); } catch { return null; } }
  return null;
}

export function originOf(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const proto = req.headers['x-forwarded-proto'] || (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
  return `${String(proto).split(',')[0]}://${host}`;
}

export function ipOf(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
}

export function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Geo ----------
export function hav(lat1, lon1, lat2, lon2) {
  const R = 6371008.8, t = Math.PI / 180;
  const dLat = (lat2 - lat1) * t, dLon = (lon2 - lon1) * t;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * t) * Math.cos(lat2 * t) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// course = { pts: [[lat, lon, cum_m, ele], ...], total_m }
function nearestOnCourse(course, lat, lon, lo, hi) {
  const P = course.pts;
  const kx = Math.cos(lat * Math.PI / 180) * 111320, ky = 110540;
  let best = null;
  for (let i = 0; i < P.length - 1; i++) {
    const a = P[i], b = P[i + 1];
    if (b[2] < lo || a[2] > hi) continue;
    const ax = (a[1] - lon) * kx, ay = (a[0] - lat) * ky;
    const bx = (b[1] - lon) * kx, by = (b[0] - lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? -(ax * dx + ay * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = ax + t * dx, py = ay + t * dy;
    const off = Math.sqrt(px * px + py * py);
    if (!best || off < best.off) best = { off, prog: a[2] + t * (b[2] - a[2]) };
  }
  return best;
}

// Snap a fix to the course. Prefers the stretch just ahead of where he last was,
// so places where the trail doubles back near itself don't make him jump.
export function snap(course, lat, lon, prevProg, dtS, maxMps) {
  if (!course || !course.pts || course.pts.length < 2) return { prog: null, off: null };
  if (prevProg != null) {
    const ahead = Math.max(0, dtS) * maxMps + 400;
    const w = nearestOnCourse(course, lat, lon, prevProg - 400, prevProg + ahead);
    if (w && w.off <= 300) return { prog: Math.max(w.prog, prevProg - 50), off: w.off };
  }
  const g = nearestOnCourse(course, lat, lon, -Infinity, Infinity);
  if (!g) return { prog: prevProg, off: null };
  if (prevProg == null) return g.off <= 300 ? g : { prog: null, off: g.off };
  if (g.off <= 100) return g;                 // clearly on course somewhere else (reroute / big catch-up)
  return { prog: prevProg, off: g.off };      // off course: hold progress where it was
}

// ---------- Push (ntfy) ----------
export async function ntfy({ title, message, tags, priority, click }) {
  const topic = process.env.BREAKAWAY_NTFY_TOPIC;
  if (!topic) return { ok: false, error: 'BREAKAWAY_NTFY_TOPIC is not set' };
  const server = (process.env.BREAKAWAY_NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '');
  try {
    const r = await fetch(server, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, title, message, tags, priority, click })
    });
    return r.ok ? { ok: true } : { ok: false, error: `ntfy ${r.status}` };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function tapSummary(taps) {
  const by = {};
  for (const t of taps) by[t.emoji] = (by[t.emoji] || 0) + (t.count || 1);
  return Object.entries(by).sort((a, b) => b[1] - a[1]).map(([e, n]) => `${e}×${n}`).join(' ');
}

// Bundled cheers → Joe's phone/watch. Safe to call often; does nothing unless due.
export async function flushPush(race, origin) {
  if (!race || !race.has_pending) return { sent: false, why: 'none pending' };
  const now = Date.now();
  const last = race.last_push_at ? Date.parse(race.last_push_at) : 0;
  if (now - last < PUSH_GAP_MS) return { sent: false, why: 'too soon' };

  const pending = await db('GET', `breakaway_cheers?race_id=eq.${race.id}&pushed=eq.false&order=id.asc&limit=300&select=id,kind,emoji,count,name,text,hidden,created_at`);
  const ids = pending.map((c) => c.id);
  const markPushed = async (list) => {
    if (list.length) await db('PATCH', `breakaway_cheers?id=in.(${list.join(',')})`, { pushed: true });
  };

  if (race.mute || !pending.length) {
    await markPushed(ids);
    await patchRace(race.id, { has_pending: false });
    return { sent: false, why: race.mute ? 'muted' : 'empty' };
  }
  const visible = pending.filter((c) => !c.hidden);
  const msgs = visible.filter((c) => c.kind === 'msg');
  const taps = visible.filter((c) => c.kind === 'quick');
  if (!visible.length) {
    await markPushed(ids);
    await patchRace(race.id, { has_pending: false });
    return { sent: false, why: 'all hidden' };
  }
  if (!msgs.length) {
    // Taps-only: at most every 5 min, and let them sit 60s so a message can ride along.
    const oldest = Math.min(...taps.map((t) => Date.parse(t.created_at)));
    if (now - last < TAPS_ONLY_GAP_MS || now - oldest < 60000) return { sent: false, why: 'taps wait' };
  }

  // Claim the push slot atomically so two requests can't both send.
  const claimed = await patchRace(race.id, { last_push_at: new Date(now).toISOString(), has_pending: false },
    `&last_push_at=lt.${enc(new Date(now - PUSH_GAP_MS).toISOString())}`);
  if (!claimed || !claimed.length) return { sent: false, why: 'claimed elsewhere' };
  await markPushed(ids);

  let title, message, priority;
  const tapLine = taps.length ? tapSummary(taps) : '';
  if (msgs.length) {
    title = msgs.length === 1 ? `Cheer from ${msgs[0].name || 'Someone'}` : `${msgs.length} New Cheers`;
    const shown = msgs.slice(0, 2).map((m) => msgs.length === 1 ? m.text : `${m.name || 'Someone'}: ${m.text}`);
    const extra = msgs.length > 2 ? `+${msgs.length - 2} more` : '';
    message = [...shown, [extra, tapLine].filter(Boolean).join(' · ')].filter(Boolean).join('\n');
    priority = 4;
  } else {
    const people = new Set(taps.map((t) => t.name || 'Someone')).size;
    title = `${taps.reduce((s, t) => s + (t.count || 1), 0)} Cheers`;
    message = `${tapLine} from ${people} ${people === 1 ? 'person' : 'people'}`;
    priority = 3;
  }
  const r = await ntfy({ title, message, tags: ['bicyclist'], priority, click: origin ? `${origin}/#admin` : undefined });
  if (!r.ok) {
    await db('PATCH', `breakaway_cheers?id=in.(${ids.join(',')})`, { pushed: false });
    await patchRace(race.id, { has_pending: true, last_push_at: race.last_push_at });
    return { sent: false, why: r.error };
  }
  return { sent: true, title, message };
}

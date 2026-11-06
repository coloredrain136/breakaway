// Breakaway shared server code. Files in api/_lib are not routes.
export const APP_VERSION = 'breakaway-4';
import crypto from 'node:crypto';

export const RACE_COLS = [
  'id', 'name', 'rider_name', 'race_date', 'planned_start', 'status', 'started_at', 'finished_at',
  'course_name', 'course_miles', 'course_version', 'max_mph', 'mute', 'has_pending', 'last_push_at',
  'data_epoch', 'cur_ts', 'cur_lat', 'cur_lon', 'cur_prog_m', 'cur_speed_mps', 'recent_mps', 'avg_mps',
  'last_ingest_at', 'last_ingest_count', 'last_ingest_stored', 'last_ingest_note', 'last_battery',
  'last_battery_state', 'ingest_total', 'voice_on', 'race_mode_seen_at'
].join(',');

export const QUICK_EMOJI = ['🔥', '👏', '💪', '🚴', '❄️'];
export const PRE_WINDOW_MS = 30 * 60 * 1000;   // points kept from 30 min before planned start
export const POST_WINDOW_MS = 2 * 60 * 1000;   // and 2 min after finish
export const PUSH_GAP_MS = 2 * 60 * 1000;      // max one push per 2 min
export const TAPS_ONLY_GAP_MS = 5 * 60 * 1000; // taps-only bundles at most every 5 min
export const VOICE_MAX_BYTES = 900 * 1024;
export const VOICE_MIMES = ['audio/mp4', 'audio/aac', 'audio/x-m4a', 'audio/mpeg', 'audio/webm', 'audio/ogg', 'audio/wav'];

// Signed public link for one voice clip (used as the ntfy attachment).
export function voiceSig(id) {
  return crypto.createHmac('sha256', process.env.BREAKAWAY_ADMIN_PASS || 'x').update('voice:' + id).digest('hex').slice(0, 24);
}
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
export async function ntfy({ title, message, tags, priority, click, delay, attach, filename }) {
  const topic = process.env.BREAKAWAY_NTFY_TOPIC;
  if (!topic) return { ok: false, error: 'BREAKAWAY_NTFY_TOPIC is not set' };
  const server = (process.env.BREAKAWAY_NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '');
  try {
    const r = await fetch(server, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, title, message, tags, priority, click, delay, attach, filename })
    });
    return r.ok ? { ok: true } : { ok: false, error: `ntfy ${r.status}` };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// "Irina ❄️×2 🔥 · Mom 💪×3" — who sent what, biggest senders first.
function tapSummary(taps) {
  const people = new Map();
  for (const t of taps) {
    const who = t.name || 'Someone';
    if (!people.has(who)) people.set(who, { total: 0, by: {} });
    const p = people.get(who);
    p.by[t.emoji] = (p.by[t.emoji] || 0) + (t.count || 1);
    p.total += t.count || 1;
  }
  return [...people.entries()].sort((a, b) => b[1].total - a[1].total).map(([who, p]) =>
    `${who} ${Object.entries(p.by).sort((a, b) => b[1] - a[1]).map(([e, n]) => n > 1 ? `${e}×${n}` : e).join(' ')}`).join(' · ');
}

// Bundled cheers → Joe's phone/watch. Called right when a cheer comes in (and on polls/ingest as a safety net).
// Max one push per 2 min: if a push went out recently, the bundle is handed to ntfy with a delivery time
// (ntfy "delay"), so it arrives on time even if nobody has the page open.
export async function flushPush(race, origin) {
  if (!race || !race.has_pending) return { sent: false, why: 'none pending' };
  const now = Date.now();
  const lastIso = race.last_push_at || '1970-01-01T00:00:00Z';
  const last = Date.parse(lastIso);

  const pending = await db('GET', `breakaway_cheers?race_id=eq.${race.id}&pushed=eq.false&order=id.asc&limit=300&select=id,kind,emoji,count,name,text,hidden,created_at,audio_secs`);
  const ids = pending.map((c) => c.id);
  const markPushed = async (list) => {
    if (list.length) await db('PATCH', `breakaway_cheers?id=in.(${list.join(',')})`, { pushed: true });
  };
  const visible = pending.filter((c) => !c.hidden);
  if (race.mute || !visible.length) {
    await markPushed(ids);
    await patchRace(race.id, { has_pending: false });
    return { sent: false, why: race.mute ? 'muted' : 'empty' };
  }
  const msgs = visible.filter((c) => c.kind === 'msg' || c.kind === 'voice');
  const taps = visible.filter((c) => c.kind === 'quick');

  // When should this bundle land?
  let sendAt;
  if (msgs.length) sendAt = Math.max(now, last + PUSH_GAP_MS);
  else {
    const oldest = Math.min(...taps.map((t) => Date.parse(t.created_at)));
    sendAt = Math.max(now, last + TAPS_ONLY_GAP_MS, oldest + 60000);
    // Taps-only bundles aren't scheduled ahead (that would push a later message back).
    // They wait here; the next poll/ingest/cheer sends them once they're due.
    if (sendAt - now > 15000) return { sent: false, why: 'taps wait' };
    sendAt = now;
  }

  // Claim the slot atomically (only if nobody else changed last_push_at since we read it).
  const claimed = await patchRace(race.id, { last_push_at: new Date(sendAt).toISOString(), has_pending: false },
    `&last_push_at=eq.${enc(lastIso)}`);
  if (!claimed || !claimed.length) return { sent: false, why: 'claimed elsewhere' };
  await markPushed(ids);

  const label = (m) => m.kind === 'voice' ? `🎙️ Voice message${m.audio_secs ? ` (${Math.round(m.audio_secs)}s)` : ''}` : m.text;
  let title, message, priority;
  const tapLine = taps.length ? tapSummary(taps) : '';
  if (msgs.length) {
    title = msgs.length === 1 ? `${msgs[0].kind === 'voice' ? 'Voice From' : 'Cheer From'} ${msgs[0].name || 'Someone'}` : `${msgs.length} New Cheers`;
    const shown = msgs.slice(0, 2).map((m) => msgs.length === 1 ? label(m) : `${m.name || 'Someone'}: ${label(m)}`);
    const extra = msgs.length > 2 ? `+${msgs.length - 2} more` : '';
    message = [...shown, [extra, tapLine].filter(Boolean).join(' · ')].filter(Boolean).join('\n');
    priority = 4;
  } else {
    const names = [...new Set(taps.map((t) => t.name || 'Someone'))];
    const n = taps.reduce((s, t) => s + (t.count || 1), 0);
    title = names.length === 1 ? `${n} ${n === 1 ? 'Cheer' : 'Cheers'} From ${names[0]}` : `${n} Cheers From ${names.length} People`;
    message = tapLine;
    priority = 3;
  }
  const voice = msgs.find((m) => m.kind === 'voice');
  const attach = voice && origin ? `${origin}/api/state?voice=${voice.id}&sig=${voiceSig(voice.id)}` : undefined;
  const delaySec = Math.round((sendAt - now) / 1000);
  const r = await ntfy({
    title, message, tags: ['bicyclist'], priority,
    click: origin ? `${origin}/race` : undefined,
    delay: delaySec >= 10 ? String(Math.floor(sendAt / 1000)) : undefined,
    attach, filename: attach ? `voice-${voice.id}.m4a` : undefined
  });
  if (!r.ok) {
    await db('PATCH', `breakaway_cheers?id=in.(${ids.join(',')})`, { pushed: false });
    await patchRace(race.id, { has_pending: true, last_push_at: lastIso });
    return { sent: false, why: r.error };
  }
  return { sent: true, scheduled: delaySec >= 10, sendAt: new Date(sendAt).toISOString(), title, message };
}

// ---------- Live numbers (shared by the follower page and Race Mode) ----------
const r1 = (n) => Math.round(n * 10) / 10;
export function liveStats(race, now = Date.now()) {
  const status = race.status;
  const total = race.course_miles || null;
  const prog = race.cur_prog_m != null ? race.cur_prog_m / MI : null;
  let milesDone = null, milesLeft = null, eta = null;
  if (status === 'finished') { milesDone = total; milesLeft = total != null ? 0 : null; }
  else if (prog != null && total) { milesDone = Math.min(prog, total); milesLeft = Math.max(0, total - milesDone); }
  if (status === 'live' && milesLeft != null && race.cur_ts) {
    const rec = race.recent_mps, avg = race.avg_mps;
    const blend = rec != null && avg != null ? 0.6 * rec + 0.4 * avg : (rec ?? avg);
    if (blend && blend > 0.6) {
      const etaMs = Date.parse(race.cur_ts) + (milesLeft * MI) / blend * 1000;
      const step = (etaMs - now) > 20 * 60000 ? 5 * 60000 : 60000;
      eta = new Date(Math.round(etaMs / step) * step).toISOString();
    }
  }
  const planned = race.planned_start ? Date.parse(race.planned_start) : null;
  const curVisible = status !== 'finished' && race.cur_ts && (status === 'live' || (planned != null && Date.parse(race.cur_ts) >= planned - PRE_WINDOW_MS));
  const fresh = race.cur_ts && now - Date.parse(race.cur_ts) < 3 * 60000;
  return {
    total, curVisible: !!curVisible,
    milesDone: milesDone != null ? r1(milesDone) : null,
    milesLeft: milesLeft != null ? r1(milesLeft) : null,
    speedMph: curVisible && fresh && race.cur_speed_mps != null ? r1(race.cur_speed_mps * 2.23694) : null,
    avgMph: race.avg_mps != null ? r1(race.avg_mps * 2.23694) : null,
    eta
  };
}

// ---------- Follower web push ("Notify me when Joe starts") ----------
let webpushMod = null;
async function webpush() {
  if (!webpushMod) {
    const m = await import('web-push');
    webpushMod = m.default || m;
    webpushMod.setVapidDetails('mailto:breakaway@example.com', process.env.BREAKAWAY_VAPID_PUBLIC, process.env.BREAKAWAY_VAPID_PRIVATE);
  }
  return webpushMod;
}
export function pushReady() { return !!(process.env.BREAKAWAY_VAPID_PUBLIC && process.env.BREAKAWAY_VAPID_PRIVATE); }

function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

// kind: 'start' | 'finish' | 'test'. Never throws; returns { sent, failed, removed }.
export async function notifyFollowers(race, origin, kind) {
  const out = { sent: 0, failed: 0, removed: 0 };
  try {
    if (!pushReady() || !race) return out;
    const subs = await db('GET', `breakaway_push_subs?race_id=eq.${race.id}&select=id,endpoint,p256dh,auth`);
    if (!subs.length) return out;
    const rider = race.rider_name || 'Joe';
    const key = process.env.BREAKAWAY_VIEW_KEY || '';
    const url = origin ? `${origin}/?k=${encodeURIComponent(key)}` : '/';
    let title, body;
    if (kind === 'start') { title = `${rider} just started ${race.name || 'the race'}! 🚴`; body = 'Tap to watch live and send a cheer.'; }
    else if (kind === 'finish') {
      const t = race.started_at && race.finished_at ? fmtDur((Date.parse(race.finished_at) - Date.parse(race.started_at)) / 1000) : null;
      title = `${rider} finished! 🎉`; body = t ? `GPS time ${t}. Tap to see the finish.` : 'Tap to see the finish.';
    } else { title = 'Breakaway notifications are on ✅'; body = `You'll get a push when ${rider} starts and finishes.`; }
    const wp = await webpush();
    const payload = JSON.stringify({ title, body, url, tag: `breakaway-${kind}` });
    const gone = [];
    await Promise.all(subs.map(async (s) => {
      try {
        await wp.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600, urgency: 'high', timeout: 8000 });
        out.sent++;
      } catch (e) {
        out.failed++;
        if (e && (e.statusCode === 404 || e.statusCode === 410)) gone.push(s.id);
      }
    }));
    if (gone.length) { await db('DELETE', `breakaway_push_subs?id=in.(${gone.join(',')})`); out.removed = gone.length; }
  } catch (e) { console.error('notifyFollowers', e.message); }
  return out;
}

export async function pushOne(sub, title, body, url) {
  const wp = await webpush();
  return wp.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
    JSON.stringify({ title, body, url, tag: 'breakaway-test' }), { TTL: 600, urgency: 'high', timeout: 8000 });
}

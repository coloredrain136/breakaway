// POST /api/track — Overland GPS Tracker sends batches here.
// Must answer {"result":"ok"} or Overland keeps the points and re-sends them.
import {
  db, getRace, patchRace, send, bodyOf, originOf, same, hav, snap, flushPush, enc,
  PRE_WINDOW_MS, POST_WINDOW_MS, MI
} from './_lib/core.js';

function parseFeature(f) {
  if (!f || !f.geometry || f.geometry.type !== 'Point' || !Array.isArray(f.geometry.coordinates)) return null;
  const [lon, lat] = f.geometry.coordinates;
  const p = f.properties || {};
  const t = Date.parse(p.timestamp);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(t)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    t, lat, lon,
    speed: num(p.speed) != null && p.speed >= 0 ? p.speed : null,
    acc: num(p.horizontal_accuracy),
    alt: num(p.altitude),
    battery: num(p.battery_level) != null && p.battery_level >= 0 ? Math.round(p.battery_level * 100) : null,
    bstate: typeof p.battery_state === 'string' ? p.battery_state : null
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const auth = String(req.headers.authorization || '');
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : String(req.query?.token || '');
  if (!process.env.BREAKAWAY_TRACK_TOKEN) return send(res, 500, { error: 'BREAKAWAY_TRACK_TOKEN is not set' });
  if (!same(token, process.env.BREAKAWAY_TRACK_TOKEN)) return send(res, 401, { error: 'bad token' });

  const body = bodyOf(req);
  const feats = Array.isArray(body?.locations) ? body.locations : [];
  const pts = feats.map(parseFeature).filter(Boolean).sort((a, b) => a.t - b.t);

  try {
    const race = await getRace(true);
    if (!race) return send(res, 200, { result: 'ok', note: 'no race' });

    const nowIso = new Date().toISOString();
    const withBatt = [...pts].reverse().find((p) => p.battery != null);
    const health = {
      last_ingest_at: nowIso,
      last_ingest_count: feats.length,
      ingest_total: Number(race.ingest_total || 0) + 1
    };
    // Only take battery from fresh points (a re-sent old batch shouldn't overwrite it).
    const curT = race.cur_ts ? Date.parse(race.cur_ts) : 0;
    if (withBatt && withBatt.t >= curT - 1000) { health.last_battery = withBatt.battery; health.last_battery_state = withBatt.bstate; }

    // Privacy window: only points from 30 min before start through 2 min after finish.
    const planned = race.planned_start ? Date.parse(race.planned_start) : null;
    const started = race.started_at ? Date.parse(race.started_at) : null;
    const finished = race.finished_at ? Date.parse(race.finished_at) : null;
    let note = null, keep = [];
    if (planned == null && started == null) note = 'Race not set up yet (points not stored)';
    else {
      const winStart = Math.min(planned != null ? planned - PRE_WINDOW_MS : Infinity, started ?? Infinity);
      const winEnd = finished != null ? finished + POST_WINDOW_MS : Infinity;
      keep = pts.filter((p) => p.t >= winStart && p.t <= winEnd);
      if (!keep.length) note = pts.length ? 'Outside race window (points not stored)' : 'Empty batch';
    }

    if (!keep.length) {
      await patchRace(race.id, { ...health, last_ingest_stored: 0, last_ingest_note: note });
      return send(res, 200, { result: 'ok' });
    }

    // Context: last good point before this batch.
    const prevRows = await db('GET', `breakaway_points?race_id=eq.${race.id}&bad=eq.false&ts=lt.${enc(new Date(keep[0].t).toISOString())}&order=ts.desc&limit=1&select=ts,lat,lon,prog_m`);
    let prev = prevRows[0] ? { t: Date.parse(prevRows[0].ts), lat: prevRows[0].lat, lon: prevRows[0].lon, prog: prevRows[0].prog_m } : null;

    const course = race.course;
    const maxMps = (Number(race.max_mph) || 40) * 0.44704;
    const start = course?.pts?.[0], end = course?.pts?.[course.pts.length - 1];
    const total = course?.total_m || 0;
    let status = race.status, startedAt = race.started_at, finishedAt = race.finished_at;
    // Last moment he was standing still in the start area (≈ when he actually rolled out).
    let lastStill = null, prevAny = prev;

    const rows = [];
    for (const p of keep) {
      let bad = false;
      if (p.acc != null && p.acc > 150) bad = true;
      let dt = 0;
      if (!bad && prev) {
        dt = (p.t - prev.t) / 1000;
        const d = hav(prev.lat, prev.lon, p.lat, p.lon);
        if (dt <= 0) bad = d > 30;
        else if (d > 60 && d / dt > maxMps) bad = true;   // impossible jump
      }
      const s = bad ? { prog: null, off: null } : snap(course, p.lat, p.lon, prev ? prev.prog : null, dt, maxMps);
      rows.push({
        race_id: race.id, ts: new Date(p.t).toISOString(), lat: p.lat, lon: p.lon,
        speed: p.speed, acc: p.acc, alt: p.alt, battery: p.battery,
        prog_m: s.prog, off_m: s.off, bad
      });
      if (bad) continue;
      prev = { t: p.t, lat: p.lat, lon: p.lon, prog: s.prog };

      if (!course) continue;
      const fromStart = hav(p.lat, p.lon, start[0], start[1]);
      if (fromStart <= 250) {
        const v = prevAny && p.t > prevAny.t ? hav(prevAny.lat, prevAny.lon, p.lat, p.lon) / ((p.t - prevAny.t) / 1000) : (p.speed ?? 0);
        if (v < 1.5) lastStill = p.t;
      }
      prevAny = p;
      // Auto start: after planned start, on course and moved 0.25 mi down it.
      if (status === 'not_started' && planned != null && p.t >= planned && s.prog != null && s.off <= 300 && s.prog >= 0.25 * MI) {
        status = 'live';
        startedAt = new Date(lastStill && lastStill >= planned && lastStill <= p.t ? lastStill : planned).toISOString();
      }
      // Auto finish: within 100 m of the finish and near the end of the course.
      if (status === 'live' && hav(p.lat, p.lon, end[0], end[1]) <= 100 && s.prog != null && s.prog >= total - MI) {
        status = 'finished';
        finishedAt = new Date(p.t).toISOString();
      }
    }
    const finMs = finishedAt ? Date.parse(finishedAt) + POST_WINDOW_MS : Infinity;
    const toStore = rows.filter((r) => Date.parse(r.ts) <= finMs);

    if (toStore.length) {
      await db('POST', 'breakaway_points?on_conflict=race_id,ts', toStore, 'resolution=ignore-duplicates,return=minimal');
    }

    // Refresh the live-position cache from the last 15 min of good points.
    const latest = await db('GET', `breakaway_points?race_id=eq.${race.id}&bad=eq.false&order=ts.desc&limit=1&select=ts`);
    const patch = { ...health, last_ingest_stored: toStore.length, last_ingest_note: null, status, started_at: startedAt, finished_at: finishedAt };
    if (latest[0]) {
      const lt = Date.parse(latest[0].ts);
      const win = await db('GET', `breakaway_points?race_id=eq.${race.id}&bad=eq.false&ts=gte.${enc(new Date(lt - 15 * 60000).toISOString())}&order=ts.asc&limit=2000&select=ts,lat,lon,speed,prog_m`);
      const cur = win[win.length - 1];
      const ct = Date.parse(cur.ts);
      // Current speed: GPS path over the last ~2 min.
      let path = 0, first = null;
      for (let i = win.length - 1; i > 0; i--) {
        const a = win[i - 1], b = win[i];
        if (ct - Date.parse(a.ts) > 120000) break;
        path += hav(a.lat, a.lon, b.lat, b.lon);
        first = a;
      }
      let speedNow = null;
      if (first && (ct - Date.parse(first.ts)) >= 15000) speedNow = path / ((ct - Date.parse(first.ts)) / 1000);
      else if (cur.speed != null) speedNow = cur.speed;
      // Recent moving speed along the course (last ~15 min).
      const withProg = win.filter((r) => r.prog_m != null);
      let recent = null;
      if (withProg.length >= 2) {
        const a = withProg[0], b = withProg[withProg.length - 1];
        const sec = (Date.parse(b.ts) - Date.parse(a.ts)) / 1000;
        if (sec >= 180) recent = Math.max(0, (b.prog_m - a.prog_m) / sec);
      }
      const curProg = [...win].reverse().find((r) => r.prog_m != null)?.prog_m ?? null;
      let avg = null;
      if (startedAt && curProg != null) {
        const sec = (ct - Date.parse(startedAt)) / 1000;
        if (sec >= 120) avg = Math.max(0, curProg / sec);
      }
      Object.assign(patch, {
        cur_ts: cur.ts, cur_lat: cur.lat, cur_lon: cur.lon, cur_prog_m: curProg,
        cur_speed_mps: speedNow, recent_mps: recent, avg_mps: avg
      });
    }
    const updated = await patchRace(race.id, patch);
    const fresh = updated?.[0] || { ...race, ...patch };
    try { await flushPush(fresh, originOf(req)); } catch (e) { console.error('push', e.message); }
    return send(res, 200, { result: 'ok' });
  } catch (e) {
    console.error('track error', e.message);
    // Not ok → Overland keeps the points and retries later. That's what we want.
    return send(res, 500, { error: 'server error' });
  }
}

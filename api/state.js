// GET /api/state?k=VIEW_KEY&since=<lastPointId>&epoch=<n>   → live state for the spectator page
// GET /api/state?k=VIEW_KEY&part=course                     → the course line (fetched once)
// GET /api/state?voice=<id>&sig=<sig>                        → one voice clip (signed link, used by ntfy)
// Feed privacy: emoji taps are shared; messages + voice only come back to the device that sent them (&d=).
import { db, getRace, send, same, flushPush, originOf, voiceSig, APP_VERSION, MI, PRE_WINDOW_MS } from './_lib/core.js';

const r1 = (n) => Math.round(n * 10) / 10;

export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'GET only' });
  if (req.query?.voice) {
    const id = Number(req.query.voice);
    if (!Number.isFinite(id) || !same(String(req.query.sig || ''), voiceSig(id))) return send(res, 403, { error: 'bad link' });
    try {
      const rows = await db('GET', `breakaway_voice?cheer_id=eq.${id}&select=mime,data`);
      if (!rows[0]) return send(res, 404, { error: 'not found' });
      const buf = Buffer.from(rows[0].data, 'base64');
      res.statusCode = 200;
      res.setHeader('Content-Type', rows[0].mime);
      res.setHeader('Content-Length', buf.length);
      res.setHeader('Cache-Control', 'private, max-age=86400');
      return res.end(buf);
    } catch (e) { return send(res, 500, { error: 'server error' }); }
  }
  const key = process.env.BREAKAWAY_VIEW_KEY;
  if (!key) return send(res, 500, { error: 'BREAKAWAY_VIEW_KEY is not set' });
  if (!same(String(req.query?.k || ''), key)) return send(res, 403, { error: 'bad link' });

  try {
    if (req.query.part === 'course') {
      const race = await getRace(true);
      return send(res, 200, { v: APP_VERSION, courseVersion: race?.course_version || 0, course: race?.course || null });
    }
    let race = await getRace(false);
    if (!race) return send(res, 200, { v: APP_VERSION, status: 'setup' });

    // Opportunistic push flush (keeps bundling going without a cron).
    if (race.has_pending) {
      try { await flushPush(race, originOf(req)); } catch (e) { console.error('push', e.message); }
    }

    const now = Date.now();
    const status = race.status;
    const epoch = Number(req.query.epoch || 0);
    const since = epoch === race.data_epoch ? Number(req.query.since || 0) || 0 : 0;
    const planned = race.planned_start ? Date.parse(race.planned_start) : null;

    // Which points can be shown: race window only. Nothing after the finish.
    let ptFilter = `race_id=eq.${race.id}&bad=eq.false&id=gt.${since}`;
    if (race.finished_at) ptFilter += `&ts=lte.${encodeURIComponent(race.finished_at)}`;
    const showPoints = status !== 'not_started' || (planned != null && now >= planned - PRE_WINDOW_MS);

    const device = String(req.query.d || '').slice(0, 40);
    const cols = 'id,kind,emoji,count,name,text,created_at,audio_secs';
    const [points, taps, mine, totals] = await Promise.all([
      showPoints ? db('GET', `breakaway_points?${ptFilter}&order=id.asc&limit=5000&select=id,lat,lon,ts`) : Promise.resolve([]),
      db('GET', `breakaway_cheers?race_id=eq.${race.id}&hidden=eq.false&kind=eq.quick&order=id.desc&limit=40&select=${cols}`),
      device.length >= 8
        ? db('GET', `breakaway_cheers?race_id=eq.${race.id}&hidden=eq.false&kind=in.(msg,voice)&device=eq.${encodeURIComponent(device)}&order=id.desc&limit=40&select=${cols}`)
        : Promise.resolve([]),
      db('GET', `breakaway_cheer_totals?race_id=eq.${race.id}&select=emoji,total`)
    ]);
    const feed = [...taps, ...mine.map((m) => ({ ...m, mine: true }))].sort((a, b) => Number(b.id) - Number(a.id)).slice(0, 40);

    const total = race.course_miles || null;
    const prog = race.cur_prog_m != null ? race.cur_prog_m / MI : null;
    let milesDone = null, milesLeft = null, eta = null;
    if (status === 'finished') { milesDone = total; milesLeft = 0; }
    else if (prog != null && total) {
      milesDone = Math.min(prog, total);
      milesLeft = Math.max(0, total - milesDone);
    }
    if (status === 'live' && milesLeft != null && race.cur_ts) {
      const rec = race.recent_mps, avg = race.avg_mps;
      const blend = rec != null && avg != null ? 0.6 * rec + 0.4 * avg : (rec ?? avg);
      if (blend && blend > 0.6) {
        const etaMs = Date.parse(race.cur_ts) + (milesLeft * MI) / blend * 1000;
        const step = (etaMs - now) > 20 * 60000 ? 5 * 60000 : 60000;   // round so it doesn't jitter
        eta = new Date(Math.round(etaMs / step) * step).toISOString();
      }
    }

    // Live position is only shared while not finished.
    const curVisible = status !== 'finished' && race.cur_ts && (status === 'live' || (planned != null && Date.parse(race.cur_ts) >= planned - PRE_WINDOW_MS));
    const fresh = race.cur_ts && now - Date.parse(race.cur_ts) < 3 * 60000;

    return send(res, 200, {
      v: APP_VERSION,
      now: new Date(now).toISOString(),
      status,
      name: race.name,
      rider: race.rider_name || 'Joe',
      raceDate: race.race_date,
      plannedStart: race.planned_start,
      startedAt: race.started_at,
      finishedAt: race.finished_at,
      courseVersion: race.course_version || 0,
      courseMiles: total,
      epoch: race.data_epoch,
      cur: curVisible ? { ts: race.cur_ts, lat: race.cur_lat, lon: race.cur_lon } : null,
      milesDone: milesDone != null ? r1(milesDone) : null,
      milesLeft: milesLeft != null ? r1(milesLeft) : null,
      speedMph: curVisible && fresh && race.cur_speed_mps != null ? r1(race.cur_speed_mps * 2.23694) : null,
      avgMph: race.avg_mps != null ? r1(race.avg_mps * 2.23694) : null,
      eta,
      lastSeen: curVisible ? race.cur_ts : null,
      battery: status !== 'finished' ? race.last_battery : null,
      points: points.map((p) => [p.id, Math.round(p.lat * 1e6) / 1e6, Math.round(p.lon * 1e6) / 1e6]),
      feed,
      voiceOn: race.voice_on !== false,
      totals: Object.fromEntries(totals.map((t) => [t.emoji, t.total]))
    });
  } catch (e) {
    console.error('state error', e.message);
    return send(res, 500, { error: 'server error' });
  }
}

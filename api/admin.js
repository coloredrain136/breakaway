// /api/admin — Joe only. Header: x-admin-pass
// GET  → everything the Admin screen needs (setup, health, cheers, Overland values)
// POST { action, v, ... } → save | start | end | reopen | not_started | mute | hide | test_push | clear_data
import {
  db, dbCount, getRace, patchRace, send, bodyOf, originOf, same, sleep, ntfy, APP_VERSION, MI
} from './_lib/core.js';

const ACTIONS = ['save', 'start', 'end', 'reopen', 'not_started', 'mute', 'hide', 'test_push', 'clear_data'];

function cleanCourse(c) {
  if (!c || !Array.isArray(c.pts) || c.pts.length < 2 || c.pts.length > 20000) return null;
  const pts = [];
  for (const p of c.pts) {
    if (!Array.isArray(p) || p.length < 3) return null;
    const [lat, lon, cum, ele] = p.map(Number);
    if (![lat, lon, cum].every(Number.isFinite)) return null;
    pts.push([lat, lon, cum, Number.isFinite(ele) ? ele : null]);
  }
  return { pts, total_m: pts[pts.length - 1][2] };
}

export default async function handler(req, res) {
  const pass = process.env.BREAKAWAY_ADMIN_PASS;
  if (!pass) return send(res, 500, { error: 'BREAKAWAY_ADMIN_PASS is not set' });
  if (!same(String(req.headers['x-admin-pass'] || ''), pass)) {
    await sleep(500);
    return send(res, 401, { error: 'Wrong passcode' });
  }

  try {
    let race = await getRace(false);
    if (!race) {
      await db('POST', 'breakaway_races', { name: 'Iceman Cometh 2026', race_date: '2026-11-07' }, 'return=minimal');
      race = await getRace(false);
    }
    const origin = originOf(req);

    if (req.method === 'GET') {
      const [pointCount, badCount, lastPt, cheers] = await Promise.all([
        dbCount(`breakaway_points?race_id=eq.${race.id}`),
        dbCount(`breakaway_points?race_id=eq.${race.id}&bad=eq.true`),
        db('GET', `breakaway_points?race_id=eq.${race.id}&order=received_at.desc&limit=1&select=ts,received_at,off_m,bad`),
        db('GET', `breakaway_cheers?race_id=eq.${race.id}&order=id.desc&limit=300&select=id,kind,emoji,count,name,text,hidden,pushed,created_at`)
      ]);
      const trackUrl = `${origin}/api/track`;
      const token = process.env.BREAKAWAY_TRACK_TOKEN || '';
      return send(res, 200, {
        v: APP_VERSION,
        now: new Date().toISOString(),
        race,
        health: {
          lastIngestAt: race.last_ingest_at,
          lastIngestCount: race.last_ingest_count,
          lastIngestStored: race.last_ingest_stored,
          note: race.last_ingest_note,
          battery: race.last_battery,
          batteryState: race.last_battery_state,
          ingestTotal: race.ingest_total,
          pointCount, badCount,
          lastPoint: lastPt[0] || null
        },
        config: {
          supabase: true,
          trackToken: !!token,
          viewKey: !!process.env.BREAKAWAY_VIEW_KEY,
          ntfyTopic: !!process.env.BREAKAWAY_NTFY_TOPIC
        },
        share: process.env.BREAKAWAY_VIEW_KEY ? `${origin}/?k=${encodeURIComponent(process.env.BREAKAWAY_VIEW_KEY)}` : null,
        overland: {
          url: trackUrl,
          token,
          setupLink: `overland://setup?url=${encodeURIComponent(trackUrl)}&token=${encodeURIComponent(token)}&device_id=joe`
        },
        ntfyTopic: process.env.BREAKAWAY_NTFY_TOPIC || null,
        cheers
      });
    }

    if (req.method !== 'POST') return send(res, 405, { error: 'GET or POST' });
    const b = bodyOf(req) || {};
    if (b.v !== APP_VERSION) return send(res, 409, { error: 'update', v: APP_VERSION });
    if (!ACTIONS.includes(b.action)) return send(res, 400, { error: 'unknown action' });
    const now = new Date().toISOString();

    switch (b.action) {
      case 'save': {
        const patch = {};
        if (typeof b.name === 'string') patch.name = b.name.trim().slice(0, 60) || 'Iceman Cometh 2026';
        if (typeof b.rider === 'string') patch.rider_name = b.rider.trim().slice(0, 24) || 'Joe';
        if (b.raceDate !== undefined) patch.race_date = /^\d{4}-\d{2}-\d{2}$/.test(b.raceDate) ? b.raceDate : null;
        if (b.plannedStart !== undefined) {
          const t = Date.parse(b.plannedStart);
          patch.planned_start = Number.isFinite(t) ? new Date(t).toISOString() : null;
        }
        if (b.maxMph !== undefined) patch.max_mph = Math.max(10, Math.min(150, Number(b.maxMph) || 40));
        if (b.course) {
          const c = cleanCourse(b.course);
          if (!c) return send(res, 400, { error: 'That course file did not look right' });
          patch.course = c;
          patch.course_miles = Math.round((c.total_m / MI) * 100) / 100;
          patch.course_name = String(b.courseName || 'course.gpx').slice(0, 80);
          patch.course_version = (race.course_version || 0) + 1;
        }
        await patchRace(race.id, patch);
        break;
      }
      case 'start':
        await patchRace(race.id, { status: 'live', started_at: now, finished_at: null });
        break;
      case 'end':
        await patchRace(race.id, { status: 'finished', finished_at: now, started_at: race.started_at || now });
        break;
      case 'reopen':
        await patchRace(race.id, { status: 'live', finished_at: null, started_at: race.started_at || now });
        break;
      case 'not_started':
        await patchRace(race.id, { status: 'not_started', started_at: null, finished_at: null });
        break;
      case 'mute':
        await patchRace(race.id, { mute: !!b.on });
        break;
      case 'hide':
        if (!Number.isFinite(Number(b.id))) return send(res, 400, { error: 'bad id' });
        await db('PATCH', `breakaway_cheers?id=eq.${Number(b.id)}&race_id=eq.${race.id}`, { hidden: !!b.hidden });
        break;
      case 'test_push': {
        const r = await ntfy({
          title: 'Breakaway Test ✅',
          message: 'If this shows on your iPhone and Watch, cheers will too.',
          tags: ['bicyclist'], priority: 4, click: `${origin}/#admin`
        });
        if (!r.ok) return send(res, 502, { error: `Push failed: ${r.error}` });
        break;
      }
      case 'clear_data':
        await db('DELETE', `breakaway_points?race_id=eq.${race.id}`);
        await db('DELETE', `breakaway_cheers?race_id=eq.${race.id}`);
        await patchRace(race.id, {
          status: 'not_started', started_at: null, finished_at: null, has_pending: false,
          data_epoch: (race.data_epoch || 1) + 1,
          cur_ts: null, cur_lat: null, cur_lon: null, cur_prog_m: null, cur_speed_mps: null, recent_mps: null, avg_mps: null
        });
        break;
    }
    return send(res, 200, { ok: true });
  } catch (e) {
    console.error('admin error', e.message);
    return send(res, 500, { error: 'Server error: ' + e.message.slice(0, 160) });
  }
}

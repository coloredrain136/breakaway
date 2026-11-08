// /api/admin — Joe only. Header: x-admin-pass
// GET                      → everything the Admin screen needs (setup, health, cheers, Overland values)
// GET ?part=race&since=N   → Race Mode feed (all cheers incl. private + voice), marks Race Mode as listening
// GET ?voice=<id>          → one voice clip (audio bytes)
// POST { action, v, ... }  → save | start | end | reopen | not_started | mute | voice | hide | played | test_push | clear_data
import {
  db, dbCount, getRace, patchRace, send, bodyOf, originOf, same, sleep, ntfy, liveStats, notifyFollowers, pushReady, pushOne, REACTIONS, APP_VERSION, MI
} from './_lib/core.js';

const ACTIONS = ['save', 'start', 'end', 'reopen', 'not_started', 'mute', 'voice', 'hide', 'played', 'test_push', 'clear_data', 'arm', 'golive', 'notify_test', 'react'];

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

    if (req.method === 'GET' && req.query?.voice) {
      const id = Number(req.query.voice);
      const rows = Number.isFinite(id) ? await db('GET', `breakaway_voice?cheer_id=eq.${id}&select=mime,data`) : [];
      if (!rows[0]) return send(res, 404, { error: 'not found' });
      const buf = Buffer.from(rows[0].data, 'base64');
      res.statusCode = 200;
      res.setHeader('Content-Type', rows[0].mime);
      res.setHeader('Content-Length', buf.length);
      res.setHeader('Cache-Control', 'private, max-age=86400');
      return res.end(buf);
    }

    if (req.method === 'GET' && req.query?.part === 'course') {
      const full = await getRace(true);
      return send(res, 200, { v: APP_VERSION, courseVersion: full?.course_version || 0, course: full?.course || null });
    }

    if (req.method === 'GET' && req.query?.part === 'race') {
      const since = Number(req.query.since || 0) || 0;
      const nowIso = new Date().toISOString();
      const [cheers] = await Promise.all([
        db('GET', `breakaway_cheers?race_id=eq.${race.id}&hidden=eq.false&id=gt.${since}&order=id.desc&limit=200&select=id,kind,emoji,count,name,text,created_at,audio_secs,played_at,reaction`),
        db('PATCH', `breakaway_races?id=eq.${race.id}`, { race_mode_seen_at: nowIso })
      ]);
      const L = liveStats(race);
      return send(res, 200, {
        v: APP_VERSION, now: nowIso,
        status: race.status, name: race.name, rider: race.rider_name, mute: race.mute, voiceOn: race.voice_on !== false,
        plannedStart: race.planned_start, startedAt: race.started_at, finishedAt: race.finished_at,
        hasCourse: race.course_miles != null, courseVersion: race.course_version || 0, courseMiles: L.total,
        milesLeft: L.milesLeft, milesDone: L.milesDone, speedMph: L.speedMph, avgMph: L.avgMph, eta: L.eta,
        cur: L.curVisible ? { ts: race.cur_ts, lat: race.cur_lat, lon: race.cur_lon } : null,
        lastIngestAt: race.last_ingest_at, lastIngestNote: race.last_ingest_note,
        battery: race.last_battery, epoch: race.data_epoch,
        cheers
      });
    }

    if (req.method === 'GET') {
      const [pointCount, badCount, lastPt, cheers, pushSubs] = await Promise.all([
        dbCount(`breakaway_points?race_id=eq.${race.id}`),
        dbCount(`breakaway_points?race_id=eq.${race.id}&bad=eq.true`),
        db('GET', `breakaway_points?race_id=eq.${race.id}&order=received_at.desc&limit=1&select=ts,received_at,off_m,bad`),
        db('GET', `breakaway_cheers?race_id=eq.${race.id}&order=id.desc&limit=300&select=id,kind,emoji,count,name,text,hidden,pushed,created_at,audio_secs,played_at,reaction`),
        pushReady() ? dbCount(`breakaway_push_subs?race_id=eq.${race.id}`).catch(() => null) : Promise.resolve(null)
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
          lastPoint: lastPt[0] || null,
          raceModeSeenAt: race.race_mode_seen_at
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
        followers: { ready: pushReady(), count: pushSubs },
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
      case 'golive': {
        if (race.status === 'live') break;
        const u = await patchRace(race.id, { status: 'live', started_at: now, finished_at: null });
        await notifyFollowers(u?.[0] || race, origin, 'start');
        break;
      }
      case 'arm': {
        // Race Mode's one Start button. With a course + wave time, the race goes Live by itself
        // when Joe rolls out (auto-start). Without them (a test), it goes Live right now.
        if (race.status !== 'not_started') return send(res, 200, { ok: true, status: race.status });
        if (race.course_miles && race.planned_start) return send(res, 200, { ok: true, status: 'not_started', armed: true });
        const u = await patchRace(race.id, { status: 'live', started_at: now, finished_at: null });
        await notifyFollowers(u?.[0] || race, origin, 'start');
        return send(res, 200, { ok: true, status: 'live' });
      }
      case 'end': {
        const u = await patchRace(race.id, { status: 'finished', finished_at: now, started_at: race.started_at || now });
        await notifyFollowers(u?.[0] || race, origin, 'finish');
        break;
      }
      case 'notify_test': {
        const r = await notifyFollowers(race, origin, 'test');
        return send(res, 200, { ok: true, ...r });
      }
      case 'reopen':
        await patchRace(race.id, { status: 'live', finished_at: null, started_at: race.started_at || now });
        break;
      case 'not_started':
        await patchRace(race.id, { status: 'not_started', started_at: null, finished_at: null });
        break;
      case 'mute':
        await patchRace(race.id, { mute: !!b.on });
        break;
      case 'voice':
        await patchRace(race.id, { voice_on: !!b.on });
        break;
      case 'played':
        if (!Number.isFinite(Number(b.id))) return send(res, 400, { error: 'bad id' });
        await db('PATCH', `breakaway_cheers?id=eq.${Number(b.id)}&race_id=eq.${race.id}`, { played_at: now });
        break;
      case 'react': {
        // Joe reacts to a cheer from Race Mode. Only the sender sees it (their feed), plus a push if they turned notifications on.
        const id = Number(b.id);
        if (!Number.isFinite(id)) return send(res, 400, { error: 'bad id' });
        const emoji = b.emoji == null || b.emoji === '' ? null : String(b.emoji);
        if (emoji && !REACTIONS.includes(emoji)) return send(res, 400, { error: 'bad reaction' });
        const [c] = await db('GET', `breakaway_cheers?id=eq.${id}&race_id=eq.${race.id}&select=id,kind,emoji,count,text,device,reaction`);
        if (!c) return send(res, 404, { error: 'Cheer not found' });
        await db('PATCH', `breakaway_cheers?id=eq.${id}&race_id=eq.${race.id}`, { reaction: emoji, reacted_at: emoji ? new Date().toISOString() : null });
        let notified = 0;
        if (emoji && emoji !== c.reaction && c.device && pushReady()) {
          const subs = await db('GET', `breakaway_push_subs?race_id=eq.${race.id}&device=eq.${encodeURIComponent(c.device)}&select=id,endpoint,p256dh,auth`).catch(() => []);
          const rn = race.rider_name || 'Joe';
          const what = c.kind === 'msg' ? 'your message' : c.kind === 'voice' ? 'your voice message' : 'your cheer';
          const body = c.kind === 'msg' ? `“${String(c.text || '').slice(0, 80)}”` : c.kind === 'voice' ? '🎙️ Voice message' : `${c.emoji}${c.count > 1 ? '×' + c.count : ''}`;
          const url = `${origin}/?k=${encodeURIComponent(process.env.BREAKAWAY_VIEW_KEY || '')}`;
          await Promise.all(subs.map(async (s) => {
            try { await pushOne(s, `${rn} ${emoji} ${what}`, body, url, `breakaway-rx-${id}`); notified++; }
            catch (e) { if (e && (e.statusCode === 404 || e.statusCode === 410)) await db('DELETE', `breakaway_push_subs?id=eq.${s.id}`).catch(() => {}); }
          }));
        }
        return send(res, 200, { ok: true, reaction: emoji, notified });
      }
      case 'hide':
        if (!Number.isFinite(Number(b.id))) return send(res, 400, { error: 'bad id' });
        await db('PATCH', `breakaway_cheers?id=eq.${Number(b.id)}&race_id=eq.${race.id}`, { hidden: !!b.hidden });
        break;
      case 'test_push': {
        const r = await ntfy({
          title: 'Breakaway Test ✅',
          message: 'If this shows on your iPhone and Watch, cheers will too.',
          tags: ['bicyclist'], priority: 4, click: `${origin}/admin`
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

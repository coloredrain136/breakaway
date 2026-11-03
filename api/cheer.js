// POST /api/cheer  { k, v, device, name, kind: 'quick'|'msg'|'voice', emoji, count, text, audio (base64), mime, secs }
import { db, getRace, patchRace, send, bodyOf, same, ipOf, originOf, flushPush, APP_VERSION, QUICK_EMOJI, VOICE_MAX_BYTES, VOICE_MIMES } from './_lib/core.js';

const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const b = bodyOf(req) || {};
  const key = process.env.BREAKAWAY_VIEW_KEY;
  if (!key || !same(String(b.k || ''), key)) return send(res, 403, { error: 'bad link' });
  if (b.v !== APP_VERSION) return send(res, 409, { error: 'update', v: APP_VERSION });

  const device = clean(b.device, 40);
  if (device.length < 8) return send(res, 400, { error: 'missing device' });
  const kind = b.kind === 'msg' || b.kind === 'voice' ? b.kind : 'quick';
  const name = clean(b.name, 24);
  const row = { kind, device, name: name || null, ip: ipOf(req) };

  if (kind === 'msg') {
    const text = clean(b.text, 140);
    if (!text) return send(res, 400, { error: 'Type a message first' });
    if (!name) return send(res, 400, { error: 'Add your name first' });
    row.text = text;
  } else if (kind === 'voice') {
    if (!name) return send(res, 400, { error: 'Add your name first' });
    const mime = String(b.mime || '').split(';')[0].trim().toLowerCase();
    if (!VOICE_MIMES.includes(mime)) return send(res, 400, { error: 'That recording format isn\u2019t supported' });
    const audio = typeof b.audio === 'string' ? b.audio.replace(/^data:[^,]*,/, '') : '';
    const bytes = Math.floor(audio.length * 3 / 4);
    if (bytes < 800) return send(res, 400, { error: 'That recording was empty' });
    if (bytes > VOICE_MAX_BYTES) return send(res, 400, { error: 'Voice messages can be 15 seconds max' });
    if (!/^[A-Za-z0-9+/=]+$/.test(audio)) return send(res, 400, { error: 'Bad audio' });
    row.audio_secs = Math.max(0.5, Math.min(16, Number(b.secs) || 0));
    row._voice = { mime, data: audio };
  } else {
    if (!QUICK_EMOJI.includes(b.emoji)) return send(res, 400, { error: 'bad emoji' });
    row.emoji = b.emoji;
    row.count = Math.max(1, Math.min(10, parseInt(b.count, 10) || 1));
  }

  try {
    const race = await getRace(false);
    if (!race) return send(res, 400, { error: 'No race yet' });
    row.race_id = race.id;

    if (kind === 'voice' && race.voice_on === false) return send(res, 400, { error: 'Voice messages are turned off right now' });

    // Per-device rate limits: message 1/20s, voice 1/60s, tap batch 1/1.5s. Light per-IP limit for messages + voice.
    const gap = kind === 'msg' ? 20000 : kind === 'voice' ? 60000 : 1500;
    const [lastDev, lastIp] = await Promise.all([
      db('GET', `breakaway_cheers?race_id=eq.${race.id}&device=eq.${encodeURIComponent(device)}&kind=eq.${kind}&order=id.desc&limit=1&select=created_at`),
      kind !== 'quick' ? db('GET', `breakaway_cheers?race_id=eq.${race.id}&ip=eq.${encodeURIComponent(row.ip)}&kind=eq.${kind}&order=id.desc&limit=1&select=created_at`) : Promise.resolve([])
    ]);
    const now = Date.now();
    const since = lastDev[0] ? now - Date.parse(lastDev[0].created_at) : Infinity;
    const sinceIp = lastIp[0] ? now - Date.parse(lastIp[0].created_at) : Infinity;
    if (since < gap || sinceIp < 5000) {
      const wait = Math.ceil(Math.max(gap - since, 5000 - sinceIp) / 1000);
      return send(res, 429, { error: kind === 'quick' ? 'Easy there' : `Wait ${wait}s before the next ${kind === 'voice' ? 'voice message' : 'message'}`, wait });
    }

    const voice = row._voice; delete row._voice;
    const inserted = await db('POST', 'breakaway_cheers', row, 'return=representation');
    if (voice) {
      try { await db('POST', 'breakaway_voice', { cheer_id: inserted[0].id, mime: voice.mime, data: voice.data }, 'return=minimal'); }
      catch (e) { await db('DELETE', `breakaway_cheers?id=eq.${inserted[0].id}`); throw e; }
    }
    const updated = await patchRace(race.id, { has_pending: true });
    try { await flushPush(updated?.[0] || { ...race, has_pending: true }, originOf(req)); } catch (e) { console.error('push', e.message); }
    return send(res, 200, { ok: true });
  } catch (e) {
    console.error('cheer error', e.message);
    return send(res, 500, { error: 'server error' });
  }
}

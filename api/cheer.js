// POST /api/cheer  { k, v, device, name, kind: 'quick'|'msg', emoji, count, text }
import { db, getRace, patchRace, send, bodyOf, same, ipOf, originOf, flushPush, APP_VERSION, QUICK_EMOJI } from './_lib/core.js';

const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const b = bodyOf(req) || {};
  const key = process.env.BREAKAWAY_VIEW_KEY;
  if (!key || !same(String(b.k || ''), key)) return send(res, 403, { error: 'bad link' });
  if (b.v !== APP_VERSION) return send(res, 409, { error: 'update', v: APP_VERSION });

  const device = clean(b.device, 40);
  if (device.length < 8) return send(res, 400, { error: 'missing device' });
  const kind = b.kind === 'msg' ? 'msg' : 'quick';
  const name = clean(b.name, 24);
  const row = { kind, device, name: name || null, ip: ipOf(req) };

  if (kind === 'msg') {
    const text = clean(b.text, 140);
    if (!text) return send(res, 400, { error: 'Type a message first' });
    if (!name) return send(res, 400, { error: 'Add your name first' });
    row.text = text;
  } else {
    if (!QUICK_EMOJI.includes(b.emoji)) return send(res, 400, { error: 'bad emoji' });
    row.emoji = b.emoji;
    row.count = Math.max(1, Math.min(10, parseInt(b.count, 10) || 1));
  }

  try {
    const race = await getRace(false);
    if (!race) return send(res, 400, { error: 'No race yet' });
    row.race_id = race.id;

    // Per-device rate limit: 1 message / 20s, 1 tap batch / 1.5s. Plus a light per-IP limit for messages.
    const gap = kind === 'msg' ? 20000 : 1500;
    const [lastDev, lastIp] = await Promise.all([
      db('GET', `breakaway_cheers?race_id=eq.${race.id}&device=eq.${encodeURIComponent(device)}&kind=eq.${kind}&order=id.desc&limit=1&select=created_at`),
      kind === 'msg' ? db('GET', `breakaway_cheers?race_id=eq.${race.id}&ip=eq.${encodeURIComponent(row.ip)}&kind=eq.msg&order=id.desc&limit=1&select=created_at`) : Promise.resolve([])
    ]);
    const now = Date.now();
    const since = lastDev[0] ? now - Date.parse(lastDev[0].created_at) : Infinity;
    const sinceIp = lastIp[0] ? now - Date.parse(lastIp[0].created_at) : Infinity;
    if (since < gap || sinceIp < 5000) {
      const wait = Math.ceil(Math.max(gap - since, 5000 - sinceIp) / 1000);
      return send(res, 429, { error: kind === 'msg' ? `Wait ${wait}s before the next message` : 'Easy there', wait });
    }

    await db('POST', 'breakaway_cheers', row, 'return=minimal');
    const updated = await patchRace(race.id, { has_pending: true });
    try { await flushPush(updated?.[0] || { ...race, has_pending: true }, originOf(req)); } catch (e) { console.error('push', e.message); }
    return send(res, 200, { ok: true });
  } catch (e) {
    console.error('cheer error', e.message);
    return send(res, 500, { error: 'server error' });
  }
}

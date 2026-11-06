// POST /api/notify { k, v, action: 'subscribe' | 'unsubscribe', sub: PushSubscription JSON, device, name }
// Followers' "Notify me when Joe starts" switch. Sends one confirmation push on subscribe.
import { db, getRace, send, bodyOf, same, originOf, pushReady, pushOne, APP_VERSION } from './_lib/core.js';

const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const b = bodyOf(req) || {};
  const key = process.env.BREAKAWAY_VIEW_KEY;
  if (!key || !same(String(b.k || ''), key)) return send(res, 403, { error: 'bad link' });
  if (b.v !== APP_VERSION) return send(res, 409, { error: 'update', v: APP_VERSION });
  if (!pushReady()) return send(res, 503, { error: 'Notifications aren’t set up yet' });
  const endpoint = String(b.sub?.endpoint || '');
  if (!/^https:\/\/[^\s]{10,1000}$/.test(endpoint)) return send(res, 400, { error: 'bad subscription' });
  try {
    const race = await getRace(false);
    if (!race) return send(res, 400, { error: 'No race yet' });
    if (b.action === 'unsubscribe') {
      await db('DELETE', `breakaway_push_subs?endpoint=eq.${encodeURIComponent(endpoint)}`);
      return send(res, 200, { ok: true });
    }
    const p256dh = clean(b.sub?.keys?.p256dh, 200), auth = clean(b.sub?.keys?.auth, 100);
    if (!p256dh || !auth) return send(res, 400, { error: 'bad subscription' });
    const row = { race_id: race.id, endpoint, p256dh, auth, device: clean(b.device, 40) || null, name: clean(b.name, 24) || null };
    await db('POST', 'breakaway_push_subs?on_conflict=endpoint', row, 'resolution=merge-duplicates,return=minimal');
    const rider = race.rider_name || 'Joe';
    try {
      await pushOne(row, 'Notifications are on ✅', `You'll get a push when ${rider} starts and when he finishes.`, `${originOf(req)}/?k=${encodeURIComponent(key)}`);
    } catch (e) { console.error('confirm push', e.statusCode || e.message); }
    return send(res, 200, { ok: true });
  } catch (e) {
    console.error('notify error', e.message);
    return send(res, 500, { error: 'server error' });
  }
}

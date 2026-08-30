import { db } from '../db.js';
import { json, parseBody } from '../lib/http.js';
import { requireActiveUser } from '../lib/auth.js';
import { getPublicKey, pushEnabled } from '../lib/push.js';

export async function handlePush(req, res, urlPath) {
  // Le frontend en a besoin pour appeler pushManager.subscribe({ applicationServerKey }).
  if (urlPath === '/api/push/vapid-public-key' && req.method === 'GET') {
    return json(res, 200, { enabled: pushEnabled, public_key: getPublicKey() });
  }

  if (urlPath === '/api/push/subscribe' && req.method === 'POST') {
    const user = await requireActiveUser(req, res);
    if (!user) return;
    const body = await parseBody(req);
    const { endpoint, keys } = body.subscription || body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return json(res, 400, { error: 'Abonnement push invalide.' });
    }
    // Un même endpoint ne doit exister qu'une fois — un nouvel abonnement du même
    // navigateur remplace juste les clés (elles peuvent être régénérées côté navigateur).
    const existing = await db.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').get(endpoint);
    if (existing) {
      await db.prepare('UPDATE push_subscriptions SET user_id = ?, keys_p256dh = ?, keys_auth = ? WHERE id = ?')
        .run(user.id, keys.p256dh, keys.auth, existing.id);
    } else {
      await db.prepare('INSERT INTO push_subscriptions (user_id, endpoint, keys_p256dh, keys_auth) VALUES (?, ?, ?, ?)')
        .run(user.id, endpoint, keys.p256dh, keys.auth);
    }
    return json(res, 200, { success: true });
  }

  if (urlPath === '/api/push/unsubscribe' && req.method === 'POST') {
    const user = await requireActiveUser(req, res);
    if (!user) return;
    const { endpoint } = await parseBody(req);
    if (!endpoint) return json(res, 400, { error: 'endpoint requis.' });
    await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, user.id);
    return json(res, 200, { success: true });
  }

  return null;
}

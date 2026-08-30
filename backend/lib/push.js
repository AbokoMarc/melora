// Notifications push (Web Push / VAPID) — le vrai mécanisme qui prévient quelqu'un
// même onglet fermé ou service en veille (Render free tier). Indépendant du canal SSE :
// SSE = temps réel tant que la page est ouverte, Push = filet de sécurité sinon.
import webpush from 'web-push';
import { db } from '../db.js';

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

export const pushEnabled = Boolean(PUBLIC_KEY && PRIVATE_KEY);

if (pushEnabled) {
  webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
} else {
  console.warn('[melora] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY absents — push notifications désactivées ' +
    '(générer avec : npx web-push generate-vapid-keys). Le reste de l\'app fonctionne normalement.');
}

export function getPublicKey() {
  return PUBLIC_KEY || null;
}

// Envoie une notification à TOUS les appareils d'un utilisateur (multi-device).
// Nettoie automatiquement les abonnements morts (410 Gone / 404) — un navigateur peut
// invalider un abonnement sans prévenir (désinstallation, effacement des données, etc).
export async function sendPushToUser(userId, payload) {
  if (!pushEnabled) return;
  const subs = await db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
  if (subs.length === 0) return;

  const body = JSON.stringify(payload);
  await Promise.all(subs.map(async (sub) => {
    const subscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth },
    };
    try {
      await webpush.sendNotification(subscription, body);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
      } else {
        console.error('[melora] échec envoi push:', err.statusCode, err.message);
      }
    }
  }));
}

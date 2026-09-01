// Hub temps réel — Server-Sent Events (natif, aucune dépendance), même mécanisme que Roomia.
// Choisi plutôt que WebSocket : sur un process unique / free tier, WebSocket n'apporte aucun
// avantage réel ici (voir échange précédent) et coûte plus de code à maintenir en solo.
import { findActiveCallsFor, finishCall } from './calls.js';

const clients = new Map(); // userId -> Set(res)

// Présence en mémoire (pas de table à écrire à chaque heartbeat) : userId -> { since, deviceCount }
const presence = new Map();
const PRESENCE_TTL_MS = 60_000;

export function sseHandler(req, res, user) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('retry: 3000\n\n');

  if (!clients.has(user.id)) clients.set(user.id, new Set());
  clients.get(user.id).add(res);
  markOnline(user.id);

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* noop */ }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    const set = clients.get(user.id);
    set?.delete(res);
    if (set && set.size === 0) {
      markOffline(user.id);
      // Coupure en plein appel -> l'autre partie ne doit pas rester à attendre indéfiniment
      // quelqu'un dont la connexion vient de tomber (perte réseau, onglet fermé, etc).
      for (const { callId, callerId, calleeId } of findActiveCallsFor(user.id)) {
        const otherId = user.id === callerId ? calleeId : callerId;
        finishCall(callId).catch(() => {});
        send(otherId, 'call.ended', { call_id: callId, reason: 'disconnected' });
      }
    }
  });
}

function send(userId, event, data) {
  const conns = clients.get(userId);
  if (!conns) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of conns) {
    try { res.write(payload); } catch { /* noop */ }
  }
}

export function notifyUser(userId, event, data) {
  send(userId, event, data);
}

export function notifyUsers(userIds, event, data) {
  for (const id of userIds) send(id, event, data);
}

// Force la déconnexion temps réel d'un utilisateur qu'un admin vient de suspendre —
// sinon il resterait connecté (SSE ouvert) jusqu'à expiration naturelle du JWT.
export function forceDisconnect(userId) {
  const conns = clients.get(userId);
  if (!conns) return;
  for (const res of conns) {
    try {
      res.write(`event: force_logout\ndata: {}\n\n`);
      res.end();
    } catch { /* noop */ }
  }
  clients.delete(userId);
  markOffline(userId);
}

function markOnline(userId) {
  presence.set(userId, { lastSeen: Date.now() });
}
function markOffline(userId) {
  presence.set(userId, { lastSeen: Date.now(), offlineSince: Date.now() });
}

export function isOnline(userId) {
  return clients.has(userId) && clients.get(userId).size > 0;
}

export function getPresenceSnapshot(userIds) {
  const now = Date.now();
  return userIds.map(id => {
    const online = isOnline(id);
    const p = presence.get(id);
    return {
      user_id: id,
      online,
      last_seen: online ? null : (p ? new Date(p.lastSeen).toISOString() : null),
    };
  });
}

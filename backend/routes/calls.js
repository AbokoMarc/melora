import { db } from '../db.js';
import { json, parseBody } from '../lib/http.js';
import { requireActiveUser } from '../lib/auth.js';
import { notifyUser, isOnline } from '../lib/sse.js';
import { sendPushToUser } from '../lib/push.js';
import { createCall, getCall, markAccepted, finishCall, logMissedOfflineCall } from '../lib/calls.js';

export async function handleCalls(req, res, urlPath) {
  if (!urlPath.startsWith('/api/calls')) return null;

  // Serveurs STUN/TURN pour l'établissement de connexion WebRTC.
  if (urlPath === '/api/calls/ice-servers' && req.method === 'GET') {
    const user = await requireActiveUser(req, res);
    if (!user) return;
    const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    if (process.env.TURN_URL) {
      iceServers.push({
        urls: process.env.TURN_URL,
        username: process.env.TURN_USERNAME,
        credential: process.env.TURN_CREDENTIAL,
      });
    }
    return json(res, 200, { ice_servers: iceServers });
  }

  // --- Journal des appels (onglet "Appels" : tous / manqués) ---
  if (urlPath === '/api/calls/log' && req.method === 'GET') {
    const user = await requireActiveUser(req, res);
    if (!user) return;
    const rows = await db.prepare(`
      SELECT cl.id, cl.mode, cl.status, cl.started_at, cl.ended_at, cl.caller_id, cl.callee_id,
             CASE WHEN cl.caller_id = ? THEN cl.callee_id ELSE cl.caller_id END AS peer_id,
             CASE WHEN cl.caller_id = ? THEN peer_callee.display_name ELSE peer_caller.display_name END AS peer_name,
             (cl.caller_id = ?) AS outgoing
      FROM call_logs cl
      LEFT JOIN users peer_callee ON peer_callee.id = cl.callee_id
      LEFT JOIN users peer_caller ON peer_caller.id = cl.caller_id
      WHERE cl.caller_id = ? OR cl.callee_id = ?
      ORDER BY cl.started_at DESC
      LIMIT 100
    `).all(user.id, user.id, user.id, user.id, user.id);
    return json(res, 200, { calls: rows });
  }

  // --- Démarrer un appel (audio ou vidéo) vers un membre d'une conversation privée ---
  if (urlPath === '/api/calls/invite' && req.method === 'POST') {
    const user = await requireActiveUser(req, res);
    if (!user) return;
    const { conversation_id, mode } = await parseBody(req);
    if (!conversation_id || !['audio', 'video'].includes(mode)) {
      return json(res, 400, { error: 'conversation_id et mode (audio|video) requis.' });
    }
    const membership = await db.prepare(
      'SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
    ).get(conversation_id, user.id);
    if (!membership) return json(res, 403, { error: 'Accès refusé à cette conversation.' });

    const conv = await db.prepare('SELECT type FROM conversations WHERE id = ?').get(conversation_id);
    if (conv?.type !== 'private') return json(res, 400, { error: 'Les appels ne sont supportés que pour les conversations privées pour le moment.' });

    const peer = await db.prepare(
      'SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ?'
    ).get(conversation_id, user.id);
    if (!peer) return json(res, 404, { error: 'Correspondant introuvable.' });

    if (!isOnline(peer.user_id)) {
      await logMissedOfflineCall({ callerId: user.id, calleeId: peer.user_id, mode });
      const caller = await db.prepare('SELECT display_name FROM users WHERE id = ?').get(user.id);
      sendPushToUser(peer.user_id, {
        title: `${caller?.display_name || 'Quelqu\'un'} vous appelle`,
        body: mode === 'video' ? 'Appel vidéo manqué' : 'Appel audio manqué',
        url: `/app.html?conversation=${conversation_id}`,
      }).catch(() => {});
      return json(res, 202, { warning: "Correspondant hors ligne — appel enregistré comme manqué, notification envoyée." });
    }

    const callId = await createCall({ callerId: user.id, calleeId: peer.user_id, conversationId: conversation_id, mode });
    const caller = await db.prepare('SELECT id, display_name, avatar FROM users WHERE id = ?').get(user.id);
    notifyUser(peer.user_id, 'call.invite', { call_id: callId, conversation_id, mode, from: caller });
    return json(res, 201, { call_id: callId });
  }

  // --- Décrocher / refuser / raccrocher ---
  const answerMatch = urlPath.match(/^\/api\/calls\/([\w-]+)\/(accept|decline|end)$/);
  if (answerMatch && req.method === 'POST') {
    const user = await requireActiveUser(req, res);
    if (!user) return;
    const [, callId, action] = answerMatch;
    const call = getCall(callId);
    if (!call) return json(res, 404, { error: 'Appel introuvable ou déjà terminé.' });
    if (user.id !== call.callerId && user.id !== call.calleeId) return json(res, 403, { error: 'Accès refusé.' });

    const otherId = user.id === call.callerId ? call.calleeId : call.callerId;

    if (action === 'accept') {
      await markAccepted(callId);
      notifyUser(otherId, 'call.accepted', { call_id: callId });
    } else if (action === 'decline') {
      await finishCall(callId, 'declined');
      notifyUser(otherId, 'call.declined', { call_id: callId });
    } else {
      await finishCall(callId);
      notifyUser(otherId, 'call.ended', { call_id: callId, by: user.id });
    }
    return json(res, 200, { success: true });
  }

  // --- Échange WebRTC (offer / answer / ICE candidates) — relayé tel quel, jamais interprété ---
  const signalMatch = urlPath.match(/^\/api\/calls\/([\w-]+)\/signal$/);
  if (signalMatch && req.method === 'POST') {
    const user = await requireActiveUser(req, res);
    if (!user) return;
    const callId = signalMatch[1];
    const call = getCall(callId);
    if (!call) return json(res, 404, { error: 'Appel introuvable ou déjà terminé.' });
    if (user.id !== call.callerId && user.id !== call.calleeId) return json(res, 403, { error: 'Accès refusé.' });

    const { signal_type, payload } = await parseBody(req);
    if (!signal_type || !payload) return json(res, 400, { error: 'signal_type et payload requis.' });
    const otherId = user.id === call.callerId ? call.calleeId : call.callerId;
    notifyUser(otherId, 'call.signal', { call_id: callId, signal_type, payload });
    return json(res, 200, { success: true });
  }

  return null;
}

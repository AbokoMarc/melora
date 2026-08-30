// Registre des appels en cours — en mémoire, comme la présence (lib/sse.js).
// Un appel est éphémère par nature : rien à persister en base, juste besoin de savoir
// qui parle à qui pendant la durée de l'appel, pour router le signaling WebRTC et
// nettoyer proprement si quelqu'un se déconnecte en plein appel.
import crypto from 'node:crypto';

const calls = new Map(); // callId -> { callerId, calleeId, conversationId, mode, status }

export function createCall({ callerId, calleeId, conversationId, mode }) {
  const callId = crypto.randomUUID();
  calls.set(callId, { callerId, calleeId, conversationId, mode, status: 'ringing' });
  return callId;
}

export function getCall(callId) {
  return calls.get(callId) || null;
}

export function updateCallStatus(callId, status) {
  const call = calls.get(callId);
  if (call) call.status = status;
}

export function endCall(callId) {
  calls.delete(callId);
}

// Si un utilisateur perd sa connexion SSE en plein appel, l'autre partie doit être prévenue
// plutôt que de rester à attendre un correspondant qui ne reviendra pas.
export function findActiveCallsFor(userId) {
  const result = [];
  for (const [callId, call] of calls) {
    if (call.callerId === userId || call.calleeId === userId) result.push({ callId, ...call });
  }
  return result;
}

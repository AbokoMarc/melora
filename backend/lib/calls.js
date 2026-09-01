// Registre des appels en cours (mémoire, comme la présence) pour router le signaling WebRTC,
// + écriture dans call_logs (Turso) pour que l'onglet "Appels" (tous / manqués) ait un historique.
import crypto from 'node:crypto';
import { db } from '../db.js';

const calls = new Map(); // callId -> { callerId, calleeId, conversationId, mode, status, logId }

export async function createCall({ callerId, calleeId, conversationId, mode }) {
  const callId = crypto.randomUUID();
  const result = await db.prepare(
    'INSERT INTO call_logs (caller_id, callee_id, mode, status) VALUES (?, ?, ?, ?)'
  ).run(callerId, calleeId, mode, 'ringing');
  calls.set(callId, { callerId, calleeId, conversationId, mode, status: 'ringing', logId: result.lastInsertRowid });
  return callId;
}

// Appel jamais décroché car l'appelé était hors ligne — journalisé tout de suite,
// pas la peine de garder une entrée en mémoire pour un correspondant qui ne répondra pas.
export async function logMissedOfflineCall({ callerId, calleeId, mode }) {
  await db.prepare(
    "INSERT INTO call_logs (caller_id, callee_id, mode, status, ended_at) VALUES (?, ?, ?, 'missed', datetime('now'))"
  ).run(callerId, calleeId, mode);
}

export function getCall(callId) {
  return calls.get(callId) || null;
}

export async function markAccepted(callId) {
  const call = calls.get(callId);
  if (!call) return;
  call.status = 'active';
  await db.prepare("UPDATE call_logs SET status = 'answered', answered_at = datetime('now') WHERE id = ?").run(call.logId);
}

// Statut final : 'ended' si l'appel a été décroché puis raccroché, 'missed' s'il n'a jamais
// été décroché (raccroché pendant la sonnerie, ou correspondant déconnecté avant de répondre).
export async function finishCall(callId, explicitStatus = null) {
  const call = calls.get(callId);
  if (!call) return null;
  const status = explicitStatus || (call.status === 'active' ? 'ended' : 'missed');
  await db.prepare("UPDATE call_logs SET status = ?, ended_at = datetime('now') WHERE id = ?").run(status, call.logId);
  calls.delete(callId);
  return call;
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

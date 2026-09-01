import crypto from 'node:crypto';
import { db } from '../db.js';
import { json, parseBody } from '../lib/http.js';
import { requireAdmin, requireSuperAdmin, hashPassword } from '../lib/auth.js';
import { forceDisconnect, notifyUser } from '../lib/sse.js';

function logAdminAction(adminId, action, { targetUserId = null, targetConversationId = null, detail = null } = {}) {
  return db.prepare(`
    INSERT INTO admin_access_log (admin_id, action, target_user_id, target_conversation_id, detail)
    VALUES (?, ?, ?, ?, ?)
  `).run(adminId, action, targetUserId, targetConversationId, detail);
}

export async function handleAdmin(req, res, urlPath, urlObj) {
  if (!urlPath.startsWith('/api/admin/')) return null;

  // --- Liste des utilisateurs (admin + super_admin) ---
  if (urlPath === '/api/admin/users' && req.method === 'GET') {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const rows = await db.prepare(`
      SELECT id, username, email, display_name, role, status, suspended_reason,
             organization_name, must_change_password, last_seen, created_at
      FROM users ORDER BY created_at DESC
    `).all();
    return json(res, 200, { users: rows });
  }

  // --- Suspendre un utilisateur ---
  const suspendMatch = urlPath.match(/^\/api\/admin\/users\/(\d+)\/suspend$/);
  if (suspendMatch && req.method === 'PUT') {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const targetId = Number(suspendMatch[1]);
    const target = await db.prepare('SELECT id, role FROM users WHERE id = ?').get(targetId);
    if (!target) return json(res, 404, { error: 'Utilisateur introuvable.' });
    if (target.role === 'super_admin') return json(res, 403, { error: 'Le super administrateur ne peut pas être suspendu.' });
    if (target.role === 'admin' && admin.role !== 'super_admin') {
      return json(res, 403, { error: 'Seul le super administrateur peut suspendre un autre administrateur.' });
    }

    const body = await parseBody(req);
    const reason = body.reason || null;
    await db.prepare(`
      UPDATE users SET status = 'suspended', suspended_reason = ?, suspended_at = datetime('now'), suspended_by = ?
      WHERE id = ?
    `).run(reason, admin.id, targetId);
    await logAdminAction(admin.id, 'suspend', { targetUserId: targetId, detail: reason });
    forceDisconnect(targetId); // coupe immédiatement sa connexion temps réel en cours

    return json(res, 200, { success: true });
  }

  // --- Réactiver un utilisateur ---
  const unsuspendMatch = urlPath.match(/^\/api\/admin\/users\/(\d+)\/unsuspend$/);
  if (unsuspendMatch && req.method === 'PUT') {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const targetId = Number(unsuspendMatch[1]);
    await db.prepare(`
      UPDATE users SET status = 'active', suspended_reason = NULL, suspended_at = NULL, suspended_by = NULL
      WHERE id = ?
    `).run(targetId);
    await logAdminAction(admin.id, 'unsuspend', { targetUserId: targetId });
    return json(res, 200, { success: true });
  }

  // --- Réinitialiser le mot de passe d'un utilisateur (mot de passe oublié) ---
  const resetPwMatch = urlPath.match(/^\/api\/admin\/users\/(\d+)\/reset-password$/);
  if (resetPwMatch && req.method === 'POST') {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const targetId = Number(resetPwMatch[1]);
    const target = await db.prepare('SELECT id, role FROM users WHERE id = ?').get(targetId);
    if (!target) return json(res, 404, { error: 'Utilisateur introuvable.' });
    if (target.role !== 'member' && admin.role !== 'super_admin') {
      return json(res, 403, { error: 'Seul le super administrateur peut réinitialiser le mot de passe d\'un administrateur.' });
    }

    const body = await parseBody(req);
    // Si aucun mot de passe n'est fourni, on en génère un temporaire lisible à transmettre à la main.
    const tempPassword = body.new_password || crypto.randomBytes(6).toString('base64url');
    await db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?')
      .run(hashPassword(tempPassword), targetId);
    await logAdminAction(admin.id, 'reset_password', { targetUserId: targetId });

    // Le mot de passe temporaire n'est renvoyé qu'une fois, à l'admin qui vient de le générer —
    // jamais stocké en clair, jamais loggé.
    return json(res, 200, { success: true, temporary_password: tempPassword });
  }

  // --- Changer le rôle d'un utilisateur (super_admin uniquement) ---
  const roleMatch = urlPath.match(/^\/api\/admin\/users\/(\d+)\/role$/);
  if (roleMatch && req.method === 'PUT') {
    const admin = await requireSuperAdmin(req, res);
    if (!admin) return;
    const targetId = Number(roleMatch[1]);
    const body = await parseBody(req);
    if (!['member', 'admin'].includes(body.role)) {
      return json(res, 400, { error: "Rôle invalide (seuls 'member' et 'admin' peuvent être attribués)." });
    }
    if (targetId === admin.id) return json(res, 400, { error: 'Vous ne pouvez pas modifier votre propre rôle.' });
    await db.prepare('UPDATE users SET role = ? WHERE id = ?').run(body.role, targetId);
    await logAdminAction(admin.id, 'role_change', { targetUserId: targetId, detail: body.role });
    return json(res, 200, { success: true });
  }

  // --- Lister toutes les conversations (modération) ---
  if (urlPath === '/api/admin/conversations' && req.method === 'GET') {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const rows = await db.prepare(`
      SELECT c.id, c.type, c.name, c.created_at,
             (SELECT COUNT(*) FROM conversation_members m WHERE m.conversation_id = c.id) AS member_count,
             (SELECT COUNT(*) FROM messages msg WHERE msg.conversation_id = c.id) AS message_count,
             (SELECT GROUP_CONCAT(u.display_name, ' ↔ ') FROM conversation_members m
                JOIN users u ON u.id = m.user_id WHERE m.conversation_id = c.id) AS participants
      FROM conversations c ORDER BY c.created_at DESC
    `).all();
    return json(res, 200, { conversations: rows });
  }

  // --- Voir les messages de N'IMPORTE QUELLE conversation (anti-fraude) — journalisé ---
  const viewMsgMatch = urlPath.match(/^\/api\/admin\/conversations\/(\d+)\/messages$/);
  if (viewMsgMatch && req.method === 'GET') {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const conversationId = Number(viewMsgMatch[1]);
    const limit = Math.min(Number(urlObj.searchParams.get('limit')) || 100, 200);

    const rows = await db.prepare(`
      SELECT m.id, m.sender_id, u.display_name AS sender_name, u.username AS sender_username,
             m.type, m.content, m.media_url, m.created_at, m.deleted_at
      FROM messages m JOIN users u ON u.id = m.sender_id
      WHERE m.conversation_id = ?
      ORDER BY m.created_at DESC LIMIT ?
    `).all(conversationId, limit);

    // Traçabilité : chaque consultation par un admin est enregistrée, consultable par le super_admin.
    await logAdminAction(admin.id, 'view_messages', { targetConversationId: conversationId, detail: `${rows.length} messages consultés` });

    return json(res, 200, { messages: rows.reverse() });
  }

  // --- Journal d'audit des actions admin (super_admin uniquement) ---
  if (urlPath === '/api/admin/access-log' && req.method === 'GET') {
    const admin = await requireSuperAdmin(req, res);
    if (!admin) return;
    const rows = await db.prepare(`
      SELECT l.id, l.action, l.detail, l.created_at,
             a.display_name AS admin_name, a.username AS admin_username,
             t.display_name AS target_name, t.username AS target_username
      FROM admin_access_log l
      JOIN users a ON a.id = l.admin_id
      LEFT JOIN users t ON t.id = l.target_user_id
      ORDER BY l.created_at DESC LIMIT 200
    `).all();
    return json(res, 200, { log: rows });
  }

  return null;
}

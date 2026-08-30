import { db } from '../db.js';
import { json, parseBody } from '../lib/http.js';
import { requireActiveUser } from '../lib/auth.js';
import { getPresenceSnapshot } from '../lib/sse.js';

export async function handleConversations(req, res, urlPath) {
  // --- Liste de mes conversations, avec dernier message et présence des interlocuteurs ---
  if (urlPath === '/api/conversations' && req.method === 'GET') {
    const user = await requireActiveUser(req, res);
    if (!user) return;

    const rows = await db.prepare(`
      SELECT c.id, c.type,
             CASE WHEN c.type = 'private' THEN peer.display_name ELSE c.name END AS name,
             CASE WHEN c.type = 'private' THEN peer.avatar ELSE c.avatar END AS avatar,
             CASE WHEN c.type = 'private' THEN peer.id ELSE NULL END AS peer_id,
             cm.last_read_message_id,
             (SELECT m.content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
             (SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_at,
             (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.id > cm.last_read_message_id AND m.sender_id != ?) AS unread_count
      FROM conversations c
      JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ?
      LEFT JOIN conversation_members pm ON pm.conversation_id = c.id AND pm.user_id != ? AND c.type = 'private'
      LEFT JOIN users peer ON peer.id = pm.user_id
      WHERE cm.user_id = ?
      ORDER BY last_message_at DESC NULLS LAST
    `).all(user.id, user.id, user.id, user.id);

    return json(res, 200, { conversations: rows });
  }

  // --- Créer une conversation privée (ou la retrouver si elle existe déjà) ou un groupe ---
  if (urlPath === '/api/conversations' && req.method === 'POST') {
    const user = await requireActiveUser(req, res);
    if (!user) return;
    const body = await parseBody(req);

    if (body.type === 'group') {
      if (!body.name || !Array.isArray(body.member_ids) || body.member_ids.length === 0) {
        return json(res, 400, { error: 'Nom du groupe et au moins un membre requis.' });
      }
      const result = await db.prepare('INSERT INTO conversations (type, name, created_by) VALUES (?, ?, ?)')
        .run('group', body.name, user.id);
      const convId = result.lastInsertRowid;
      await db.prepare('INSERT INTO conversation_members (conversation_id, user_id, member_role) VALUES (?, ?, ?)').run(convId, user.id, 'owner');
      for (const memberId of body.member_ids) {
        if (memberId === user.id) continue;
        await db.prepare('INSERT INTO conversation_members (conversation_id, user_id, member_role) VALUES (?, ?, ?)').run(convId, memberId, 'member');
      }
      return json(res, 201, { conversation: { id: convId, type: 'group', name: body.name } });
    }

    // Conversation privée : on la retrouve si elle existe déjà entre ces deux utilisateurs.
    const { peer_id } = body;
    if (!peer_id) return json(res, 400, { error: 'peer_id requis.' });
    const existing = await db.prepare(`
      SELECT c.id FROM conversations c
      JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = ?
      JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = ?
      WHERE c.type = 'private'
    `).get(user.id, peer_id);
    if (existing) return json(res, 200, { conversation: { id: existing.id, type: 'private' } });

    const result = await db.prepare('INSERT INTO conversations (type, created_by) VALUES (?, ?)').run('private', user.id);
    const convId = result.lastInsertRowid;
    await db.prepare('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)').run(convId, user.id);
    await db.prepare('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)').run(convId, peer_id);
    return json(res, 201, { conversation: { id: convId, type: 'private' } });
  }

  // --- Présence des membres d'une conversation ---
  const presenceMatch = urlPath.match(/^\/api\/conversations\/(\d+)\/presence$/);
  if (presenceMatch && req.method === 'GET') {
    const user = await requireActiveUser(req, res);
    if (!user) return;
    const convId = Number(presenceMatch[1]);
    const isMember = await db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(convId, user.id);
    if (!isMember) return json(res, 403, { error: 'Accès refusé.' });
    const members = await db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?').all(convId);
    return json(res, 200, { presence: getPresenceSnapshot(members.map(m => m.user_id)) });
  }

  return null;
}

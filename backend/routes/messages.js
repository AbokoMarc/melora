import { db } from '../db.js';
import { json, parseBody } from '../lib/http.js';
import { requireActiveUser } from '../lib/auth.js';
import { notifyUsers } from '../lib/sse.js';

async function membersOf(conversationId) {
  const rows = await db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?').all(conversationId);
  return rows.map(r => r.user_id);
}

export async function handleMessages(req, res, urlPath, urlObj) {
  // --- Pagination cursor : GET /api/conversations/:id/messages?before=<messageId>&limit=50 ---
  const listMatch = urlPath.match(/^\/api\/conversations\/(\d+)\/messages$/);
  if (listMatch && req.method === 'GET') {
    const user = await requireActiveUser(req, res);
    if (!user) return;
    const convId = Number(listMatch[1]);
    const isMember = await db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(convId, user.id);
    if (!isMember) return json(res, 403, { error: 'Accès refusé à cette conversation.' });

    const before = urlObj.searchParams.get('before');
    const limit = Math.min(Number(urlObj.searchParams.get('limit')) || 50, 100);

    const rows = before
      ? await db.prepare(`
          SELECT m.*, u.display_name AS sender_name, u.avatar AS sender_avatar
          FROM messages m JOIN users u ON u.id = m.sender_id
          WHERE m.conversation_id = ? AND m.id < ?
          ORDER BY m.id DESC LIMIT ?
        `).all(convId, before, limit)
      : await db.prepare(`
          SELECT m.*, u.display_name AS sender_name, u.avatar AS sender_avatar
          FROM messages m JOIN users u ON u.id = m.sender_id
          WHERE m.conversation_id = ?
          ORDER BY m.id DESC LIMIT ?
        `).all(convId, limit);

    return json(res, 200, { messages: rows.reverse(), has_more: rows.length === limit });
  }

  // --- Envoi d'un message (idempotent via client_message_id) ---
  if (listMatch && req.method === 'POST') {
    const user = await requireActiveUser(req, res);
    if (!user) return;
    const convId = Number(listMatch[1]);
    const isMember = await db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(convId, user.id);
    if (!isMember) return json(res, 403, { error: 'Accès refusé à cette conversation.' });

    const body = await parseBody(req);
    const { client_message_id, type, content, media_url, reply_to_id } = body;
    if (!client_message_id) return json(res, 400, { error: 'client_message_id requis (idempotence).' });
    if (!content && !media_url) return json(res, 400, { error: 'Message vide.' });

    // Retry réseau avec le même client_message_id -> on renvoie le message déjà créé, pas de doublon.
    const already = await db.prepare(
      'SELECT * FROM messages WHERE conversation_id = ? AND sender_id = ? AND client_message_id = ?'
    ).get(convId, user.id, client_message_id);
    if (already) return json(res, 200, { message: already, deduplicated: true });

    const result = await db.prepare(`
      INSERT INTO messages (client_message_id, conversation_id, sender_id, type, content, media_url, reply_to_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(client_message_id, convId, user.id, type || 'text', content || null, media_url || null, reply_to_id || null);

    const message = await db.prepare('SELECT * FROM messages WHERE id = ?').get(result.lastInsertRowid);
    const memberIds = await membersOf(convId);
    notifyUsers(memberIds, 'message.new', { conversation_id: convId, message });

    return json(res, 201, { message });
  }

  // --- Marquer comme lu : tous les messages jusqu'à :messageId ---
  const readMatch = urlPath.match(/^\/api\/conversations\/(\d+)\/read$/);
  if (readMatch && req.method === 'PUT') {
    const user = await requireActiveUser(req, res);
    if (!user) return;
    const convId = Number(readMatch[1]);
    const body = await parseBody(req);
    const upToMessageId = body.up_to_message_id;
    if (!upToMessageId) return json(res, 400, { error: 'up_to_message_id requis.' });

    const isMember = await db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(convId, user.id);
    if (!isMember) return json(res, 403, { error: 'Accès refusé.' });

    await db.prepare('UPDATE conversation_members SET last_read_message_id = ? WHERE conversation_id = ? AND user_id = ?')
      .run(upToMessageId, convId, user.id);

    const memberIds = (await membersOf(convId)).filter(id => id !== user.id);
    notifyUsers(memberIds, 'message.read', { conversation_id: convId, reader_id: user.id, up_to_message_id: upToMessageId });

    return json(res, 200, { success: true });
  }

  // --- Indicateur "écrit..." — éphémère, jamais persisté ---
  const typingMatch = urlPath.match(/^\/api\/conversations\/(\d+)\/typing$/);
  if (typingMatch && req.method === 'POST') {
    const user = await requireActiveUser(req, res);
    if (!user) return;
    const convId = Number(typingMatch[1]);
    const isMember = await db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(convId, user.id);
    if (!isMember) return json(res, 403, { error: 'Accès refusé.' });

    const body = await parseBody(req);
    const memberIds = (await membersOf(convId)).filter(id => id !== user.id);
    notifyUsers(memberIds, 'typing.update', { conversation_id: convId, user_id: user.id, typing: !!body.typing });
    return json(res, 200, { success: true });
  }

  return null;
}

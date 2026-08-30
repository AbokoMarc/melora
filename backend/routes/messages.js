import { db } from '../db.js';
import { json, parseBody } from '../lib/http.js';
import { requireActiveUser } from '../lib/auth.js';
import { notifyUsers, isOnline } from '../lib/sse.js';
import { sendPushToUser } from '../lib/push.js';

async function membersOf(conversationId) {
  const rows = await db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?').all(conversationId);
  return rows.map(r => r.user_id);
}

// Somme des non-lus sur toutes les conversations — alimente navigator.setAppBadge() côté client.
async function totalUnreadFor(userId) {
  const row = await db.prepare(`
    SELECT COALESCE(SUM(
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = cm.conversation_id
        AND m.id > cm.last_read_message_id AND m.sender_id != ?)
    ), 0) AS total
    FROM conversation_members cm WHERE cm.user_id = ?
  `).get(userId, userId);
  return row?.total || 0;
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
          SELECT m.*, u.display_name AS sender_name, u.avatar AS sender_avatar,
                 EXISTS(SELECT 1 FROM message_deliveries d WHERE d.message_id = m.id AND d.user_id != m.sender_id) AS delivered,
                 EXISTS(SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.user_id != m.sender_id) AS read
          FROM messages m JOIN users u ON u.id = m.sender_id
          WHERE m.conversation_id = ? AND m.id < ?
          ORDER BY m.id DESC LIMIT ?
        `).all(convId, before, limit)
      : await db.prepare(`
          SELECT m.*, u.display_name AS sender_name, u.avatar AS sender_avatar,
                 EXISTS(SELECT 1 FROM message_deliveries d WHERE d.message_id = m.id AND d.user_id != m.sender_id) AS delivered,
                 EXISTS(SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.user_id != m.sender_id) AS read
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
    // Notes vocales stockées en base64 dans Turso (pas de S3/Cloudinary sur le plan gratuit) —
    // on plafonne pour ne pas gonfler la base : ~350 Ko encodés ≈ 25-30s d'audio compressé.
    if (type === 'voice' && content && content.length > 350_000) {
      return json(res, 413, { error: 'Note vocale trop longue (30s max).' });
    }

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

    // Push uniquement vers les membres hors ligne : ceux connectés reçoivent déjà l'événement SSE
    // ci-dessus, un push en plus ferait doublon (deux notifications pour le même message).
    const offlineMemberIds = memberIds.filter(id => id !== user.id && !isOnline(id));
    if (offlineMemberIds.length > 0) {
      const sender = await db.prepare('SELECT display_name FROM users WHERE id = ?').get(user.id);
      const preview = (content || '').slice(0, 120) || (type === 'voice' ? 'Note vocale' : media_url ? 'Pièce jointe' : 'Nouveau message');
      for (const id of offlineMemberIds) {
        const badgeCount = await totalUnreadFor(id);
        sendPushToUser(id, {
          title: sender?.display_name || 'Melora',
          body: preview,
          icon: '/icon-192.png',
          badge: '/icon-192.png',
          count: badgeCount,
          url: `/app.html?conversation=${convId}`,
        }).catch(err => console.error('[melora] push échoué:', err));
      }
    }

    return json(res, 201, { message });
  }

  // --- Marquer comme livré (arrivé sur l'appareil, avant même d'être lu à l'écran) ---
  const deliveredMatch = urlPath.match(/^\/api\/conversations\/(\d+)\/delivered$/);
  if (deliveredMatch && req.method === 'PUT') {
    const user = await requireActiveUser(req, res);
    if (!user) return;
    const convId = Number(deliveredMatch[1]);
    const body = await parseBody(req);
    const upToMessageId = body.up_to_message_id;
    if (!upToMessageId) return json(res, 400, { error: 'up_to_message_id requis.' });

    const isMember = await db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(convId, user.id);
    if (!isMember) return json(res, 403, { error: 'Accès refusé.' });

    const undelivered = await db.prepare(`
      SELECT id FROM messages WHERE conversation_id = ? AND id <= ? AND sender_id != ?
    `).all(convId, upToMessageId, user.id);
    for (const m of undelivered) {
      await db.prepare('INSERT OR IGNORE INTO message_deliveries (message_id, user_id) VALUES (?, ?)').run(m.id, user.id);
    }

    const memberIds = (await membersOf(convId)).filter(id => id !== user.id);
    notifyUsers(memberIds, 'message.delivered', { conversation_id: convId, up_to_message_id: upToMessageId });
    return json(res, 200, { success: true });
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

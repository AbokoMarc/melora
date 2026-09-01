import { db } from '../db.js';
import { json, parseBody } from '../lib/http.js';
import { requireActiveUser } from '../lib/auth.js';
import { notifyUsers } from '../lib/sse.js';
import { sendPushToUser } from '../lib/push.js';

async function membersOf(conversationId) {
  const rows = await db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?').all(conversationId);
  return rows.map(r => r.user_id);
}

// Masque le contenu d'un message "vu unique" déjà consulté, pour tout le monde SAUF son
// expéditeur — jamais pour l'admin (routes/admin.js ne passe pas par cette fonction du tout,
// il lit les messages directement, donc la modération garde un accès complet).
function redactIfConsumed(m, viewerId) {
  if (m.view_once && m.viewed_once_at && m.sender_id !== viewerId) {
    return { ...m, content: null, media_url: null, redacted: true };
  }
  return m;
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

    return json(res, 200, { messages: rows.reverse().map(m => redactIfConsumed(m, user.id)), has_more: rows.length === limit });
  }

  // --- Révéler un message "vu unique" (le contenu disparaît ensuite pour tout le monde
  // sauf l'expéditeur et l'administration, qui garde un accès complet à des fins de modération) ---
  const consumeMatch = urlPath.match(/^\/api\/messages\/(\d+)\/consume-once$/);
  if (consumeMatch && req.method === 'POST') {
    const user = await requireActiveUser(req, res);
    if (!user) return;
    const messageId = Number(consumeMatch[1]);
    const message = await db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    if (!message) return json(res, 404, { error: 'Message introuvable.' });
    const isMember = await db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(message.conversation_id, user.id);
    if (!isMember) return json(res, 403, { error: 'Accès refusé.' });
    if (message.sender_id === user.id) return json(res, 200, { content: message.content, media_url: message.media_url }); // l'auteur garde toujours accès
    if (!message.viewed_once_at) {
      await db.prepare("UPDATE messages SET viewed_once_at = datetime('now') WHERE id = ?").run(messageId);
    }
    return json(res, 200, { content: message.content, media_url: message.media_url });
  }

  // --- Envoi d'un message (idempotent via client_message_id) ---
  if (listMatch && req.method === 'POST') {
    const user = await requireActiveUser(req, res);
    if (!user) return;
    const convId = Number(listMatch[1]);
    const isMember = await db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(convId, user.id);
    if (!isMember) return json(res, 403, { error: 'Accès refusé à cette conversation.' });

    const body = await parseBody(req);
    const { client_message_id, type, content, media_url, reply_to_id, filename, view_once } = body;
    if (!client_message_id) return json(res, 400, { error: 'client_message_id requis (idempotence).' });
    if (!content && !media_url) return json(res, 400, { error: 'Message vide.' });
    // Médias stockés en base64 dans Turso (pas de S3/Cloudinary sur le plan gratuit) — plafonds
    // par type pour ne pas gonfler la base. Vidéo particulièrement limité : sans stockage objet,
    // une vraie vidéo n'a pas sa place dans une colonne texte — à revoir si le volume augmente.
    const SIZE_LIMITS = { voice: 350_000, image: 1_500_000, document: 3_000_000, video: 4_000_000 };
    if (SIZE_LIMITS[type] && content && content.length > SIZE_LIMITS[type]) {
      const labels = { voice: 'Note vocale trop longue (30s max).', image: 'Image trop lourde (1,5 Mo max).', document: 'Document trop lourd (3 Mo max).', video: 'Vidéo trop lourde (quelques secondes max, ~4 Mo).' };
      return json(res, 413, { error: labels[type] });
    }

    // Retry réseau avec le même client_message_id -> on renvoie le message déjà créé, pas de doublon.
    const already = await db.prepare(
      'SELECT * FROM messages WHERE conversation_id = ? AND sender_id = ? AND client_message_id = ?'
    ).get(convId, user.id, client_message_id);
    if (already) return json(res, 200, { message: already, deduplicated: true });

    const result = await db.prepare(`
      INSERT INTO messages (client_message_id, conversation_id, sender_id, type, content, media_url, filename, view_once, reply_to_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(client_message_id, convId, user.id, type || 'text', content || null, media_url || null, filename || null, view_once ? 1 : 0, reply_to_id || null);

    const message = await db.prepare('SELECT * FROM messages WHERE id = ?').get(result.lastInsertRowid);
    const memberIds = await membersOf(convId);
    notifyUsers(memberIds, 'message.new', { conversation_id: convId, message });

    // Push envoyé à TOUS les destinataires, en ligne ou non — comme une vraie notification
    // de téléphone : on veut que la personne le sache même si elle a l'app ouverte ailleurs
    // (autre onglet, en arrière-plan) sans regarder cette conversation précise. Le navigateur
    // affiche cette notification système indépendamment de l'état de la page (voir sw.js).
    const recipientIds = memberIds.filter(id => id !== user.id);
    if (recipientIds.length > 0) {
      const sender = await db.prepare('SELECT display_name FROM users WHERE id = ?').get(user.id);
      const preview = view_once ? '👁 Message vu unique' : (content || '').slice(0, 120) || (type === 'voice' ? 'Note vocale' : type === 'image' ? 'Photo' : type === 'video' ? 'Vidéo' : type === 'document' ? filename || 'Document' : 'Nouveau message');
      for (const id of recipientIds) {
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

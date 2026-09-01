import { db } from '../db.js';
import { json, parseBody } from '../lib/http.js';
import { requireActiveUser } from '../lib/auth.js';

// Texte pour l'instant (image/vidéo prévus mais pas encore branchés — cf. README) :
// une "carte" colorée avec du texte, comme les statuts texte de WhatsApp.
export async function handleStatuses(req, res, urlPath) {
  if (!urlPath.startsWith('/api/statuses')) return null;

  if (urlPath === '/api/statuses' && req.method === 'POST') {
    const user = await requireActiveUser(req, res);
    if (!user) return;
    const { content, bg_color } = await parseBody(req);
    if (!content || !content.trim()) return json(res, 400, { error: 'Contenu requis.' });
    if (content.length > 280) return json(res, 400, { error: '280 caractères maximum.' });
    const result = await db.prepare(`
      INSERT INTO statuses (user_id, type, content, bg_color, expires_at)
      VALUES (?, 'text', ?, ?, datetime('now', '+24 hours'))
    `).run(user.id, content.trim(), bg_color || '#d9822b');
    const status = await db.prepare('SELECT * FROM statuses WHERE id = ?').get(result.lastInsertRowid);
    return json(res, 201, { status });
  }

  // Liste groupée par auteur (le plus récent en premier), non expirés uniquement.
  // Pas de notion de "contacts" dans ce système -> on montre tout le monde de l'organisation ;
  // sur 100 personnes ça reste lisible, à affiner si le besoin de restriction apparaît plus tard.
  if (urlPath === '/api/statuses' && req.method === 'GET') {
    const user = await requireActiveUser(req, res);
    if (!user) return;
    const rows = await db.prepare(`
      SELECT s.id, s.user_id, s.type, s.content, s.bg_color, s.created_at, s.expires_at,
             u.display_name AS author_name, u.avatar AS author_avatar,
             EXISTS(SELECT 1 FROM status_views v WHERE v.status_id = s.id AND v.viewer_id = ?) AS viewed_by_me,
             (SELECT COUNT(*) FROM status_views v WHERE v.status_id = s.id) AS view_count
      FROM statuses s
      JOIN users u ON u.id = s.user_id
      WHERE s.expires_at > datetime('now')
      ORDER BY s.created_at DESC
    `).all(user.id);
    return json(res, 200, { statuses: rows });
  }

  const viewMatch = urlPath.match(/^\/api\/statuses\/(\d+)\/view$/);
  if (viewMatch && req.method === 'POST') {
    const user = await requireActiveUser(req, res);
    if (!user) return;
    const statusId = Number(viewMatch[1]);
    await db.prepare('INSERT OR IGNORE INTO status_views (status_id, viewer_id) VALUES (?, ?)').run(statusId, user.id);
    return json(res, 200, { success: true });
  }

  // --- Retirer son propre statut avant son expiration naturelle ---
  const deleteMatch = urlPath.match(/^\/api\/statuses\/(\d+)$/);
  if (deleteMatch && req.method === 'DELETE') {
    const user = await requireActiveUser(req, res);
    if (!user) return;
    const statusId = Number(deleteMatch[1]);
    const status = await db.prepare('SELECT user_id FROM statuses WHERE id = ?').get(statusId);
    if (!status) return json(res, 404, { error: 'Statut introuvable.' });
    if (status.user_id !== user.id) return json(res, 403, { error: "Tu ne peux retirer que tes propres statuts." });
    await db.prepare('DELETE FROM status_views WHERE status_id = ?').run(statusId);
    await db.prepare('DELETE FROM statuses WHERE id = ?').run(statusId);
    return json(res, 200, { success: true });
  }

  return null;
}

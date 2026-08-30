import { db } from '../db.js';
import { json, parseBody } from '../lib/http.js';
import { requireActiveUser } from '../lib/auth.js';

export async function handleUsers(req, res, urlPath, urlObj) {
  if (urlPath === '/api/users/me' && req.method === 'GET') {
    const user = await requireActiveUser(req, res);
    if (!user) return;
    const row = await db.prepare(`
      SELECT id, username, email, display_name, avatar, bio, organization_name, organization_type, role
      FROM users WHERE id = ?
    `).get(user.id);
    return json(res, 200, { user: row });
  }

  if (urlPath === '/api/users/me' && req.method === 'PATCH') {
    const user = await requireActiveUser(req, res);
    if (!user) return;
    const body = await parseBody(req);
    const fields = ['display_name', 'avatar', 'bio'];
    const updates = fields.filter(f => body[f] !== undefined);
    if (updates.length === 0) return json(res, 400, { error: 'Aucun champ à mettre à jour.' });
    const sql = `UPDATE users SET ${updates.map(f => `${f} = ?`).join(', ')} WHERE id = ?`;
    await db.prepare(sql).run(...updates.map(f => body[f]), user.id);
    return json(res, 200, { success: true });
  }

  // Recherche pour démarrer une conversation (au sein de la même organisation d'abord)
  if (urlPath === '/api/users/search' && req.method === 'GET') {
    const user = await requireActiveUser(req, res);
    if (!user) return;
    const q = (urlObj.searchParams.get('q') || '').trim();
    if (q.length < 2) return json(res, 200, { users: [] });
    const rows = await db.prepare(`
      SELECT id, username, display_name, avatar, organization_name
      FROM users
      WHERE id != ? AND status = 'active' AND (username LIKE ? OR display_name LIKE ?)
      LIMIT 20
    `).all(user.id, `%${q}%`, `%${q}%`);
    return json(res, 200, { users: rows });
  }

  // Heartbeat léger : met à jour last_seen sans solliciter Turso à chaque frappe
  // (la présence "live" passe par lib/sse.js en mémoire — ceci ne sert que le "dernière connexion" affiché hors ligne)
  if (urlPath === '/api/users/heartbeat' && req.method === 'POST') {
    const user = await requireActiveUser(req, res);
    if (!user) return;
    await db.prepare("UPDATE users SET last_seen = datetime('now') WHERE id = ?").run(user.id);
    return json(res, 200, { success: true });
  }

  return null;
}

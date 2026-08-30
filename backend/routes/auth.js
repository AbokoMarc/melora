import { db } from '../db.js';
import { json, parseBody } from '../lib/http.js';
import { hashPassword, verifyPassword, signToken, requireAuth } from '../lib/auth.js';

const usernameRe = /^[a-z0-9_.]{3,30}$/i;

export async function handleAuth(req, res, urlPath) {
  if (urlPath === '/api/auth/register' && req.method === 'POST') {
    const body = await parseBody(req);
    const { username, email, password, display_name, organization_name, organization_type, bio } = body;

    if (!username || !usernameRe.test(username)) return json(res, 400, { error: "Nom d'utilisateur invalide (3-30 caractères, lettres/chiffres/._)." });
    if (!email || !email.includes('@')) return json(res, 400, { error: 'Adresse e-mail invalide.' });
    if (!password || password.length < 8) return json(res, 400, { error: 'Le mot de passe doit contenir au moins 8 caractères.' });
    if (!display_name) return json(res, 400, { error: 'Nom affiché requis.' });

    const existing = await db.prepare('SELECT id FROM users WHERE email = ? OR username = ?').get(email, username);
    if (existing) return json(res, 409, { error: 'E-mail ou nom d\'utilisateur déjà utilisé.' });

    const password_hash = hashPassword(password);
    const result = await db.prepare(`
      INSERT INTO users (username, email, password_hash, display_name, organization_name, organization_type, bio)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(username, email, password_hash, display_name, organization_name || null, organization_type || null, bio || null);

    const user = { id: result.lastInsertRowid, username, display_name, role: 'member' };
    const token = signToken({ id: user.id, role: user.role });
    return json(res, 201, { token, user });
  }

  if (urlPath === '/api/auth/login' && req.method === 'POST') {
    const body = await parseBody(req);
    const { email, password } = body;
    if (!email || !password) return json(res, 400, { error: 'E-mail et mot de passe requis.' });

    const row = await db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!row || !verifyPassword(password, row.password_hash)) {
      return json(res, 401, { error: 'Identifiants incorrects.' });
    }
    if (row.status === 'suspended') {
      return json(res, 403, { error: 'Ce compte a été suspendu.', code: 'SUSPENDED', reason: row.suspended_reason || null });
    }

    const token = signToken({ id: row.id, role: row.role });
    return json(res, 200, {
      token,
      must_change_password: !!row.must_change_password,
      user: {
        id: row.id, username: row.username, display_name: row.display_name,
        avatar: row.avatar, role: row.role,
      },
    });
  }

  if (urlPath === '/api/auth/change-password' && req.method === 'POST') {
    const user = requireAuth(req, res);
    if (!user) return;
    const body = await parseBody(req);
    const { current_password, new_password } = body;
    if (!new_password || new_password.length < 8) return json(res, 400, { error: 'Le nouveau mot de passe doit contenir au moins 8 caractères.' });

    const row = await db.prepare('SELECT password_hash, must_change_password FROM users WHERE id = ?').get(user.id);
    // Si le mot de passe a été réinitialisé par un admin (must_change_password=1),
    // on autorise le changement sans redemander l'ancien mot de passe temporaire imposé.
    if (!row.must_change_password) {
      if (!current_password || !verifyPassword(current_password, row.password_hash)) {
        return json(res, 401, { error: 'Mot de passe actuel incorrect.' });
      }
    }
    await db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
      .run(hashPassword(new_password), user.id);
    return json(res, 200, { success: true });
  }

  return null;
}

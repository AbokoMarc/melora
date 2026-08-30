import { db } from './db.js';
import { hashPassword } from './lib/auth.js';

export async function bootstrapSuperAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.warn('[melora] ADMIN_EMAIL/ADMIN_PASSWORD non définis — aucun super_admin créé automatiquement.');
    return;
  }

  const existing = await db.prepare('SELECT id, role FROM users WHERE email = ?').get(email);
  if (existing) {
    if (existing.role !== 'super_admin') {
      await db.prepare('UPDATE users SET role = ? WHERE id = ?').run('super_admin', existing.id);
      console.log(`[melora] ${email} promu super_admin.`);
    }
    return;
  }

  await db.prepare(`
    INSERT INTO users (username, email, password_hash, display_name, role, status)
    VALUES (?, ?, ?, ?, 'super_admin', 'active')
  `).run('admin', email, hashPassword(password), 'Administration');
  console.log(`[melora] super_admin initial créé : ${email}`);
}

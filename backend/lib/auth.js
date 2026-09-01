import crypto from 'node:crypto';
import { db } from '../db.js';

const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  throw new Error('JWT_SECRET manquant dans .env — démarrage refusé pour des raisons de sécurité.');
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString();
}

export function signToken(payload, expiresInSec = 60 * 60 * 24 * 365) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = { ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + expiresInSec };
  const h = base64url(JSON.stringify(header));
  const b = base64url(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', SECRET).update(`${h}.${b}`).digest('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${h}.${b}.${sig}`;
}

export function verifyToken(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, b, sig] = parts;
  const expected = crypto.createHmac('sha256', SECRET).update(`${h}.${b}`).digest('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  if (sig !== expected) return null;
  try {
    const payload = JSON.parse(base64urlDecode(b));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}

export function getAuthUser(req) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return verifyToken(auth.slice(7));
}

export function requireAuth(req, res) {
  const user = getAuthUser(req);
  if (!user) {
    res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Non authentifié.' }));
    return null;
  }
  return user;
}

// Revérifie en base à chaque requête sensible que le compte n'a pas été suspendu depuis
// l'émission du token (un JWT suspendu ne doit pas continuer à fonctionner jusqu'à expiration).
export async function requireActiveUser(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  const row = await db.prepare('SELECT id, role, status FROM users WHERE id = ?').get(user.id);
  if (!row || row.status === 'suspended') {
    res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Compte suspendu.', code: 'SUSPENDED' }));
    return null;
  }
  return { ...user, role: row.role };
}

export async function requireAdmin(req, res) {
  const user = await requireActiveUser(req, res);
  if (!user) return null;
  if (user.role !== 'admin' && user.role !== 'super_admin') {
    res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Accès réservé aux administrateurs.' }));
    return null;
  }
  return user;
}

export async function requireSuperAdmin(req, res) {
  const user = await requireActiveUser(req, res);
  if (!user) return null;
  if (user.role !== 'super_admin') {
    res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Accès réservé au super administrateur.' }));
    return null;
  }
  return user;
}

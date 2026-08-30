import './env.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { db } from './db.js';
import { getAuthUser } from './lib/auth.js';
import { sseHandler } from './lib/sse.js';
import { bootstrapSuperAdmin } from './bootstrap.js';

import { handleAuth } from './routes/auth.js';
import { handleUsers } from './routes/users.js';
import { handleConversations } from './routes/conversations.js';
import { handleMessages } from './routes/messages.js';
import { handleAdmin } from './routes/admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4000;
const FRONTEND_DIR = process.env.FRONTEND_DIR || path.join(__dirname, '..', 'frontend');

await bootstrapSuperAdmin();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res, urlPath) {
  let filePath = urlPath === '/' ? '/index.html' : urlPath;
  filePath = path.join(FRONTEND_DIR, filePath);
  if (!filePath.startsWith(FRONTEND_DIR)) { res.writeHead(403); return res.end(); }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (!path.extname(filePath)) {
        return fs.readFile(filePath + '.html', (err2, data2) => {
          if (err2) { res.writeHead(404); return res.end('Page introuvable'); }
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end(data2);
        });
      }
      res.writeHead(404); return res.end('Fichier introuvable');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const urlPath = urlObj.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  if (urlPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // Flux temps réel — EventSource ne permet pas d'en-têtes custom, le token passe en query string.
  if (urlPath === '/api/stream' && req.method === 'GET') {
    const token = urlObj.searchParams.get('token');
    const fakeReq = { headers: { authorization: `Bearer ${token}` } };
    const user = getAuthUser(fakeReq);
    if (!user) { res.writeHead(401); return res.end(); }
    return sseHandler(req, res, user);
  }

  if (!urlPath.startsWith('/api/')) {
    return serveStatic(req, res, urlPath);
  }

  try {
    const handlers = [handleAuth, handleUsers, handleConversations, handleMessages, handleAdmin];
    for (const handler of handlers) {
      const result = await handler(req, res, urlPath, urlObj);
      if (result !== null && result !== undefined) return;
      if (res.writableEnded || res.headersSent) return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Route API introuvable.' }));
  } catch (err) {
    console.error('Erreur serveur:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Erreur interne du serveur.' }));
    }
  }
});

server.listen(PORT, () => {
  console.log(`[melora] backend démarré sur http://localhost:${PORT}`);
});

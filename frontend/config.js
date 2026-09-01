// Frontend (Vercel) et backend (Render) sont sur deux origines différentes une fois déployés
// séparément — contrairement au dev local où le backend sert aussi le frontend (server.js).
// C'est le SEUL fichier à modifier après le déploiement : remplace par l'URL Render réelle.
//
// En local (node server.js sert tout depuis http://localhost:4000), on laisse vide :
// une chaîne vide dans les templates `${API_BASE}/api/...` donne des chemins relatifs,
// qui pointent alors correctement vers le même serveur qui a servi la page.
window.MELORA_API_BASE = ''; // ex: 'https://melora-backend.onrender.com' une fois déployé

# Melora 

Messagerie professionnelle temps réel. Node.js natif (aucun framework, aucun bundler),
Turso (SQLite hébergé), SSE pour le temps réel, WebRTC natif pour les appels.

## Ce qui est livré

- **Auth** : inscription, connexion, changement de mot de passe, hashing scrypt
- **4 onglets, comme WhatsApp** : Discussions / Statuts / Appels / Paramètres (rail à gauche sur desktop, barre en bas sur mobile)
- **Discussions** : privées + groupes, filtre Tous/Non lus, recherche pour démarrer une conversation, double coche sent→delivered→read, notes vocales, hors-ligne (IndexedDB + file d'attente)
- **Statuts 24h** : texte avec couleur de fond au choix, vues comptabilisées, expiration automatique (filtrée côté requête)
- **Appels audio/vidéo** : WebRTC natif, journal complet (tous / manqués) rejouable depuis l'onglet Appels, rappel en un tap
- **Paramètres** : modifier nom/bio, **thème clair/sombre** (clair = fond crème + accents bleu léger), déconnexion, accès admin si applicable
- **Responsive réel** : un seul panneau visible à la fois sur mobile (navigation par onglets + bouton retour), disposition à 3 colonnes sur desktop — plus l'ancien layout figé non adapté
- **PWA installable et offline-first** : IndexedDB, file d'attente hors-ligne, notifications push (VAPID) + badge, installation Android/iOS/desktop (bandeau adapté à chaque plateforme)
- **Administration complète** : suspendre/réactiver, réinitialiser un mot de passe, consulter les messages (journalisé), rôles, journal d'audit

## Corrigé dans cette passe

- **CORS manquant sur les réponses d'erreur** (401/403/404/500) dans `lib/auth.js` et `server.js` — invisible en local (même origine), bloquant une fois Render et Vercel sur deux domaines différents. Toutes les réponses ont maintenant l'en-tête.
- **`message.read` jamais écouté côté client** — la coche bleue ne se mettait à jour qu'au rechargement. Ajouté, avec une fonction de rafraîchissement séparée de `/read` pour éviter un ping-pong infini entre deux onglets ouverts sur la même conversation.
- **Redirection bloquée dans le service worker** (`sw.js`) — cause du fameux `ERR_FAILED` / "a redirected response was used for a request whose redirect mode is not follow".
- **Écran de conversation vide sans explication** — ajout d'un état vide explicite ("Aucun message pour l'instant") au lieu d'un blanc silencieux qui donnait l'impression que l'app était cassée.
- **Comparaisons d'identifiants fragilisées** (`sender_id === me.id`) — passées en `Number(...)` des deux côtés par précaution, au cas où le driver Turso renverrait un entier sous une forme différente selon le contexte.

## Pas encore fait - to be done

- Statuts image/vidéo (texte seulement pour l'instant)
- Appels en groupe (uniquement 1-à-1)
- Upload d'avatar (le profil se modifie en texte pour l'instant)

## Choix délibérés (et pourquoi)

- Pas de React/Vite, pas d'Express : vanilla JS servi tel quel, `http` natif
- Pas de lib `idb`, pas de `simple-peer` : pas de bundler dans ce projet, dépendances natives à la place
- Pas de Cloudinary/S3 : notes vocales en base64 dans Turso, plafonnées à 30s
- SSE plutôt que WebSocket : aucun avantage réel sur un process unique / free tier

## ⚠️ Limite de cet environnement

Pas d'accès réseau dans ce sandbox (`npm install` impossible) : uniquement vérifié à la
syntaxe (`node --check`, tous fichiers) + cohérence endpoints client/serveur + équilibre
des balises HTML. **Teste réellement en local avant de redéployer.**

## Installation locale

```bash
cd backend
npm install
cp .env.example .env
# éditer .env : JWT_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD, TURSO_DATABASE_URL, TURSO_AUTH_TOKEN
# optionnel : npx web-push generate-vapid-keys -> VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
node server.js
```

`frontend/config.js` doit rester `window.MELORA_API_BASE = ''` en local.

## Déploiement Render + Vercel + Turso

Voir les échanges précédents pour le pas-à-pas détaillé (dashboards, pas de CLI nécessaire).
Rappels :
- Render : Root Directory `backend`, Build `npm install`, Start `npm start`, Health Check `/health`
- Vercel : Root Directory `frontend`, aucune build command
- Après déploiement : éditer `frontend/config.js` avec l'URL Render, désactiver **Vercel Authentication**
  (Settings → Deployment Protection) sinon le SSO de Vercel bloque tout
- Après toute mise à jour de `sw.js` : F12 → Application → Service Workers → **Unregister**,
  puis **Clear site data**, avant de retester — sinon l'ancienne version reste active

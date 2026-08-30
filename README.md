# Melora

Messagerie professionnelle temps réel. Node.js natif (aucun framework, aucun bundler),
Turso (SQLite hébergé), SSE pour le temps réel, WebRTC natif pour les appels.

## Ce qui est livré

- **Auth** : inscription, connexion, changement de mot de passe, hashing scrypt
- **Conversations privées + groupes**, création, liste avec dernier message, compteur de non-lus
- **Messages temps réel** : idempotents (`client_message_id`), pagination cursor, diffusion SSE
- **Double coche** sent → delivered (SSE reçu) → read (lu à l'écran)
- **Indicateur « écrit... »** éphémère, **présence** en mémoire (en ligne / dernière connexion)
- **Notes vocales** : `MediaRecorder` → base64 → Turso (30s max — pas de S3/Cloudinary, cf. choix ci-dessous)
- **Appels audio/vidéo** : WebRTC natif (`RTCPeerConnection`), signaling relayé sur le canal SSE existant + routes `/api/calls/*`. STUN public Google par défaut, TURN optionnel (ex: metered.ca)
- **PWA installable et offline-first** :
  - IndexedDB (mini-wrapper maison, `assets/js/idb-lite.js`) : conversations et messages lus instantanément depuis le cache local, synchronisés en tâche de fond
  - File d'attente hors-ligne : message envoyé sans réseau → statut "pending" (🕓), rejoué automatiquement au retour de connexion, sans doublon
  - Notifications push (VAPID) + badge d'icône (`setAppBadge`/`clearAppBadge`) + clic sur notif → ouvre directement la bonne conversation
- **Administration complète** : suspendre/réactiver, réinitialiser un mot de passe, consulter les messages de n'importe quelle conversation (journalisé), gérer les rôles, journal d'audit (super_admin)

## Pas encore fait

- **Statuts 24h** (texte/image/vidéo, vues, réactions) — prochaine phase
- Groupes : appels non supportés pour l'instant (uniquement conversations privées)

## Choix délibérés (et pourquoi)

- **Pas de React/Vite, pas d'Express** : vanilla JS servi tel quel, `http` natif — pas de build, pas de dépendance à auditer en plus, cohérent avec Roomia
- **Pas de lib `idb`** : ce projet n'a pas de bundler, une dépendance npm ne serait pas chargeable côté navigateur sans étape de build → mini-wrapper IndexedDB maison à la place
- **Pas de `simple-peer`** : l'API `RTCPeerConnection` native suffit, une dépendance de moins
- **Pas de Cloudinary/S3** : notes vocales en base64 dans Turso, plafonnées à 30s — à revoir si le volume augmente sérieusement
- **SSE plutôt que WebSocket** : sur un process unique / free tier, WebSocket n'apporte aucun avantage réel ici et coûte plus de code à maintenir en solo

## ⚠️ Limite de cet environnement

Pas d'accès réseau dans ce sandbox (`npm install` impossible), donc **je n'ai pu que vérifier
la syntaxe** (`node --check` sur tous les fichiers, tous OK) — pas de vrai test d'exécution.
**Teste réellement en local avant de déployer.**

## Installation locale (tout-en-un, comme avant)

\`\`\`bash
cd backend
npm install
cp .env.example .env
# éditer .env : JWT_SECRET (openssl rand -hex 32), ADMIN_EMAIL, ADMIN_PASSWORD
# optionnel : npm run vapid:generate -> VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (sinon push désactivé, le reste marche)
node server.js
\`\`\`

Ouvre `http://localhost:4000`. `frontend/config.js` doit rester `window.MELORA_API_BASE = ''`
en local (chemins relatifs = même serveur).

À tester dans l'ordre :
1. Deux comptes, deux onglets → discuter en temps réel
2. Couper le réseau (DevTools → Network → Offline) en plein envoi → vérifier aucun doublon au retour
3. Fermer complètement l'onglet, envoyer un message depuis l'autre compte → vérifier la notification push + le badge
4. Lancer un appel audio puis vidéo entre les deux onglets (accepter l'accès micro/caméra)
5. Admin → suspendre l'autre compte → vérifier déconnexion immédiate + journal d'audit

## Déploiement séparé : Render (backend) + Vercel (frontend) + Turso (DB)

1. **Turso** : créer une base sur [turso.tech](https://turso.tech), récupérer `TURSO_DATABASE_URL` et `TURSO_AUTH_TOKEN`
2. **Render** (backend) : New → Blueprint → `render.yaml` → renseigner `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` (optionnel), `TURN_URL`/`TURN_USERNAME`/`TURN_CREDENTIAL` (optionnel) — `JWT_SECRET` est généré automatiquement. Noter l'URL Render obtenue (ex: `https://melora.onrender.com`)
3. **Vercel** (frontend) : importer le repo, définir le **Root Directory du projet Vercel sur `frontend/`** (aucun build command — fichiers statiques servis tels quels, `vercel.json` déjà présent dedans)
4. Éditer `frontend/config.js` avec l'URL Render obtenue à l'étape 2, commit + push (Vercel redéploie automatiquement)

Rappel : Render free tier se met en veille après ~15 min d'inactivité (réveil 30-50s, coupe les
connexions SSE en cours) — c'est pour ça que les notifications push sont indispensables : elles
ne dépendent pas de cette connexion et passent même service en veille.

# Melora — Phase 1

Messagerie professionnelle. Même philosophie que Roomia : Node.js natif (aucun framework),
Turso (SQLite hébergé, gratuit, persistant), SSE pour le temps réel, déployable sur Render free tier.

## Ce qui est livré dans cette phase

- **Auth** : inscription, connexion, changement de mot de passe, hashing scrypt (jamais en clair)
- **Conversations privées + groupes**, création, liste avec dernier message et compteur de non-lus
- **Messages temps réel** : envoi idempotent (`client_message_id` — un retry réseau ne duplique jamais), pagination cursor, diffusion instantanée via SSE
- **Accusés de lecture**, indicateur **« écrit... »** éphémère (jamais persisté)
- **Présence en mémoire** (en ligne / dernière connexion), sans solliciter la base à chaque heartbeat
- **Administration complète** :
  - suspendre / réactiver un utilisateur (coupe sa connexion temps réel immédiatement)
  - réinitialiser le mot de passe de quelqu'un (« mot de passe oublié » côté admin) — mot de passe temporaire affiché une seule fois, changement forcé à la reconnexion
  - consulter les messages de **n'importe quelle** conversation (anti-fraude) — **chaque consultation est journalisée**
  - gérer les rôles (`member` / `admin` / `super_admin`) — seul le super_admin peut promouvoir/rétrograder ou toucher à un autre admin
  - **journal d'audit** consultable uniquement par le super_admin : qui a fait quoi, quand
- **PWA installable** : manifest + service worker (cache du shell app), icônes générées. Le prompt d'installation est géré nativement par le navigateur ; `app.html`/`login.html` sont enregistrés comme shell offline
- Squelette **push notifications** (service worker prêt à recevoir des push) — le déclenchement serveur (VAPID) est prévu pour la phase suivante, pas encore branché

## Pas encore fait (phases suivantes, volontairement pas dans ce livrable)

- Envoi effectif des **push notifications** (génération des clés VAPID, endpoint d'abonnement, déclenchement à l'envoi d'un message)
- **Statuts 24h** (texte/image/vidéo, vues, réactions) — schéma pas encore ajouté, pour ne pas alourdir cette phase avec des tables inutilisées
- Upload de médias (images/vidéos/documents/vocal) — nécessite un choix de stockage compatible free tier
- Interface admin plus riche (recherche/filtre, pagination du journal)

## ⚠️ Limite de cet environnement

Je n'ai pas d'accès réseau ici pour lancer `npm install` (le sandbox est isolé), donc je n'ai **pas pu démarrer le serveur ni exécuter de vraie requête**. J'ai uniquement vérifié la syntaxe de chaque fichier (`node --check`, tous OK). **Teste réellement en local avant de déployer** — voir ci-dessous.

## Installation locale

```bash
cd backend
npm install
cp .env.example .env
# éditer .env : JWT_SECRET (openssl rand -hex 32), ADMIN_EMAIL, ADMIN_PASSWORD
node server.js
```

Ouvre `http://localhost:4000` → `login.html`. Connecte-toi avec `ADMIN_EMAIL`/`ADMIN_PASSWORD` : ce compte est automatiquement super_admin.

À tester dans l'ordre :
1. Créer un 2e compte (navigateur privé) → vérifier que les deux se retrouvent via la recherche et peuvent discuter en temps réel (deux onglets côte à côte)
2. Couper le réseau côté client en plein envoi → revenir → vérifier qu'aucun message n'est dupliqué (idempotence)
3. Depuis le compte admin → suspendre le 2e compte → vérifier qu'il est déconnecté instantanément et ne peut plus se reconnecter
4. Réinitialiser son mot de passe → se reconnecter avec le mot de passe temporaire → vérifier que le changement est exigé
5. Consulter ses messages depuis le panneau admin → vérifier l'entrée dans le journal d'audit

## Déploiement (identique à Roomia)

1. Créer une base sur [turso.tech](https://turso.tech), récupérer `TURSO_DATABASE_URL` et `TURSO_AUTH_TOKEN`
2. Push sur GitHub
3. Render → New → Blueprint (utilise `render.yaml`) → renseigner `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` (`JWT_SECRET` est généré automatiquement)

Rappel de la limite du free tier vue plus haut : après une veille (~15 min d'inactivité), le premier réveil prend 30-50s et coupe les connexions SSE en cours — c'est pour ça que les push notifications (phase suivante) sont indispensables pour ne pas rater un message pendant ce délai.

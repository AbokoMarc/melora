# Melora

Melora est une application de messagerie professionnelle en temps réel, pensée pour les échanges privés, les groupes et les communications audio/vidéo.

Le projet utilise principalement les API natives de Node.js et du navigateur, avec une architecture volontairement légère.

## Fonctionnalités

### Authentification

* Inscription et connexion
* Hashage des mots de passe avec `scrypt`
* Changement de mot de passe
* Authentification par JWT
* Gestion des rôles
* Suspension et réactivation des comptes

### Discussions

* Conversations privées
* Conversations de groupe
* Recherche d'utilisateurs pour démarrer une discussion
* Recherche et filtrage des conversations
* Filtre Tous / Non lus
* Statut des messages :

  * Envoyé
  * Distribué
  * Lu
* Mise à jour en temps réel
* Notes vocales
* Gestion des messages hors connexion
* File d'attente des messages lorsque la connexion est indisponible

### Statuts

Les utilisateurs peuvent publier des statuts visibles pendant 24 heures.

* Statut texte
* Choix de la couleur de fond
* Comptabilisation des vues
* Expiration automatique après 24 heures
* Les statuts expirés ne sont plus retournés par les requêtes

### Appels

Les appels utilisent WebRTC directement dans le navigateur.

* Appels audio
* Appels vidéo
* Appels 1-à-1
* Historique des appels
* Appels manqués
* Rappel depuis l'historique

Les appels de groupe ne sont pas encore disponibles.

### Paramètres

* Modification du nom
* Modification de la bio
* Thème clair
* Thème sombre
* Déconnexion
* Accès à l'administration pour les comptes autorisés

### PWA / Mode hors connexion

Melora peut être installée comme une application sur les appareils compatibles.

* Service Worker
* IndexedDB
* Fonctionnement hors connexion
* File d'attente des actions
* Notifications push
* Badge de notification
* Installation sur Android, iOS et desktop
* Interface adaptée aux différentes tailles d'écran

## Administration

L'espace administrateur permet notamment de :

* Consulter les utilisateurs
* Modifier les rôles
* Suspendre un compte
* Réactiver un compte
* Réinitialiser un mot de passe
* Consulter les messages dans le cadre prévu par l'administration
* Consulter le journal d'audit

Les actions sensibles de l'administration sont journalisées.

## Architecture

Le projet ne repose pas sur React, Vue, Angular, Express ou Vite.

### Backend

* Node.js
* API HTTP native
* `http` natif
* SQLite via Turso
* JWT
* `scrypt`
* SSE pour les événements temps réel
* WebRTC pour les appels
* Web Push pour les notifications

### Frontend

* HTML
* CSS
* JavaScript vanilla
* IndexedDB
* Service Worker
* WebRTC
* EventSource / SSE

### Base de données

La base de données utilise SQLite hébergé avec Turso.

Les données principales sont stockées côté serveur :

* Utilisateurs
* Conversations
* Membres des groupes
* Messages
* Statuts
* Vues des statuts
* Appels
* Notifications
* Sessions et données nécessaires à l'application
* Journal d'audit

## Pourquoi ces choix ?

Le projet utilise volontairement les API natives plutôt qu'un ensemble important de dépendances.

### Node.js natif

Pas d'Express ou de framework backend.

L'objectif est de garder le serveur léger et de contrôler directement les routes, les réponses HTTP et les événements SSE.

### JavaScript vanilla

Pas de React, Vite ou autre bundler.

Le frontend est servi directement avec les fichiers HTML, CSS et JavaScript.

### SSE

SSE est utilisé pour les événements temps réel envoyés du serveur vers les clients.

Dans l'architecture actuelle, cela suffit pour les notifications et les mises à jour des conversations sans ajouter un serveur WebSocket séparé.

### WebRTC

Les appels audio et vidéo utilisent WebRTC directement dans le navigateur.

### IndexedDB

IndexedDB permet de conserver localement certaines données et de mettre en attente les actions effectuées lorsque l'utilisateur est hors connexion.

## Structure du projet

```text
melora/
│
├── backend/
│   ├── lib/
│   │   └── auth.js
│   ├── data/
│   ├── server.js
│   ├── package.json
│   └── .env.example
│
├── frontend/
│   ├── index.html
│   ├── config.js
│   ├── sw.js
│   ├── css/
│   ├── js/
│   └── ...
│
└── README.md
```

La structure exacte peut évoluer avec les prochaines versions.

## Installation

### Prérequis

* Node.js récent
* Un compte Turso
* Une base de données Turso
* Git

### Backend

```bash
cd backend
npm install
```

Créer ensuite le fichier `.env` à partir de `.env.example`.

```bash
cp .env.example .env
```

Configurer les variables nécessaires :

```env
JWT_SECRET=your_secret
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=your_password

TURSO_DATABASE_URL=your_turso_database_url
TURSO_AUTH_TOKEN=your_turso_auth_token
```

Pour les notifications push, les clés VAPID peuvent être générées avec :

```bash
npx web-push generate-vapid-keys
```

Puis ajouter les clés correspondantes dans `.env`.

### Lancer le serveur

```bash
npm start
```

ou, selon la configuration du projet :

```bash
node server.js
```

Le backend expose également :

```text
/health
```

pour vérifier que le serveur fonctionne correctement.

## Configuration du frontend

En développement local, `frontend/config.js` doit contenir :

```javascript
window.MELORA_API_BASE = '';
```

Lorsque le frontend et le backend sont déployés séparément, cette valeur doit pointer vers l'URL du backend.

Exemple :

```javascript
window.MELORA_API_BASE = 'https://votre-backend.onrender.com';
```

## Déploiement

Le déploiement prévu utilise :

* Vercel pour le frontend
* Render pour le backend
* Turso pour la base SQLite

### Render

Configuration recommandée :

```text
Root Directory: backend
Build Command: npm install
Start Command: npm start
Health Check Path: /health
```

Les variables d'environnement doivent être ajoutées directement dans les paramètres du service Render.

### Vercel

Configuration :

```text
Root Directory: frontend
Build Command: aucune
```

Le frontend étant composé de fichiers statiques, aucune étape de compilation n'est nécessaire.

Si Vercel Deployment Protection est activé, il faut désactiver l'authentification Vercel pour permettre au frontend public de communiquer normalement avec l'API.

## Service Worker

Le service worker est utilisé pour la partie PWA et le fonctionnement hors connexion.

Après une modification de `sw.js`, l'ancien service worker peut rester actif dans le navigateur.

Pour forcer la mise à jour :

1. Ouvrir les outils développeur avec `F12`
2. Aller dans `Application`
3. Ouvrir `Service Workers`
4. Cliquer sur `Unregister`
5. Effacer les données du site
6. Recharger l'application

## Sécurité

Quelques mesures mises en place :

* Mots de passe hashés avec `scrypt`
* JWT pour l'authentification
* Variables sensibles dans `.env`
* Contrôle des permissions côté serveur
* Gestion des rôles
* Journalisation des actions administratives
* Vérification des utilisateurs autorisés à accéder aux conversations et groupes
* CORS configuré pour les requêtes provenant du frontend

Les secrets et tokens ne doivent jamais être commités dans Git.

Le fichier `.env` doit rester local ou être configuré directement dans l'environnement de déploiement.

## Corrections récentes

Plusieurs problèmes rencontrés lors des tests ont été corrigés.

### CORS sur les erreurs HTTP

Les réponses `401`, `403`, `404` et `500` incluent désormais les en-têtes CORS nécessaires.

Cela évite notamment les erreurs difficiles à diagnostiquer lorsque le frontend Vercel et le backend Render utilisent deux domaines différents.

### Mise à jour des messages lus

L'événement `message.read` est maintenant traité côté client.

La coche du message peut donc passer à l'état lu sans attendre un rechargement de la page.

La logique de rafraîchissement est séparée de l'appel `/read` afin d'éviter une boucle entre plusieurs onglets ouverts sur la même conversation.

### Service Worker

La gestion des réponses redirigées dans `sw.js` a été corrigée afin d'éviter les erreurs liées aux réponses redirigées.

### Conversation vide

Lorsqu'une conversation ne contient encore aucun message, l'interface affiche maintenant un état vide explicite :

```text
Aucun message pour l'instant
```

### Identifiants Turso

Les comparaisons d'identifiants côté client ont été sécurisées en convertissant les valeurs avec `Number()` lorsque cela est nécessaire.

Cela évite les problèmes liés aux différences de type retournées par le driver de base de données.

## Fonctionnalités prévues

Les éléments suivants ne sont pas encore disponibles :

* Statuts avec images
* Statuts avec vidéos
* Appels de groupe
* Upload d'avatar

Ils pourront être ajoutés dans les prochaines versions.

## Tests

L'environnement utilisé pour la vérification ne permettait pas d'installer de nouvelles dépendances avec `npm install`.

Les vérifications effectuées portent donc principalement sur :

* La syntaxe JavaScript avec `node --check`
* La cohérence des endpoints
* La correspondance entre frontend et backend
* La structure HTML
* L'équilibre des balises
* La cohérence générale de l'architecture

Avant un nouveau déploiement, il est recommandé de tester l'application localement avec une vraie base Turso et de vérifier les fonctionnalités suivantes :

* Inscription
* Connexion
* Envoi de messages
* Réception en temps réel
* Messages lus
* Groupes
* Statuts
* Notifications
* Mode hors connexion
* Appels audio
* Appels vidéo
* Administration

## État du projet

Melora est actuellement fonctionnel sur les principales fonctionnalités prévues pour la messagerie 1-à-1 et les groupes.

Les prochaines évolutions concernent principalement les statuts multimédias, les appels de groupe et la gestion des avatars.

## Licence

Projet privé.

Tous les droits sur le code, la conception, l'architecture et les éléments propres à Melora sont réservés, sauf indication contraire dans les fichiers ou dépendances du projet.

// Mini-wrapper IndexedDB — juste ce qu'il faut pour l'offline-first de Melora.
// Pas la librairie 'idb' : ce projet n'a pas de bundler (vanilla JS servi tel quel),
// donc une dépendance npm ne serait même pas chargeable côté navigateur sans étape de build.
const DB_NAME = 'melora';
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('conversations')) {
        db.createObjectStore('conversations', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('messages')) {
        const store = db.createObjectStore('messages', { keyPath: 'local_id', autoIncrement: true });
        store.createIndex('by_conversation', 'conversation_id');
        store.createIndex('by_client_message_id', 'client_message_id', { unique: true });
      }
      if (!db.objectStoreNames.contains('pending')) {
        db.createObjectStore('pending', { keyPath: 'client_message_id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const result = fn(store);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
  });
}

// Reste un script classique (pas de "type=module") : app.html s'appuie sur des attributs
// onclick="..." globaux, donc pas de scope module ici — on expose juste un objet global.
window.idbLite = {
  async saveConversations(list) {
    return tx('conversations', 'readwrite', (store) => {
      list.forEach(c => store.put(c));
    });
  },
  async getConversations() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction('conversations').objectStore('conversations').getAll();
      req.onsuccess = () => resolve(req.result.sort((a, b) => (b.last_message_at || '').localeCompare(a.last_message_at || '')));
      req.onerror = () => reject(req.error);
    });
  },

  // Fusionne par client_message_id pour ne jamais dupliquer un message rejoué depuis le serveur.
  async saveMessages(conversationId, messages) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction('messages', 'readwrite');
      const store = t.objectStore('messages');
      const idx = store.index('by_client_message_id');
      messages.forEach(m => {
        const getReq = idx.get(m.client_message_id);
        getReq.onsuccess = () => {
          const existing = getReq.result;
          store.put({ ...m, conversation_id: conversationId, local_id: existing?.local_id });
        };
      });
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  },
  async getMessages(conversationId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction('messages').objectStore('messages').index('by_conversation').getAll(conversationId);
      req.onsuccess = () => resolve(req.result.sort((a, b) => a.id - b.id));
      req.onerror = () => reject(req.error);
    });
  },

  async queuePending(message) {
    return tx('pending', 'readwrite', (store) => store.put(message));
  },
  async getPending() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction('pending').objectStore('pending').getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async removePending(clientMessageId) {
    return tx('pending', 'readwrite', (store) => store.delete(clientMessageId));
  },
};

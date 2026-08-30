// Installation PWA universelle. Trois cas très différents à gérer :
//
// 1. Android (Chrome, Edge, Samsung Internet) + Chrome/Edge desktop : l'événement
//    "beforeinstallprompt" existe, on peut déclencher le prompt natif par bouton.
// 2. iOS Safari (iPhone/iPad) : AUCUNE API d'installation programmatique n'existe.
//    Apple n'expose pas "beforeinstallprompt". La seule voie est manuelle : bouton
//    Partager -> "Sur l'écran d'accueil". On ne peut que guider, pas déclencher.
// 3. Firefox desktop, navigateurs in-app (Instagram/Facebook) : pas d'installation
//    fiable possible -> pas de bandeau, inutile de promettre ce qu'on ne peut pas tenir.
(function () {
  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }
  if (isStandalone()) return; // déjà installée, rien à faire

  const ua = navigator.userAgent;
  const isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = /^((?!chrome|android|crios|fxios|edgios).)*safari/i.test(ua);
  const isInAppBrowser = /FBAN|FBAV|Instagram|Line\//i.test(ua); // ces navigateurs ne peuvent pas installer de PWA du tout

  function injectBanner(html, onShow) {
    const el = document.createElement('div');
    el.id = 'installBanner';
    el.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:70;' +
      'background:#17171b;border:1px solid #2a2a30;border-radius:12px;padding:14px 16px;' +
      'display:flex;align-items:center;gap:12px;box-shadow:0 8px 24px rgba(0,0,0,.4);' +
      'font-family:-apple-system,"Segoe UI",Roboto,sans-serif;color:#e8e6e1;font-size:.85rem;';
    el.innerHTML = html;
    document.body.appendChild(el);
    onShow?.(el);
  }

  if (isInAppBrowser) return; // rien de fiable à proposer ici

  if (isIOS && isSafari) {
    let deferredUntil = localStorage.getItem('melora_install_dismissed_ios');
    if (deferredUntil && Date.now() < Number(deferredUntil)) return; // redemande dans 7 jours max
    injectBanner(`
      <span style="font-size:1.4rem;">📲</span>
      <span style="flex:1;">Installe Melora : appuie sur <strong>Partager</strong>
        <svg width="14" height="14" viewBox="0 0 24 24" style="vertical-align:-2px" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v13m0-13 4 4m-4-4-4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>
        puis <strong>Sur l'écran d'accueil</strong>.</span>
      <button id="dismissInstallBanner" style="background:none;border:none;color:#8b8a92;font-size:1.1rem;cursor:pointer;padding:0 4px;">✕</button>
    `, (el) => {
      el.querySelector('#dismissInstallBanner').onclick = () => {
        el.remove();
        localStorage.setItem('melora_install_dismissed_ios', String(Date.now() + 7 * 86400000));
      };
    });
    return;
  }

  // Android / Chrome / Edge / Samsung Internet / Chrome desktop
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    injectBanner(`
      <span style="font-size:1.4rem;">📲</span>
      <span style="flex:1;">Installe Melora pour l'ouvrir en un tap, même hors ligne.</span>
      <button id="doInstall" style="background:#d9822b;color:#111;border:none;border-radius:8px;padding:8px 14px;font-weight:600;cursor:pointer;">Installer</button>
      <button id="dismissInstallBanner" style="background:none;border:none;color:#8b8a92;font-size:1.1rem;cursor:pointer;padding:0 4px;">✕</button>
    `, (el) => {
      el.querySelector('#doInstall').onclick = async () => {
        el.remove();
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        await deferredPrompt.userChoice;
        deferredPrompt = null;
      };
      el.querySelector('#dismissInstallBanner').onclick = () => el.remove();
    });
  });
  window.addEventListener('appinstalled', () => {
    document.getElementById('installBanner')?.remove();
  });
})();

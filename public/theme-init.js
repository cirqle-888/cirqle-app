(function(){
  try {
    var saved = localStorage.getItem('cirqle.theme');
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var theme = saved === 'light' || saved === 'dark' ? saved : (prefersDark ? 'dark' : 'light');
    var root = document.documentElement;
    if (theme === 'dark') root.classList.add('dark');
    else root.classList.remove('dark');
    root.style.colorScheme = theme;
  } catch (e) { /* localStorage blocked — fall back to CSS default */ }

  // Native app only: show the opening cover from the very first paint, once
  // per app session (sessionStorage dies with the app's WebView, so a reload or
  // a hard navigation inside the same session does not show it again).
  // globals.css draws it; src/lib/mobile/intro-cover.ts takes it down.
  try {
    var cap = window.Capacitor;
    if (cap && cap.isNativePlatform && cap.isNativePlatform() && !sessionStorage.getItem('cirqle.cover')) {
      sessionStorage.setItem('cirqle.cover', '1');
      document.documentElement.setAttribute('data-intro-cover', 'show');
    }
  } catch (e) { /* no cover — the app simply opens */ }
})();

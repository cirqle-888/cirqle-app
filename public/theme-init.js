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

  // Inside the phone app, say which one (android / ios) before first paint, so
  // the stylesheet can leave out effects that platform's WebView is slow at.
  try {
    var cap = window.Capacitor;
    if (cap && cap.isNativePlatform && cap.isNativePlatform()) {
      document.documentElement.setAttribute('data-native', (cap.getPlatform && cap.getPlatform()) || 'native');
    }
  } catch (e) { /* not the phone app */ }
})();

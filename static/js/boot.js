// Applies the saved theme and language before the page is drawn (no flash). Classic script.
try {
  const s = JSON.parse(localStorage.getItem('ketabyar.prefs') || '{}');
  const th = s.theme === 'auto' || !s.theme ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : s.theme;
  document.documentElement.dataset.theme = th;
  if (s.lang === 'fa') { document.documentElement.lang = 'fa'; document.documentElement.dir = 'rtl'; }
} catch (e) {}

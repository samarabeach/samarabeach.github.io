// Auto / Light / Dark switch, remembered in this browser.
// The <head> sets data-theme before paint; this wires the buttons.
(() => {
  const root = document.documentElement;
  const KEY = 'site-mode';
  const MODES = ['auto', 'light', 'dark'];
  const read = () => { try { return localStorage.getItem(KEY); } catch (e) { return null; } };
  const save = (v) => { try { localStorage.setItem(KEY, v); } catch (e) { /* private window: just don't remember */ } };
  const osDark = window.matchMedia('(prefers-color-scheme: dark)');

  function apply(mode) {
    mode = MODES.includes(mode) ? mode : 'auto';
    root.dataset.mode = mode;
    if (mode === 'auto') delete root.dataset.theme; else root.dataset.theme = mode;
    document.querySelectorAll('.mode button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    // charts read colors when drawn, so let them redraw
    window.dispatchEvent(new CustomEvent('themechange'));
  }

  document.querySelectorAll('.mode button').forEach((b) => b.addEventListener('click', () => { save(b.dataset.mode); apply(b.dataset.mode); }));
  osDark.addEventListener('change', () => { if (root.dataset.mode === 'auto') apply('auto'); });
  apply(read());
})();

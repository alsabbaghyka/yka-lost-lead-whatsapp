/* Runs in <head> so the page never flashes the wrong theme. Light unless the viewer picked another. */
(function () { var t = 'light'; try { t = localStorage.getItem('theme') || 'light'; } catch (e) { /* storage blocked */ } if (t !== 'auto') document.documentElement.setAttribute('data-theme', t); })();

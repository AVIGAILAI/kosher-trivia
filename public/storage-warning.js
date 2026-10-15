// אזהרה בולטת כשהשמירה זמנית בלבד (מאגר הנתונים Redis לא מחובר).
// בלי זה אפשר להעלות שאלות/רשימות שנראות שמורות — ונמחקות באתחול הבא של השרת.
(function () {
  let bar = null;
  function show() {
    if (bar) return;
    bar = document.createElement('div');
    bar.setAttribute('dir', 'rtl');
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#dc2626;color:#fff;' +
      'font:700 15px Rubik,sans-serif;padding:10px 16px;text-align:center;box-shadow:0 2px 10px rgba(0,0,0,.3)';
    bar.textContent = '⚠️ שימי לב: מאגר הנתונים לא מחובר כרגע — כל מה שתעלי או תשני עכשיו (שאלות, רשימות) נשמר זמנית בלבד ועלול להימחק. מומלץ לא להעלות קבצים עד שההודעה הזו נעלמת.';
    document.body.appendChild(bar);
    document.body.style.paddingTop = (bar.offsetHeight + 8) + 'px';
  }
  function hide() {
    if (!bar) return;
    bar.remove(); bar = null;
    document.body.style.paddingTop = '';
  }
  async function check() {
    try {
      const s = await (await fetch('/api/storage-status', { cache: 'no-store' })).json();
      if (s.mode === 'offline') show(); else hide();
    } catch (e) { /* השרת לא זמין רגעית — לא משנים */ }
  }
  check();
  setInterval(check, 60000);
})();

// עיצוב משותף לכל המסכים: צבע רקע או תמונת רקע, לוגו ושם בית הספר.
// נשמר בשרת (Redis), כך שכל שינוי מופיע בכל המסכים — מסך המנחה, החדרים, פאנל המנהלת, הלוח והשלט.
// דף שרוצה כפתור "🎨 עיצוב" מוסיף אלמנט עם data-theme-open.
(function () {
  const PALETTES = [
    { id: 'purple',   name: 'סגול (מקורי)', c: ['#7e3f9d', '#5a2c7d', '#391c55'] },
    { id: 'blue',     name: 'כחול',        c: ['#2563eb', '#1e40af', '#172554'] },
    { id: 'sky',      name: 'תכלת',        c: ['#0ea5e9', '#0284c7', '#0c4a6e'] },
    { id: 'teal',     name: 'טורקיז',      c: ['#0d9488', '#0f766e', '#134e4a'] },
    { id: 'green',    name: 'ירוק',        c: ['#16a34a', '#15803d', '#14532d'] },
    { id: 'bordeaux', name: 'בורדו',       c: ['#be123c', '#9f1239', '#4c0519'] },
    { id: 'pink',     name: 'ורוד',        c: ['#db2777', '#be185d', '#831843'] },
    { id: 'orange',   name: 'כתום',        c: ['#ea580c', '#c2410c', '#7c2d12'] },
    { id: 'gold',     name: 'זהב',         c: ['#ca8a04', '#854d0e', '#422006'] },
    { id: 'night',    name: 'כהה',         c: ['#334155', '#1e293b', '#0f172a'] },
  ];
  const DEFAULT_NAME = 'בנות לאה';
  const CACHE_KEY = 'triviaTheme';
  const gradient = (p) => `linear-gradient(135deg,${p.c[0]} 0%,${p.c[1]} 50%,${p.c[2]} 100%)`;
  const paletteById = (id) => PALETTES.find((p) => p.id === id) || PALETTES[0];

  let theme = null;
  let shownName = DEFAULT_NAME; // השם שמופיע כרגע בכותרת הדף (להחלפה)

  // --- החלה ---
  let styleEl = null;
  const bgUrl = (t) => '/api/bg?v=' + (t.bgVersion || 0);
  // רקע: תמונה מותאמת (palette='image') עם הכהיה קלה לקריאוּת הכיתוב, אחרת מעבר צבעים
  function backgroundCss(t) {
    if (t.palette === 'image' && t.hasBg) {
      const dim = t.bgDim === false ? '' : 'linear-gradient(rgba(0,0,0,.35),rgba(0,0,0,.35)),';
      return `background:${dim}url('${bgUrl(t)}') center/cover no-repeat fixed !important;`;
    }
    return `background:${gradient(paletteById(t.palette))} !important;`;
  }
  function applyBackground(t) {
    if (!styleEl) { styleEl = document.createElement('style'); styleEl.id = 'theme-style'; document.head.appendChild(styleEl); }
    styleEl.textContent = `body{${backgroundCss(t)}}`;
  }
  function applyAll(t) {
    applyBackground(t);
    if (!document.body) return;
    document.querySelectorAll('img[data-logo]').forEach((img) => {
      const src = '/api/logo?v=' + (t.logoVersion || 0);
      if (img.getAttribute('src') !== src) img.setAttribute('src', src);
      img.alt = t.schoolName || DEFAULT_NAME;
    });
    const name = t.schoolName || DEFAULT_NAME;
    document.querySelectorAll('[data-school-name]').forEach((el) => { el.textContent = name; });
    if (name !== shownName && document.title.includes(shownName)) document.title = document.title.split(shownName).join(name);
    shownName = name;
  }

  // צבע מהזיכרון המקומי מיד (בלי הבהוב של הסגול לפני שהשרת עונה)
  try { const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); if (c && c.palette) { theme = c; applyBackground(c); } } catch (e) {}

  function setTheme(t) {
    theme = t;
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(t)); } catch (e) {}
    applyAll(t);
  }
  async function refresh() {
    try {
      const t = await (await fetch('/api/theme', { cache: 'no-store' })).json();
      if (!theme || JSON.stringify(t) !== JSON.stringify(theme) || document.readyState !== 'complete') setTheme(t);
    } catch (e) { /* השרת לא זמין רגעית */ }
  }
  async function post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'שגיאה בשמירה');
    return data;
  }

  // --- עיבוד לוגו בדפדפן: הקטנה, הסרת רקע לבן, צביעה בלבן ---
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('לא הצלחתי לפתוח את התמונה')); };
      img.src = url;
    });
  }
  function processLogo(img, { removeWhite, makeWhite }, maxSide) {
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale));
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    if (removeWhite || makeWhite) {
      const d = ctx.getImageData(0, 0, w, h), px = d.data;
      for (let i = 0; i < px.length; i += 4) {
        if (removeWhite) {
          const lo = Math.min(px[i], px[i + 1], px[i + 2]);
          if (lo >= 235) px[i + 3] = 0;                                         // לבן → שקוף
          else if (lo > 205) px[i + 3] = Math.round(px[i + 3] * (235 - lo) / 30); // קצה רך
        }
        if (makeWhite) { px[i] = px[i + 1] = px[i + 2] = 255; }               // צורה נשארת, הצבע לבן
      }
      ctx.putImageData(d, 0, 0);
    }
    return cv.toDataURL('image/png');
  }
  // תמונת רקע: הקטנה ל-1920 פיקסלים ודחיסת JPEG עד שנכנסת במגבלת השמירה
  async function buildBgDataUrl(file) {
    const img = await loadImage(file);
    for (const [side, q] of [[1920, 0.82], [1600, 0.78], [1280, 0.72], [1024, 0.65]]) {
      const scale = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(img.naturalWidth * scale)); cv.height = Math.max(1, Math.round(img.naturalHeight * scale));
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      const jpg = cv.toDataURL('image/jpeg', q);
      if (jpg.length < 850000) return jpg;
    }
    throw new Error('התמונה גדולה מדי — נסי קובץ קטן יותר');
  }
  async function buildLogoDataUrl(file, opts) {
    const img = await loadImage(file);
    for (const side of [512, 384, 256]) {
      const png = processLogo(img, opts, side); // PNG — שומר על שקיפות
      if (png.length < 700000) return png;
    }
    throw new Error('התמונה גדולה מדי — נסי קובץ קטן יותר');
  }

  // --- חלון העיצוב ---
  let modal = null, lastFile = null;
  function el(html) { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; }
  function openEditor() {
    if (modal) { modal.remove(); modal = null; }
    const t = theme || { palette: 'purple', schoolName: DEFAULT_NAME, logoVersion: 0 };
    modal = el(`
      <div dir="rtl" style="font-family:Rubik,sans-serif" class="fixed inset-0 bg-black/60 z-[99998] flex items-start justify-center p-4 overflow-auto">
        <div class="bg-white text-slate-800 rounded-3xl p-6 max-w-xl w-full my-6 shadow-2xl">
          <div class="flex justify-between items-center mb-1">
            <h2 class="text-2xl font-black">🎨 עיצוב המשחק</h2>
            <button data-x class="text-slate-400 hover:text-slate-700 text-3xl leading-none">✕</button>
          </div>
          <p class="text-sm text-slate-500 mb-5">השינוי נשמר ומופיע בכל המסכים (מסך המנחה, החדרים, פאנל המנהלת והשלט) — מסכים פתוחים יתעדכנו תוך חצי דקה.</p>

          <h3 class="font-black mb-2">צבע הרקע</h3>
          <div data-swatches class="grid grid-cols-5 gap-2 mb-4"></div>

          <h3 class="font-black mb-2">תמונת רקע מותאמת</h3>
          <div class="flex flex-wrap items-center gap-2 mb-2 text-sm">
            <label class="cursor-pointer bg-purple-600 hover:bg-purple-700 text-white font-black px-4 py-2 rounded-xl text-center">
              🖼️ העלאת תמונת רקע<input data-bg-file type="file" accept="image/*" class="hidden" />
            </label>
            <button data-bg-remove class="bg-slate-100 hover:bg-slate-200 font-bold px-4 py-2 rounded-xl">🗑️ הסרת התמונה (חזרה לצבע)</button>
          </div>
          <label class="flex items-center gap-2 text-sm font-semibold mb-1"><input data-bg-dim type="checkbox" class="w-4 h-4" /> להכהות קצת את התמונה, כדי שהכיתוב הלבן יהיה קריא</label>
          <p class="text-xs text-slate-500 mb-6">💡 מומלצת תמונה רחבה (לרוחב), כמו תמונה של בית הספר. היא תכסה את כל המסך.</p>

          <h3 class="font-black mb-2">הלוגו</h3>
          <div class="flex items-center gap-4 mb-3">
            <div data-preview class="w-28 h-28 rounded-2xl flex items-center justify-center p-2 shrink-0">
              <img data-logo-preview class="max-w-full max-h-full object-contain" alt="" />
            </div>
            <div class="flex flex-col gap-2 text-sm">
              <label class="cursor-pointer bg-purple-600 hover:bg-purple-700 text-white font-black px-4 py-2 rounded-xl text-center">
                📤 העלאת לוגו חדש<input data-file type="file" accept="image/*" class="hidden" />
              </label>
              <button data-reset-logo class="bg-slate-100 hover:bg-slate-200 font-bold px-4 py-2 rounded-xl">↩️ חזרה ללוגו המקורי</button>
            </div>
          </div>
          <label class="flex items-center gap-2 text-sm font-semibold mb-1"><input data-opt-remove type="checkbox" class="w-4 h-4" /> להסיר רקע לבן מהלוגו</label>
          <label class="flex items-center gap-2 text-sm font-semibold mb-1"><input data-opt-white type="checkbox" class="w-4 h-4" /> לצבוע את הלוגו בלבן (כמו הלוגו המקורי)</label>
          <p class="text-xs text-slate-500 mb-6">💡 הכי יפה: לוגו עם רקע שקוף (PNG). אם יש לו רקע לבן — סמני "להסיר רקע לבן" לפני ההעלאה.</p>
          <p data-msg class="hidden text-sm font-bold mb-4"></p>

          <h3 class="font-black mb-2">שם בית הספר</h3>
          <div class="flex gap-2 mb-2">
            <input data-name type="text" maxlength="60" class="flex-1 border-2 border-slate-200 rounded-xl px-3 py-2 font-bold focus:border-purple-400 outline-none" />
            <button data-save-name class="bg-purple-600 hover:bg-purple-700 text-white font-black px-4 py-2 rounded-xl">שמירה</button>
          </div>
          <p class="text-xs text-slate-500">מופיע בכותרת מסך המנחה ובשם הלשוניות.</p>
        </div>
      </div>`);
    document.body.appendChild(modal);
    const $ = (sel) => modal.querySelector(sel);
    const msg = (text, ok) => { const m = $('[data-msg]'); m.textContent = text; m.className = 'text-sm font-bold mb-4 ' + (ok ? 'text-emerald-600' : 'text-rose-600'); };

    function paintPreview() {
      const cur = theme || t;
      if (cur.palette === 'image' && cur.hasBg) {
        $('[data-preview]').style.background = `url('${bgUrl(cur)}') center/cover`;
      } else {
        $('[data-preview]').style.background = gradient(paletteById(cur.palette));
      }
      $('[data-logo-preview]').src = '/api/logo?v=' + ((theme && theme.logoVersion) || 0);
    }
    function paintSwatches() {
      const th = theme || t, cur = th.palette;
      const tile = (id, name, bg) => `
        <button data-pal="${id}" class="flex flex-col items-center gap-1 text-xs font-bold">
          <span class="block w-full h-12 rounded-xl ${id === cur ? 'ring-4 ring-offset-2 ring-slate-800' : ''}" style="background:${bg}"></span>
          ${name}
        </button>`;
      $('[data-swatches]').innerHTML = PALETTES.map((p) => tile(p.id, p.name, gradient(p))).join('') +
        (th.hasBg ? tile('image', 'התמונה שלי', `url('${bgUrl(th)}') center/cover`) : '');
      modal.querySelectorAll('[data-pal]').forEach((b) => {
        b.onclick = async () => {
          const id = b.dataset.pal;
          applyBackground({ ...(theme || t), palette: id });
          try { setTheme(await post('/api/theme', { palette: id })); } catch (e) { msg(e.message, false); }
          paintSwatches(); paintPreview();
        };
      });
    }
    async function uploadFile(file) {
      if (!file) return;
      lastFile = file;
      msg('מעלה את הלוגו…', true);
      try {
        const dataUrl = await buildLogoDataUrl(file, { removeWhite: $('[data-opt-remove]').checked, makeWhite: $('[data-opt-white]').checked });
        setTheme(await post('/api/theme/logo', { dataUrl }));
        paintPreview();
        msg('✓ הלוגו הוחלף בכל המסכים', true);
      } catch (e) { msg(e.message, false); }
    }

    async function uploadBg(file) {
      if (!file) return;
      msg('מעלה את תמונת הרקע…', true);
      try {
        setTheme(await post('/api/theme/bg', { dataUrl: await buildBgDataUrl(file) }));
        paintSwatches(); paintPreview();
        msg('✓ תמונת הרקע הוחלפה בכל המסכים', true);
      } catch (e) { msg(e.message, false); }
    }

    paintSwatches(); paintPreview();
    $('[data-bg-dim]').checked = !(theme && theme.bgDim === false);
    $('[data-bg-file]').onchange = (e) => uploadBg(e.target.files[0]);
    $('[data-bg-remove]').onclick = async () => {
      try { setTheme(await post('/api/theme/bg', { dataUrl: null })); paintSwatches(); paintPreview(); msg('✓ התמונה הוסרה — חזרנו לצבע', true); }
      catch (e) { msg(e.message, false); }
    };
    $('[data-bg-dim]').onchange = async (e) => {
      try { setTheme(await post('/api/theme', { bgDim: e.target.checked })); } catch (err) { msg(err.message, false); }
    };
    $('[data-name]').value = (theme && theme.schoolName) || DEFAULT_NAME;
    $('[data-x]').onclick = () => { modal.remove(); modal = null; };
    modal.onclick = (e) => { if (e.target === modal) { modal.remove(); modal = null; } };
    $('[data-file]').onchange = (e) => uploadFile(e.target.files[0]);
    // שינוי אפשרות אחרי העלאה — מעבדים מחדש את אותו קובץ
    $('[data-opt-remove]').onchange = $('[data-opt-white]').onchange = () => { if (lastFile) uploadFile(lastFile); };
    $('[data-reset-logo]').onclick = async () => {
      try { setTheme(await post('/api/theme/logo', { dataUrl: null })); lastFile = null; paintPreview(); msg('✓ חזרנו ללוגו המקורי', true); }
      catch (e) { msg(e.message, false); }
    };
    $('[data-save-name]').onclick = async () => {
      try { setTheme(await post('/api/theme', { schoolName: $('[data-name]').value })); msg('✓ השם נשמר', true); }
      catch (e) { msg(e.message, false); }
    };
  }

  window.TriviaTheme = {
    open: openEditor,
    schoolName: () => (theme && theme.schoolName) || DEFAULT_NAME,
  };

  function onReady() {
    if (theme) applyAll(theme);
    document.querySelectorAll('[data-theme-open]').forEach((b) => b.addEventListener('click', openEditor));
    refresh();
    setInterval(refresh, 30000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady); else onReady();
})();

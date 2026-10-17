// הצגת מדיה של שאלה (תמונה / סרטון / הקלטה) — משותף למסך המנחה, לשלט ולעורך.
// תומך בקובץ שהועלה לשרת (/api/media/...), בקישור ישיר, ובקישורי גוגל דרייב / יוטיוב
// (שמומרים אוטומטית לנגן שעובד — קישור "שיתוף" רגיל של דרייב לא נפתח בתוך <video>).
(function () {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** מזהה את מקור הקישור: { kind: 'youtube'|'drive'|'file', id?, url } */
  function parse(url) {
    url = String(url || '').trim();
    let m = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/.exec(url);
    if (m) return { kind: 'youtube', id: m[1], url };
    m = /drive\.google\.com\/(?:file\/d\/|open\?(?:.*&)?id=|uc\?(?:.*&)?id=|thumbnail\?(?:.*&)?id=)([\w-]{20,})/.exec(url)
      || /docs\.google\.com\/(?:file\/d\/)([\w-]{20,})/.exec(url);
    if (m) return { kind: 'drive', id: m[1], url };
    return { kind: 'file', url };
  }

  /**
   * HTML לתצוגת המדיה.
   * size: 'host' (גדול, למקרן) | 'player' (מסך המשתתפת) | 'preview' (קטן, בעורך)
   * muted: להשתיק סרטון (במסך המשתתפת — כדי שלא ירעישו כל הטלפונים יחד)
   */
  function html(media, { size = 'host', muted = false } = {}) {
    if (!media || !media.url) return '';
    const src = parse(media.url);
    const H = size === 'host' ? 'max-height:18rem' : size === 'player' ? 'max-height:14rem' : 'max-height:8rem';
    const frameH = size === 'host' ? 300 : size === 'player' ? 220 : 140;
    const frameW = size === 'host' ? 'width:min(34rem,100%)' : 'width:100%';
    const iframe = (u) => `<iframe src="${esc(u)}" style="${frameW};height:${frameH}px;border:0;border-radius:1rem;box-shadow:0 10px 20px rgba(0,0,0,.15)" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe>`;

    if (src.kind === 'youtube') {
      return iframe(`https://www.youtube-nocookie.com/embed/${src.id}?autoplay=${size === 'preview' ? 0 : 1}&rel=0&playsinline=1${muted ? '&mute=1' : ''}`);
    }
    if (src.kind === 'drive') {
      if (media.type === 'image') {
        return `<img src="https://drive.google.com/thumbnail?id=${esc(src.id)}&sz=w1600" style="${H}" class="rounded-2xl shadow-lg object-contain mx-auto" alt="" referrerpolicy="no-referrer" />`;
      }
      return iframe(`https://drive.google.com/file/d/${src.id}/preview`);
    }
    const u = esc(src.url);
    if (media.type === 'video') {
      return `<video src="${u}" style="${H}" class="rounded-2xl shadow-lg mx-auto max-w-full" controls ${size === 'preview' ? '' : 'autoplay'} ${muted ? 'muted' : ''} playsinline></video>`;
    }
    if (media.type === 'audio') {
      return `<div class="bg-purple-50 rounded-2xl p-4 shadow inline-block"><div class="text-3xl mb-1">🎧</div><audio src="${u}" controls ${size === 'preview' ? '' : 'autoplay'} style="width:${size === 'host' ? '18rem' : '100%'}"></audio></div>`;
    }
    return `<img src="${u}" style="${H}" class="rounded-2xl shadow-lg object-contain mx-auto max-w-full" alt="" />`;
  }

  /** האם המדיה משמיעה קול (סרטון/הקלטה) — אז לא מנגנים את מנגינת המתח מעליה. */
  function hasSound(media) { return !!(media && media.url && (media.type === 'video' || media.type === 'audio')); }

  window.TriviaMedia = { parse, html, hasSound };
})();

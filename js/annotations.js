/**
 * annotations.js
 *
 * 条文へのマーカー・メモ（条文ページの content script）。保存は annotation_store.js が受け持つ。
 * - 語句を選ぶと、すぐ上に帯（黄・緑・桃のマーカー、「メモ」「この項にメモ」）を出す
 * - 色は CSS Custom Highlight API（CSS.highlights）で付ける。本文の DOM を一切変えないので、
 *   算用数字化・括弧の薄字化・接続詞・定義語の下線と取り合わない
 * - 付けた所は「条・項・号の要素ID＋選んだ語句＋前後の数文字」で覚え、本文が書き換わるたびに探し直す。
 *   漢数字と算用数字の違い・空白は、比べる前にそろえる（「第七十七条」も「第７７条」も「第77条」として比べる）
 * - 項・号そのものへのメモは、番号の横に付箋の印を置く
 * 設定「マーカー・メモ」（marker）でオン・オフする。オフにしても保存したものは消えない。
 */

window.egovExt = window.egovExt || {};

(function(ext) {

  /** 色の番号 → 名前（読み上げ用） */
  const COLOR_NAMES = { 1: '黄色', 2: '緑', 3: '桃色' };

  /** 本文の文字として数えない要素（拡張が足したボタンや吹き出し） */
  const SKIP_TEXT_SELECTOR = '.egov-ext-backref-btn, .egov-ext-citation-btn, .egov-ext-note-flag, .egov-ext-tip, button';

  /** 漢数字の並び */
  const KANJI_NUMERAL_RE = /[〇一二三四五六七八九十百千万]/;

  /** いま表示している法令のマーカー・メモ */
  let currentLawId = null;
  let annotations = [];
  /** 色を付けた範囲（ID → Range）。押した所がどのマーカーかを調べるのに使う */
  const rangesById = new Map();
  /** 本文の中で見つからなかったもの（ID → 'missing'（条・項・号が今の表示に無い）| 'changed'（語句が見つからない）） */
  const orphans = new Map();
  let enabled = false;
  let listenersBound = false;
  let renderToken = 0;

  // ---------------------------------------------------------------------------
  // 本文の文字と、比べるための形
  // ---------------------------------------------------------------------------

  /**
   * 要素の中の本文の文字（テキストノード）を順に集める
   * @param {Element} root
   * @returns {{segs: Array<{node: Text, start: number, end: number}>, raw: string}}
   */
  function collectSegments(root) {
    const segs = [];
    let pos = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || parent.closest(SKIP_TEXT_SELECTOR)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let node;
    const parts = [];
    while ((node = walker.nextNode())) {
      const len = node.nodeValue.length;
      segs.push({ node, start: pos, end: pos + len });
      parts.push(node.nodeValue);
      pos += len;
    }
    return { segs, raw: parts.join('') };
  }

  /**
   * 比べるための形にそろえる（空白を除き、漢数字・全角数字を半角の算用数字に）。
   * そろえた後の1文字ごとに、元の文字列のどこからどこまでに当たるかも返す
   * @param {string} raw
   * @returns {{norm: string, rawStart: number[], rawEnd: number[]}}
   */
  function normalizeWithMap(raw) {
    const out = [];
    const rawStart = [];
    const rawEnd = [];
    let i = 0;
    while (i < raw.length) {
      const ch = raw[i];
      if (/\s/.test(ch)) { i++; continue; }
      if (KANJI_NUMERAL_RE.test(ch)) {
        let j = i;
        while (j < raw.length && KANJI_NUMERAL_RE.test(raw[j])) j++;
        const run = raw.slice(i, j);
        const converted = ext.kanjiToArabic ? String(ext.kanjiToArabic(run)) : run;
        const text = /^\d+$/.test(converted) ? converted : run;
        for (const c of text) { out.push(c); rawStart.push(i); rawEnd.push(j); }
        i = j;
        continue;
      }
      const code = ch.charCodeAt(0);
      out.push(code >= 0xFF10 && code <= 0xFF19 ? String.fromCharCode(code - 0xFEE0) : ch);
      rawStart.push(i);
      rawEnd.push(i + 1);
      i++;
    }
    return { norm: out.join(''), rawStart, rawEnd };
  }

  function normalize(text) {
    return normalizeWithMap(text || '').norm;
  }
  ext.normalizeAnnotationText = normalize;

  /**
   * DOM の位置（ノード＋オフセット）を、collectSegments の文字列の位置に直す
   * @returns {number}
   */
  function rawOffsetOf(segs, rawLength, container, offset) {
    if (container.nodeType === Node.TEXT_NODE) {
      const seg = segs.find(s => s.node === container);
      if (seg) return seg.start + Math.min(offset, seg.end - seg.start);
    }
    const point = document.createRange();
    point.setStart(container, offset);
    for (const seg of segs) {
      if (point.comparePoint(seg.node, 0) >= 0) return seg.start;
    }
    return rawLength;
  }

  /**
   * collectSegments の文字列の位置を、DOM の位置に直す
   * @param {boolean} isEnd - 範囲の終わりとして求める
   */
  function domPointAt(segs, index, isEnd) {
    for (const seg of segs) {
      if (isEnd ? (index > seg.start && index <= seg.end) : (index >= seg.start && index < seg.end)) {
        return { node: seg.node, offset: index - seg.start };
      }
    }
    return null;
  }

  /** a の末尾と b の先頭（tail=true なら a の先頭と b の末尾）がどれだけ重なるか */
  function overlapScore(stored, actual, fromEnd) {
    if (!stored || !actual) return 0;
    let n = 0;
    while (n < stored.length && n < actual.length) {
      const s = fromEnd ? stored[stored.length - 1 - n] : stored[n];
      const a = fromEnd ? actual[actual.length - 1 - n] : actual[n];
      if (s !== a) break;
      n++;
    }
    return n / stored.length;
  }

  /**
   * 覚えておいた語句を、条・項・号の要素の中で探し、Range を返す
   * @param {Object} ann
   * @param {Element} el
   * @returns {Range|null}
   */
  ext.findAnnotationRange = function(ann, el) {
    const { segs, raw } = collectSegments(el);
    const map = normalizeWithMap(raw);
    const q = normalize(ann.q);
    if (!q) return null;
    const positions = [];
    let from = 0;
    let idx;
    while ((idx = map.norm.indexOf(q, from)) !== -1 && positions.length < 100) {
      positions.push(idx);
      from = idx + 1;
    }
    if (positions.length === 0) return null;

    const b = normalize(ann.b);
    const f = normalize(ann.f);
    let best = positions[0];
    let bestScore = -Infinity;
    positions.forEach(pos => {
      const before = map.norm.slice(Math.max(0, pos - b.length), pos);
      const after = map.norm.slice(pos + q.length, pos + q.length + f.length);
      const score = overlapScore(b, before, true) + overlapScore(f, after, false) - Math.abs(pos - (ann.o || 0)) / 100000;
      if (score > bestScore) { bestScore = score; best = pos; }
    });

    const start = domPointAt(segs, map.rawStart[best], false);
    const end = domPointAt(segs, map.rawEnd[best + q.length - 1], true);
    if (!start || !end) return null;
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  };

  // ---------------------------------------------------------------------------
  // 色付けと付箋
  // ---------------------------------------------------------------------------

  function highlightName(ann) {
    return `egov-mk-${ann.c || 1}${ann.m ? '-m' : ''}`;
  }

  function clearHighlights() {
    if (typeof CSS === 'undefined' || !CSS.highlights) return;
    [1, 2, 3].forEach(c => {
      CSS.highlights.delete(`egov-mk-${c}`);
      CSS.highlights.delete(`egov-mk-${c}-m`);
    });
  }

  function withObserverPaused(fn) {
    const wasObserving = !!ext.globalDOMObserver;
    if (wasObserving) ext.globalDOMObserver.disconnect();
    try {
      fn();
    } finally {
      if (wasObserving && ext.reconnectDOMObserver) ext.reconnectDOMObserver();
    }
  }

  function removeFlags() {
    document.querySelectorAll('.egov-ext-note-flag').forEach(el => el.remove());
  }

  const NOTE_SVG = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" focusable="false">'
    + '<path d="M4 4h16v11l-5 5H4z"/><path d="M15 20v-5h5"/><path d="M8 9h8M8 13h5"/></svg>';

  /**
   * 項・号へのメモの付箋を、番号の横（参照元の「↩」があればその後ろ）に置く
   * @param {Element} provisionEl
   * @param {Object} ann
   */
  function addFlag(provisionEl, ann) {
    const label = ext.numberLabelOf ? ext.numberLabelOf(provisionEl) : null;
    if (!label || !label.parentNode) return false;
    const flag = document.createElement('button');
    flag.type = 'button';
    flag.className = 'egov-ext-note-flag';
    flag.dataset.annotationId = ann.id;
    const excerpt = (ann.m || '').replace(/\s+/g, ' ').slice(0, 80);
    flag.title = excerpt ? `メモ: ${excerpt}${ann.m.length > 80 ? '…' : ''}` : 'メモ（まだ何も書いていません）';
    flag.setAttribute('aria-label', `${ann.l || ''}へのメモを開く`);
    flag.innerHTML = NOTE_SVG;
    let anchor = label;
    while (anchor.nextSibling && anchor.nextSibling.nodeType === Node.ELEMENT_NODE
           && anchor.nextSibling.classList.contains('egov-ext-backref-btn')) {
      anchor = anchor.nextSibling;
    }
    label.parentNode.insertBefore(flag, anchor.nextSibling);
    return true;
  }

  /**
   * いまの法令のマーカー・メモを本文に描く（何度呼んでも同じ結果になる）
   */
  function render() {
    rangesById.clear();
    orphans.clear();
    clearHighlights();
    withObserverPaused(removeFlags);
    if (!enabled) return;

    const supportsHighlight = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';
    const groups = new Map();
    const flags = [];
    annotations.forEach(ann => {
      const el = document.getElementById(ann.p) || (ext.resolveTargetElement ? ext.resolveTargetElement(ann.p) : null);
      if (!el) { orphans.set(ann.id, 'missing'); return; }
      if (ann.k === 'provision') { flags.push([el, ann]); return; }
      const range = ext.findAnnotationRange(ann, el);
      if (!range) { orphans.set(ann.id, 'changed'); return; }
      rangesById.set(ann.id, range);
      const name = highlightName(ann);
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(range);
    });
    if (supportsHighlight) {
      groups.forEach((ranges, name) => CSS.highlights.set(name, new Highlight(...ranges)));
    }
    withObserverPaused(() => {
      flags.forEach(([el, ann]) => { if (!addFlag(el, ann)) orphans.set(ann.id, 'missing'); });
    });
  }

  /**
   * 本文を書き換える処理（算用数字化など。大きな法令では数十秒かかる）が終わったら描き直す
   */
  function renderAfterTextTasks() {
    const token = ++renderToken;
    render();
    if (!ext.waitForTasks || !ext.activeTasks) return;
    // 書き換えは本文の差し替えなので、その前に付けた色の範囲は消える。終わるのを待って描き直す。
    // 大きな法令では 60 秒で待ちきれないことがあるので、まだ動いていれば待ち直す（5 回まで）
    const textTasksRunning = () => Object.keys(ext.activeTasks)
      .some(n => n !== 'definitionExtract' && ext.activeTasks[n] && ext.activeTasks[n].done);
    const waitAndRender = (round) => {
      const names = Object.keys(ext.activeTasks).filter(n => n !== 'definitionExtract');
      ext.waitForTasks(names, 60000).then(() => {
        if (token !== renderToken || !enabled) return;
        render();
        rememberCurrentLaw();
        if (round < 5 && textTasksRunning()) waitAndRender(round + 1);
      });
    };
    waitAndRender(1);
  }

  // ---------------------------------------------------------------------------
  // 選んだときの帯
  // ---------------------------------------------------------------------------

  let toolbar = null;
  let toolbarMessageTimer = null;
  /** 帯を出したときの選択の中身 */
  let pendingSelection = null;

  /**
   * 選んでいる範囲が、マーカーを付けられる所か調べる
   * @returns {{provisionEl: Element, raw: string, start: number, end: number, rect: DOMRect}|null}
   */
  function describeSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const container = ext.getLawContainer ? ext.getLawContainer() : document.body;
    const common = range.commonAncestorContainer;
    const ancestor = common.nodeType === Node.ELEMENT_NODE ? common : common.parentElement;
    if (!ancestor || !container.contains(ancestor)) return null;
    if (ancestor.closest('.egov-ext-tip, .egov-ext-mk-card, .egov-ext-mk-toolbar, input, textarea, ' + (ext.SIDEBAR_SELECTOR || '.toc'))) return null;
    const provisionEl = ext.closestProvision ? ext.closestProvision(ancestor) : null;
    if (!provisionEl) return null;

    const { segs, raw } = collectSegments(provisionEl);
    let start = rawOffsetOf(segs, raw.length, range.startContainer, range.startOffset);
    let end = rawOffsetOf(segs, raw.length, range.endContainer, range.endOffset);
    while (start < end && /\s/.test(raw[start])) start++;
    while (end > start && /\s/.test(raw[end - 1])) end--;
    if (end <= start) return null;
    const rects = range.getClientRects();
    const rect = rects.length ? rects[0] : range.getBoundingClientRect();
    return { provisionEl, raw, start, end, rect };
  }

  /** 条・項・号の種類に合わせた呼び方（「この項にメモ」など） */
  function provisionNoun(el) {
    const id = el.id || '';
    if (/(?:^|[-_])It_\d+(?:_\d+)*$/.test(id)) return '号';
    if (/(?:^|[-_])Si\d*_\d+(?:_\d+)*$/.test(id)) return '号';
    if (/(?:^|[-_])Pr_1$/.test(id)) return '条';
    if (/(?:^|[-_])Pr_\d+(?:_\d+)*$/.test(id)) return '項';
    return '条';
  }

  function provisionLabel(el) {
    return (ext.formatPathFromObjectId && ext.formatPathFromObjectId(el.id)) || el.id;
  }

  function ensureToolbar() {
    if (toolbar && document.body.contains(toolbar)) return toolbar;
    toolbar = document.createElement('div');
    toolbar.className = 'egov-ext-mk-toolbar';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', 'マーカー・メモ');
    [1, 2, 3].forEach(c => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `egov-ext-mk-color egov-ext-mk-color-${c}`;
      btn.dataset.color = String(c);
      btn.title = `${COLOR_NAMES[c]}のマーカーを引く`;
      btn.setAttribute('aria-label', `${COLOR_NAMES[c]}のマーカーを引く`);
      toolbar.appendChild(btn);
    });
    const sep = document.createElement('span');
    sep.className = 'egov-ext-mk-sep';
    toolbar.appendChild(sep);
    const memo = document.createElement('button');
    memo.type = 'button';
    memo.className = 'egov-ext-mk-action';
    memo.dataset.action = 'memo';
    memo.textContent = 'メモ';
    memo.title = '選んだ語句にマーカーを引いて、メモを書く';
    toolbar.appendChild(memo);
    const prov = document.createElement('button');
    prov.type = 'button';
    prov.className = 'egov-ext-mk-action';
    prov.dataset.action = 'provision';
    toolbar.appendChild(prov);
    const msg = document.createElement('span');
    msg.className = 'egov-ext-mk-msg';
    msg.setAttribute('role', 'status');
    toolbar.appendChild(msg);

    // 帯を押しても選択が外れないようにする
    toolbar.addEventListener('mousedown', e => e.preventDefault());
    toolbar.addEventListener('click', onToolbarClick);
    toolbar.hidden = true;
    document.body.appendChild(toolbar);
    return toolbar;
  }

  function showToolbar(info) {
    const bar = ensureToolbar();
    pendingSelection = info;
    const noun = provisionNoun(info.provisionEl);
    const provBtn = bar.querySelector('[data-action="provision"]');
    provBtn.textContent = `この${noun}にメモ`;
    provBtn.title = `${provisionLabel(info.provisionEl)}そのものにメモを書く（付箋の印が番号の横に付きます）`;
    bar.querySelector('.egov-ext-mk-msg').textContent = '';
    bar.hidden = false;
    const width = bar.offsetWidth || 260;
    const top = info.rect.top - bar.offsetHeight - 8;
    const left = Math.min(Math.max(8, info.rect.left), window.innerWidth - width - 8);
    bar.style.setProperty('top', `${top < 8 ? info.rect.bottom + 8 : top}px`, 'important');
    bar.style.setProperty('left', `${left}px`, 'important');
  }

  function hideToolbar() {
    if (toolbar) toolbar.hidden = true;
    pendingSelection = null;
  }

  function showToolbarMessage(text) {
    if (!toolbar) return;
    const msg = toolbar.querySelector('.egov-ext-mk-msg');
    msg.textContent = text;
    clearTimeout(toolbarMessageTimer);
    toolbarMessageTimer = setTimeout(() => { msg.textContent = ''; }, 6000);
  }

  /**
   * 選んだ範囲から、保存する形を作る
   */
  function annotationFromSelection(info, color) {
    const { raw, start, end, provisionEl } = info;
    return {
      id: ext.newAnnotationId(),
      k: 'text',
      p: provisionEl.id,
      l: provisionLabel(provisionEl),
      q: raw.slice(start, end),
      b: raw.slice(Math.max(0, start - 10), start),
      f: raw.slice(end, end + 10),
      o: normalize(raw.slice(0, start)).length,
      c: color,
      m: ''
    };
  }

  async function onToolbarClick(e) {
    const btn = e.target.closest('button');
    if (!btn || !pendingSelection) return;
    const info = pendingSelection;
    if (btn.dataset.color) {
      const ann = annotationFromSelection(info, Number(btn.dataset.color));
      const result = await addAnnotation(ann);
      if (!result.ok) { showToolbarMessage(ext.describeAnnotationError(result)); return; }
      window.getSelection().removeAllRanges();
      hideToolbar();
    } else if (btn.dataset.action === 'memo') {
      const ann = annotationFromSelection(info, 1);
      const result = await addAnnotation(ann);
      if (!result.ok) { showToolbarMessage(ext.describeAnnotationError(result)); return; }
      window.getSelection().removeAllRanges();
      hideToolbar();
      openCard(ann, info.rect, { focusMemo: true });
    } else if (btn.dataset.action === 'provision') {
      const existing = annotations.find(a => a.k === 'provision' && a.p === info.provisionEl.id);
      window.getSelection().removeAllRanges();
      hideToolbar();
      if (existing) { openCard(existing, info.rect, { focusMemo: true }); return; }
      const ann = { id: ext.newAnnotationId(), k: 'provision', p: info.provisionEl.id, l: provisionLabel(info.provisionEl), q: '', c: 1, m: '' };
      // 項・号へのメモは、何か書いたときに保存する（空のまま閉じたら残さない）
      openCard(ann, info.rect, { focusMemo: true, unsaved: true });
    }
  }

  /**
   * いまの法令の名前を覚えておく（全法令のマーカー・メモの一覧で法令名を出すため）。
   * 見出しがまだ描かれていなければ、タブの題名から取る
   */
  function rememberCurrentLaw() {
    if (!currentLawId || !annotations.length || !ext.rememberLawTitle || !ext.readCurrentLawInfo) return;
    const info = ext.readCurrentLawInfo();
    if (info && info.title) ext.rememberLawTitle(currentLawId, info.title, info.lawNum);
  }

  /** 保存して、すぐ描き直す（保存を待つ間に消えないよう、手元の一覧にも先に入れる） */
  async function addAnnotation(ann) {
    const result = await ext.saveAnnotation(currentLawId, ann);
    if (result.ok) {
      annotations = annotations.filter(a => a.id !== ann.id).concat([ann]);
      rememberCurrentLaw();
      render();
    }
    return result;
  }

  function onSelectionEnd(e) {
    if (!enabled) return;
    if (e && e.target && e.target.closest && e.target.closest('.egov-ext-mk-toolbar, .egov-ext-mk-card')) return;
    setTimeout(() => {
      const info = describeSelection();
      if (info) showToolbar(info);
      else hideToolbar();
    }, 0);
  }

  // ---------------------------------------------------------------------------
  // メモの札
  // ---------------------------------------------------------------------------

  let card = null;
  let cardSaveTimer = null;

  function closeCard() {
    if (!card) return;
    const c = card;
    card = null;
    if (c._flush) c._flush();
    c.remove();
  }

  /**
   * マーカー・メモの札を開く（メモの書き直し・色の変更・削除）
   * @param {Object} ann
   * @param {DOMRect} rect - 札を出す位置の目安
   * @param {{focusMemo?: boolean, unsaved?: boolean}} [opts]
   */
  async function openCard(ann, rect, opts) {
    closeCard();
    const options = opts || {};
    let unsaved = !!options.unsaved;
    const mode = await ext.getAnnotationMode();
    const max = ext.ANNOTATION_MEMO_MAX[mode];

    const el = document.createElement('div');
    el.className = 'egov-ext-mk-card';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', `${ann.l || ''}${ann.k === 'provision' ? 'へのメモ' : 'のマーカー'}`);

    const head = document.createElement('div');
    head.className = 'egov-ext-mk-card-head';
    const title = document.createElement('span');
    title.className = 'egov-ext-mk-card-title';
    title.textContent = `${ann.l || ''}${ann.k === 'provision' ? 'へのメモ' : 'のマーカー'}`;
    head.appendChild(title);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'egov-ext-mk-card-close';
    close.setAttribute('aria-label', '閉じる');
    close.textContent = '×';
    close.addEventListener('click', closeCard);
    head.appendChild(close);
    el.appendChild(head);

    if (ann.k !== 'provision') {
      const quote = document.createElement('div');
      quote.className = 'egov-ext-mk-card-quote';
      quote.textContent = `「${ann.q.length > 60 ? ann.q.slice(0, 60) + '…' : ann.q}」`;
      el.appendChild(quote);

      const colors = document.createElement('div');
      colors.className = 'egov-ext-mk-card-colors';
      [1, 2, 3].forEach(c => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `egov-ext-mk-color egov-ext-mk-color-${c}`;
        b.setAttribute('aria-label', `${COLOR_NAMES[c]}にする`);
        b.setAttribute('aria-pressed', ann.c === c ? 'true' : 'false');
        b.addEventListener('click', async () => {
          ann.c = c;
          colors.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
          await persist();
        });
        colors.appendChild(b);
      });
      el.appendChild(colors);
    }

    const textarea = document.createElement('textarea');
    textarea.className = 'egov-ext-mk-card-memo';
    textarea.value = ann.m || '';
    textarea.maxLength = max;
    textarea.rows = 4;
    textarea.placeholder = mode === 'sync'
      ? `メモ（${max}字まで。ブラウザの同期で他の端末にも出ます）`
      : `メモ（${max}字まで。この端末の中だけに保存します）`;
    el.appendChild(textarea);

    const foot = document.createElement('div');
    foot.className = 'egov-ext-mk-card-foot';
    const msg = document.createElement('span');
    msg.className = 'egov-ext-mk-card-msg';
    msg.setAttribute('role', 'status');
    foot.appendChild(msg);
    const count = document.createElement('span');
    count.className = 'egov-ext-mk-card-count';
    foot.appendChild(count);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'egov-ext-mk-card-delete';
    del.textContent = '削除';
    del.title = ann.k === 'provision' ? 'このメモを消す' : 'このマーカーとメモを消す';
    del.addEventListener('click', async () => {
      if (!unsaved) await ext.removeAnnotation(currentLawId, ann.id);
      annotations = annotations.filter(a => a.id !== ann.id);
      unsaved = true; // 閉じるときに保存し直さない
      card = null;
      el.remove();
      render();
    });
    foot.appendChild(del);
    el.appendChild(foot);

    const updateCount = () => { count.textContent = `${textarea.value.length}/${max}`; };
    updateCount();

    async function persist() {
      if (unsaved && ann.k === 'provision' && !ann.m) return;
      const result = await ext.saveAnnotation(currentLawId, ann);
      if (result.ok) {
        unsaved = false;
        msg.textContent = '保存しました';
        annotations = annotations.filter(a => a.id !== ann.id).concat([ann]);
        render();
      } else {
        msg.textContent = ext.describeAnnotationError(result);
      }
    }
    textarea.addEventListener('input', () => {
      ann.m = textarea.value;
      updateCount();
      msg.textContent = '';
      // 1文字ごとに保存すると同期の書き込み回数の上限（1分120回）に届くので、打ち終わってから保存する
      clearTimeout(cardSaveTimer);
      cardSaveTimer = setTimeout(persist, 800);
    });
    el._flush = () => {
      if (cardSaveTimer) { clearTimeout(cardSaveTimer); cardSaveTimer = null; persist(); }
    };
    el.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); closeCard(); }
    });

    document.body.appendChild(el);
    card = el;
    const width = el.offsetWidth || 300;
    const height = el.offsetHeight || 200;
    let top = rect.bottom + 8;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 8);
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
    el.style.setProperty('top', `${top}px`, 'important');
    el.style.setProperty('left', `${left}px`, 'important');
    if (options.focusMemo) textarea.focus();
  }

  // ---------------------------------------------------------------------------
  // 押した所がマーカーか調べる
  // ---------------------------------------------------------------------------

  function caretPointFromEvent(e) {
    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(e.clientX, e.clientY);
      if (pos) return { node: pos.offsetNode, offset: pos.offset };
    }
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (r) return { node: r.startContainer, offset: r.startOffset };
    }
    return null;
  }

  function onDocumentClick(e) {
    if (!enabled) return;
    const target = e.target;
    if (!target || !target.closest) return;

    const flag = target.closest('.egov-ext-note-flag');
    if (flag) {
      e.preventDefault();
      e.stopPropagation();
      const ann = annotations.find(a => a.id === flag.dataset.annotationId);
      if (ann) openCard(ann, flag.getBoundingClientRect(), { focusMemo: true });
      return;
    }

    if (card && !card.contains(target)) closeCard();
    if (target.closest('a, button, input, textarea, select, .egov-ext-tip, .egov-ext-mk-card, .egov-ext-mk-toolbar')) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    if (rangesById.size === 0) return;
    const point = caretPointFromEvent(e);
    if (!point) return;
    for (const [id, range] of rangesById) {
      try {
        if (range.isPointInRange(point.node, point.offset)) {
          const ann = annotations.find(a => a.id === id);
          if (ann) openCard(ann, range.getBoundingClientRect(), { focusMemo: true });
          return;
        }
      } catch (err) {}
    }
  }

  // ---------------------------------------------------------------------------
  // 一覧（ポップアップ）からの依頼
  // ---------------------------------------------------------------------------

  /**
   * マーカー・メモの所へ移動し、一瞬だけ目立たせる
   * @param {string} id
   */
  function gotoAnnotation(id) {
    const ann = annotations.find(a => a.id === id);
    if (!ann) return false;
    const range = rangesById.get(id);
    let target = null;
    if (range) {
      const node = range.startContainer;
      target = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    } else {
      target = document.getElementById(ann.p);
    }
    if (!target) return false;
    if (ext.fastSmoothScroll) ext.fastSmoothScroll(target);
    else target.scrollIntoView({ block: 'center' });
    if (range && typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined') {
      CSS.highlights.set('egov-mk-flash', new Highlight(range));
      setTimeout(() => CSS.highlights.delete('egov-mk-flash'), 1800);
    }
    return true;
  }

  function onRuntimeMessage(request, sender, sendResponse) {
    if (!request) return;
    if (request.type === 'EGOV_ANNOTATION_STATUS') {
      sendResponse({ lawId: currentLawId, enabled, orphans: Array.from(orphans.entries()) });
    } else if (request.type === 'EGOV_GOTO_ANNOTATION') {
      sendResponse({ ok: gotoAnnotation(request.id) });
    }
  }

  // ---------------------------------------------------------------------------
  // オン・オフ
  // ---------------------------------------------------------------------------

  async function reloadAnnotations() {
    if (!currentLawId) return;
    const lawId = currentLawId;
    const list = await ext.loadAnnotations(lawId);
    if (lawId !== currentLawId) return;
    annotations = list;
    if (list.length > 0) rememberCurrentLaw();
    renderAfterTextTasks();
  }

  function bindListenersOnce() {
    if (listenersBound) return;
    listenersBound = true;
    document.addEventListener('mouseup', onSelectionEnd);
    document.addEventListener('keyup', (e) => {
      if (e.shiftKey || e.key === 'Shift') onSelectionEnd(e);
    });
    document.addEventListener('click', onDocumentClick, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { hideToolbar(); }
    });
    // 本文の枠のスクロールで帯の位置がずれるので、スクロールしたら閉じる
    document.addEventListener('scroll', (e) => {
      if (toolbar && !toolbar.hidden && !(e.target && e.target.closest && e.target.closest('.egov-ext-mk-card'))) hideToolbar();
    }, true);
    if (chrome.runtime && chrome.runtime.onMessage) chrome.runtime.onMessage.addListener(onRuntimeMessage);
    if (ext.onAnnotationsChanged) ext.onAnnotationsChanged(() => { if (enabled && !card) reloadAnnotations(); });
  }

  /**
   * マーカー・メモを描く。法令が変わったら読み直す。
   * 本文の書き換え（算用数字化など）が動いていれば、終わるのを待ってもう一度描く
   */
  ext.enableAnnotations = function() {
    if (!ext.settings || !ext.settings.global || !ext.settings.marker || !(ext.checkIfLawPage && ext.checkIfLawPage())) {
      ext.disableAnnotations();
      return;
    }
    bindListenersOnce();
    enabled = true;
    const lawId = ext.getLawIdFromUrl ? ext.getLawIdFromUrl(window.location.href) : null;
    if (lawId !== currentLawId) {
      currentLawId = lawId;
      annotations = [];
      reloadAnnotations();
      return;
    }
    // e-Gov が本文を描き足したときも、算用数字化などの書き換えが続くので、終わってから描き直す
    renderAfterTextTasks();
  };

  /**
   * 色と付箋を消し、帯と札を閉じる（保存したものは消さない）
   */
  ext.disableAnnotations = function() {
    enabled = false;
    renderToken++;
    hideToolbar();
    closeCard();
    rangesById.clear();
    clearHighlights();
    withObserverPaused(removeFlags);
  };

  // テスト用
  ext._testAnnotations = { normalizeWithMap, collectSegments, render: () => render(), getOrphans: () => orphans, getRange: (id) => rangesById.get(id), setState: (lawId, list) => { currentLawId = lawId; annotations = list; enabled = true; } };

})(window.egovExt);

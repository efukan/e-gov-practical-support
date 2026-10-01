/**
 * backref.js
 *
 * 同じ法令の中の参照元（逆引き）。
 * 条・項・号の番号の横に「↩3」のような印を付け、その条・項・号を同じ法令のどこが参照しているかを示す。
 * 印にマウスを乗せると参照元の一覧（参照元の条項と、参照している文の前後）が出て、押すとそこへ移動する。
 * 設定「法令内の参照元」（backref）でオン・オフする。
 *
 * 材料は e-Gov が本文に付けているリンク（「前項」「同項第一号」「第六条第二項」など。href が #Mp-…）だけで、
 * 通信はしない。他の法令からの引用は citation.js（被引用表示）が受け持つ。
 */

window.egovExt = window.egovExt || {};

(function(ext) {

  const BUTTON_CLASS = 'egov-ext-backref-btn';

  /** 条・項・号（と附則の条・項・号、号の細分）を表す ID の末尾 */
  const PROVISION_ID_RE = /(?:^|[-_])(?:At|Pr|It|Si\d*)_\d+(?:_\d+)*$/;

  /**
   * 印（ボタン）ごとの参照元。WeakMap なのは、e-Gov が本文を描き直して印が消えたら一緒に捨てられるように
   * @type {WeakMap<HTMLElement, Array<{sourceEl: HTMLElement, link: HTMLAnchorElement}>>}
   */
  const entriesByButton = new WeakMap();

  /** 最後に印を付けた法令IDと、そのときの本文のリンクの数（同じなら作り直さない） */
  let builtForLawId = null;
  let builtLinkCount = -1;

  /**
   * 要素を含む、いちばん内側の条・項・号の要素を返す
   * @param {Element} el
   * @returns {HTMLElement|null}
   */
  function closestProvision(el) {
    let node = el;
    while (node && node !== document.body) {
      if (node.id && PROVISION_ID_RE.test(node.id)) return node;
      node = node.parentElement;
    }
    return null;
  }

  /**
   * 条・項・号の要素から、番号を表す要素（「第三条」「２」「三」）を返す。印はこの直後に置く。
   * 条（At）は最初の項の番号（「第三条」）に置く
   * @param {HTMLElement} provisionEl
   * @returns {HTMLElement|null}
   */
  function numberLabelOf(provisionEl) {
    const id = provisionEl.id || '';
    if (/(?:^|[-_])At_\d+(?:_\d+)*$/.test(id)) {
      const firstParagraph = provisionEl.querySelector('[id$="-Pr_1"], .paragraph');
      if (firstParagraph) return numberLabelOf(firstParagraph);
      return provisionEl.querySelector('.paragraphtitle, .articletitle');
    }
    // 項: <div class="paragraph"><div class="istitle"><span class="paragraphtitle">２</span>…
    // 号: <div class="item"><span class="itemtitle">三</span>…（号の細分は subitem1title など）
    for (const child of provisionEl.children) {
      if (child.tagName === 'SPAN' && /title$/i.test(child.className)) return child;
      if (child.classList && child.classList.contains('istitle')) {
        const span = Array.from(child.children).find(c => c.tagName === 'SPAN' && /title$/i.test(c.className));
        if (span) return span;
      }
    }
    return null;
  }

  // マーカー・メモ（annotations.js）でも、条・項・号の要素と番号の要素を同じ決まりで見つける
  ext.PROVISION_ID_RE = PROVISION_ID_RE;
  ext.closestProvision = closestProvision;
  ext.numberLabelOf = numberLabelOf;

  /**
   * 本文のリンクから、番号の要素ごとの参照元を集める。
   * 参照元が参照先の中にある（「次の各号」が自分の号を指す）、またはその逆（号から自分の条を指す）は数えない。
   * 同じ参照元が同じ所を何度指しても1件とする
   * @param {HTMLElement} container
   * @returns {Map<HTMLElement, Array<{sourceEl: HTMLElement, link: HTMLAnchorElement}>>}
   */
  ext.buildBackrefIndex = function(container) {
    /** @type {Map<HTMLElement, Array<{sourceEl: HTMLElement, link: HTMLAnchorElement}>>} */
    const index = new Map();
    if (!container) return index;
    const links = ext.deepQuerySelectorAll ? ext.deepQuerySelectorAll(container, 'a[href]') : container.querySelectorAll('a[href]');
    const currentPath = window.location.pathname.replace(/\/$/, '');

    for (let i = 0; i < links.length; i++) {
      const a = links[i];
      const href = a.getAttribute('href') || '';
      let targetId = '';
      if (href.startsWith('#')) {
        targetId = href.slice(1);
      } else if (a.hash && a.pathname.replace(/\/$/, '') === currentPath) {
        targetId = a.hash.slice(1);
      }
      if (!targetId) continue;
      // 拡張が出した吹き出しの中のリンク（括弧の薄字化などで包んだ span の中のリンクは本文なので数える）
      if (a.closest('.egov-ext-tip')) continue;
      if (ext.SIDEBAR_SELECTOR && a.closest(ext.SIDEBAR_SELECTOR)) continue; // 目次

      const targetEl = ext.resolveTargetElement ? ext.resolveTargetElement(targetId) : document.getElementById(targetId);
      if (!targetEl || !targetEl.id || !PROVISION_ID_RE.test(targetEl.id)) continue;
      const sourceEl = closestProvision(a);
      if (!sourceEl || sourceEl === targetEl) continue;
      if (sourceEl.contains(targetEl) || targetEl.contains(sourceEl)) continue;

      const label = numberLabelOf(targetEl);
      if (!label) continue;
      let entries = index.get(label);
      if (!entries) {
        entries = [];
        index.set(label, entries);
      }
      if (!entries.some(e => e.sourceEl === sourceEl)) entries.push({ sourceEl, link: a });
    }
    return index;
  };

  /**
   * 参照元の要素から「第6条第4項」のような名前を作る
   * @param {HTMLElement} sourceEl
   * @returns {string}
   */
  function sourceLabel(sourceEl) {
    if (ext.formatPathFromObjectId) {
      const path = ext.formatPathFromObjectId(sourceEl.id);
      if (path) return path;
    }
    return sourceEl.id;
  }

  /**
   * 参照している文の、リンクの前後を少しずつ切り出す（リンクの文字は強調する）
   * @param {HTMLAnchorElement} link
   * @returns {HTMLElement}
   */
  function buildSnippet(link) {
    const sentence = link.closest('.sentence, p, td') || link.parentElement;
    const full = (sentence ? sentence.textContent : link.textContent).replace(/\s+/g, ' ');
    const linkText = link.textContent.replace(/\s+/g, ' ');
    // リンクより前の文字数を数えて、リンクの位置を決める
    let before = '';
    if (sentence) {
      const range = document.createRange();
      range.setStart(sentence, 0);
      range.setEndBefore(link);
      before = range.toString().replace(/\s+/g, ' ');
    }
    const after = full.slice(before.length + linkText.length);
    const BEFORE_MAX = 28;
    const AFTER_MAX = 24;

    const snippet = document.createElement('span');
    snippet.className = 'egov-ext-backref-snippet';
    snippet.appendChild(document.createTextNode((before.length > BEFORE_MAX ? '…' : '') + before.slice(-BEFORE_MAX)));
    const mark = document.createElement('mark');
    mark.textContent = linkText;
    snippet.appendChild(mark);
    snippet.appendChild(document.createTextNode(after.slice(0, AFTER_MAX) + (after.length > AFTER_MAX ? '…' : '')));
    return snippet;
  }

  /**
   * 印の吹き出しの中身（参照元の一覧）を作る
   * @param {HTMLElement} btn
   * @returns {DocumentFragment|null}
   */
  function buildBackrefList(btn) {
    const entries = entriesByButton.get(btn);
    if (!entries || entries.length === 0) return null;
    const frag = document.createDocumentFragment();

    const header = document.createElement('div');
    header.className = 'egov-ext-tip-header';
    header.textContent = `この法令の中で、ここを参照している箇所（${entries.length}）`;
    frag.appendChild(header);

    const list = document.createElement('ul');
    list.className = 'egov-ext-backref-list';
    entries.forEach(entry => {
      const li = document.createElement('li');
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'egov-ext-backref-item';
      item.title = `${sourceLabel(entry.sourceEl)}へ移動`;

      const path = document.createElement('span');
      path.className = 'egov-ext-backref-path';
      path.textContent = sourceLabel(entry.sourceEl);
      item.appendChild(path);
      item.appendChild(buildSnippet(entry.link));

      item.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (ext.backrefTooltip) ext.backrefTooltip.hide(0);
        // 参照条文ポップアップの「ジャンプ」と同じ移動（読んでいた位置を控え、着いた所を一瞬光らせる）
        if (ext.fastSmoothScroll) ext.fastSmoothScroll(entry.sourceEl);
        else entry.sourceEl.scrollIntoView({ block: 'start' });
      });
      li.appendChild(item);
      list.appendChild(li);
    });
    frag.appendChild(list);
    return frag;
  }

  /** 吹き出しを共通基盤に登録する（初回のみ） */
  function setupBackrefTooltip() {
    if (ext.backrefTooltip || !ext.createTooltip || !ext.bindHoverTooltip) return;
    ext.backrefTooltip = ext.createTooltip({ variant: 'citation' });
    ext.bindHoverTooltip({
      selector: '.' + BUTTON_CLASS,
      tooltip: ext.backrefTooltip,
      isEnabled: () => !!(ext.settings && ext.settings.global && ext.settings.backref && (!ext.checkIfLawPage || ext.checkIfLawPage())),
      resolveContent: buildBackrefList
    });
  }

  /**
   * 条・項・号の番号の横に、参照元の数の印を付ける。
   * 同じ法令で、付けた印がまだ本文に残っていれば何もしない（e-Gov の描き直しで消えたら付け直す）
   * @param {boolean} [force=false] - true なら付け直す
   */
  ext.enableBackrefs = function(force = false) {
    if (!ext.settings || !ext.settings.global || !ext.settings.backref || !(ext.checkIfLawPage && ext.checkIfLawPage())) {
      ext.disableBackrefs();
      return;
    }
    const container = ext.getLawContainer ? ext.getLawContainer() : document.body;
    const lawId = ext.getLawIdFromUrl ? ext.getLawIdFromUrl(window.location.href) : null;
    // e-Gov は本文を少しずつ描くので、リンクの数が変わったら付け直す
    const linkCount = container.getElementsByTagName('a').length;
    const existing = container.querySelector('.' + BUTTON_CLASS);
    if (!force && builtForLawId === lawId && linkCount === builtLinkCount && existing && existing.isConnected) return;

    setupBackrefTooltip();
    const index = ext.buildBackrefIndex(container);

    // 印の付け外しで MutationObserver が本文の描き直しと取り違えないよう、その間は監視を止める
    const wasObserving = !!ext.globalDOMObserver;
    if (wasObserving) ext.globalDOMObserver.disconnect();
    try {
      (ext.deepQuerySelectorAll ? ext.deepQuerySelectorAll(container, '.' + BUTTON_CLASS) : container.querySelectorAll('.' + BUTTON_CLASS))
        .forEach(btn => btn.remove());
      index.forEach((entries, label) => {
        if (!label.parentNode) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = BUTTON_CLASS;
        btn.setAttribute('aria-label', `この法令の中で、ここを参照している箇所 ${entries.length}件`);
        const icon = document.createElement('span');
        icon.className = 'egov-ext-backref-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = '↩';
        btn.appendChild(icon);
        btn.appendChild(document.createTextNode(String(entries.length)));
        entriesByButton.set(btn, entries);
        label.parentNode.insertBefore(btn, label.nextSibling);
      });
    } finally {
      if (wasObserving && ext.reconnectDOMObserver) ext.reconnectDOMObserver();
    }
    builtForLawId = lawId;
    builtLinkCount = linkCount;
  };

  /**
   * 付けた印を取り除き、吹き出しを閉じる
   */
  ext.disableBackrefs = function() {
    const wasObserving = !!ext.globalDOMObserver;
    if (wasObserving) ext.globalDOMObserver.disconnect();
    try {
      (ext.deepQuerySelectorAll ? ext.deepQuerySelectorAll(document.body, '.' + BUTTON_CLASS) : document.querySelectorAll('.' + BUTTON_CLASS))
        .forEach(btn => btn.remove());
    } finally {
      if (wasObserving && ext.reconnectDOMObserver) ext.reconnectDOMObserver();
    }
    if (ext.backrefTooltip) ext.backrefTooltip.hide(true);
    builtForLawId = null;
    builtLinkCount = -1;
  };

})(window.egovExt);

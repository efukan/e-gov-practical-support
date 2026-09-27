/**
 * jump.js
 * 
 * 条文への移動を受け持つモジュール。
 * - 条文ジャンプ検索（入力欄。設定「条文ジャンプ検索」でオン・オフ）
 * - 条項付きURL（#Mp-At_2-Pr_1-It_14）や目次からの移動の着地を保つ処理（常に働く）
 */

window.egovExt = window.egovExt || {};

(function(ext) {

  /**
   * 条文ジャンプ検索ボックスをDOMから削除する関数
   */
  ext.removeJumpSearch = function() {
    const container = document.getElementById('egov-ext-jump-container');
    if (container) {
      container.remove();
    }
    ext.checkAndRemoveHeaderContainer();
  };

  /**
   * 条文ジャンプ検索ボックスをセットアップ（作成およびイベント設定）する関数。
   * 入力された数字（例: 5, 12-2）に基づいて該当する条文要素を特定し、
   * 独自のスムーズスクロールで高速移動させ、一時的にハイライト表示を行います。
   */
  ext.setupJumpSearch = function() {
    if (!ext.settings.global || !ext.settings.jump) {
      ext.removeJumpSearch();
      return;
    }
    
    // すでに存在している場合、SPA遷移等でDOMから消えていなければ何もしない
    let container = document.getElementById('egov-ext-jump-container');
    if (container && document.body.contains(container)) return;

    // コンテナの作成
    container = document.createElement('div');
    container.id = 'egov-ext-jump-container';
    container.className = 'egov-ext-jump-container';
    container.setAttribute('role', 'search');

    // アイコン
    const icon = document.createElement('span');
    icon.className = 'egov-ext-jump-icon';
    icon.textContent = '🔍';
    icon.setAttribute('aria-hidden', 'true');

    // 入力欄
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'egov-ext-jump-input';
    input.placeholder = '条文へジャンプ (例: 5, 12-2)';
    input.setAttribute('aria-label', '条文番号検索');

    // クリアボタン
    const clearBtn = document.createElement('span');
    clearBtn.className = 'egov-ext-jump-clear';
    clearBtn.innerHTML = '&times;';
    clearBtn.setAttribute('role', 'button');
    clearBtn.setAttribute('tabindex', '0');
    clearBtn.setAttribute('aria-label', '検索テキストをクリア');

    container.appendChild(icon);
    container.appendChild(input);
    container.appendChild(clearBtn);

    const headerContainer = ext.getOrCreateHeaderContainer();
    headerContainer.appendChild(container);

    // 入力がある時だけクリアボタンを表示する
    input.addEventListener('input', () => {
      if (input.value.length > 0) {
        clearBtn.classList.add('visible');
      } else {
        clearBtn.classList.remove('visible');
      }
    });

    const handleClear = () => {
      input.value = '';
      clearBtn.classList.remove('visible');
      input.focus();
    };

    // クリアボタンがクリックされたら入力を空にする
    clearBtn.addEventListener('click', handleClear);
    clearBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleClear();
      }
    });

    /**
     * ユーザーの検索入力テキストから、ジャンプ先のDOM要素を探索・解決する
     * @param {string} val - ユーザーの入力文字列（例: "709", "67-15-2", "附則1", "目次" など）
     * @returns {HTMLElement|null}
     */
    function findJumpTarget(val) {
      if (!val) return null;
      const raw = val.trim();

      // 1. 目次・前文の特別キーワード
      if (/^(目次|もくじ|toc)$/i.test(raw)) {
        return document.querySelector('._div_TOC, .TOC, #TOC, .toc, .sidebar') || null;
      }
      if (/^(前文|ぜんぶん)$/i.test(raw)) {
        return document.querySelector('._div_Preamble, .Preamble, #Preamble') || null;
      }

      // 附則かどうかの判定
      const isSuppl = /附|ふそく|付則/.test(raw);
      const prefix = isSuppl ? 'Sp' : 'Mp';

      // 数字部分の正規化（全角→半角）
      let normalized = ext.toHalfWidthArabic ? ext.toHalfWidthArabic(raw) : raw;
      normalized = normalized.replace(/^(附則?|付則?|本則?)/, '');
      normalized = normalized.replace(/[第条條]/g, '');
      normalized = normalized.replace(/(-|の|ー|−|—|_)/g, '_');
      normalized = normalized.trim();

      if (!normalized) return null;

      // 2. IDセレクタ探索（本則・附則、ハイフン・アンダースコア、深層階層対応）
      // prefix (Mp または Sp) を厳密に一致させ、本則と附則の誤爆を防止する
      const candidateSelectors = [
        // 完全一致（ハイフン / アンダースコア）
        `[id="${prefix}-At_${normalized}"]`,
        `[id="${prefix}_At_${normalized}"]`,
        `[name="${prefix}-At_${normalized}"]`,
        `[name="${prefix}_At_${normalized}"]`,
        // ハイフン区切り枝番対応 (例: At_67-15-2)
        `[id="${prefix}-At_${normalized.replace(/_/g, '-')}"]`,
        `[id="${prefix}_At_${normalized.replace(/_/g, '-')}"]`,
        // 単文法令（Paragraph直接型）対応
        `[id="${prefix}-Pr_${normalized}"]`,
        `[id="${prefix}_Pr_${normalized}"]`,
        // 深層階層ID対応（例: Mp-Pa_2-...-At_423 のように prefix で始まり At_X で終わる）
        `[id^="${prefix}-"][id$="-At_${normalized}"]`,
        `[id^="${prefix}_"][id$="_At_${normalized}"]`,
        `[name^="${prefix}-"][name$="-At_${normalized}"]`,
        `[name^="${prefix}_"][name$="_At_${normalized}"]`
      ];

      // e-Gov の附則の id は「法令ID-Sp-At_1」（条の無い附則は「法令ID-Sp-Pr_1」）。
      // 改正法の附則も同じ形で並ぶので、まずこの法令自身の附則（制定時の附則）を探す
      if (isSuppl) {
        const lawId = ext.getLawIdFromUrl ? ext.getLawIdFromUrl(window.location.href) : '';
        const hyphen = normalized.replace(/_/g, '-');
        if (lawId) {
          candidateSelectors.unshift(
            `[id="${lawId}-Sp-At_${normalized}"]`,
            `[id="${lawId}-Sp-Pr_${normalized}"]`
          );
        }
        candidateSelectors.push(
          `[id$="-Sp-At_${normalized}"]`,
          `[id$="-Sp-At_${hyphen}"]`,
          `[id$="-Sp-Pr_${normalized}"]`
        );
      }

      // 畳まれて見えていない要素（旧表示の改正附則など）は飛び先にしない
      const isVisible = (el) => typeof el.checkVisibility !== 'function' || el.checkVisibility();
      for (const sel of candidateSelectors) {
        const found = ext.deepQuerySelectorAll ? ext.deepQuerySelectorAll(document.body, sel) : Array.from(document.querySelectorAll(sel));
        const el = found.find(isVisible);
        if (el) return el;
      }

      // 3. 条見出しテキストによるフォールバック探索
      // （IDが特殊な法令や古い形式法令に対応）
      const kanjiNum = ext.toKanjiNumber ? ext.toKanjiNumber(normalized) : '';
      const searchTerms = [
        `第${normalized}条`,
        `第${normalized}條`,
        kanjiNum ? `第${kanjiNum}条` : '',
        kanjiNum ? `第${kanjiNum}條` : '',
        isSuppl ? `附則第${normalized}条` : '',
        isSuppl && kanjiNum ? `附則第${kanjiNum}条` : ''
      ].filter(Boolean);

      const titles = document.querySelectorAll('._div_ArticleTitle, .ArticleTitle, .paragraphtitle');
      for (const title of titles) {
        const txt = title.textContent.replace(/\s+/g, '');
        if (searchTerms.some(term => txt === term || txt.startsWith(term))) {
          return title.closest('._div_Article, Article') || title;
        }
      }

      return null;
    }

    // Enterキーで検索を実行、Escapeキーでクリア＆フォーカス解除
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        input.value = '';
        clearBtn.classList.remove('visible');
        input.blur();
        return;
      }
      if (e.key === 'Enter') {
        const val = input.value.trim();
        if (!val) return;
        
        const targetEl = findJumpTarget(val);

        if (targetEl) {
          if (ext.fastSmoothScroll) {
            ext.fastSmoothScroll(targetEl);
          }
        } else {
          input.select();
        }
      }
    });
  };


  /**
   * 条項付きURL・目次からの移動で、着地した条・項・号を画面に保つ。
   *
   * e-Gov は URL の # の位置へ自分でスクロールするが、そのあと拡張機能の高速レンダリング
   * （content-visibility）や本文の書き換えで上の条の高さが変わると、行き先が画面の外へ
   * 押し出される（建築基準法第二条第十四号の URL を開くと第十八号が出ていた）。
   * 着地先を見つけたら、位置が落ち着くまで押さえておく（utils.js の pinScrollTarget）。
   */

  /** 最後に始めた着地処理の番号（新しい移動が来たら古い待ち合わせを捨てる） */
  let landingToken = 0;

  /**
   * # が指す要素を待って、そこへ着地させる。
   * e-Gov は本文を後から描くので、ページを開いた直後は要素がまだ無い。
   * @param {string} hash - location.hash など（# の有無は問わない）
   * @param {Object} [opts]
   * @param {number} [opts.timeout=20000] - 要素が現れるのを待つ上限（ms）
   */
  ext.landOnHash = function(hash, opts = {}) {
    const token = ++landingToken;
    const id = String(hash || '').replace(/^#/, '');
    // 目次・本則全体などの大きな区切りや、拡張機能と関係のない # は e-Gov に任せる
    if (!id || !/(?:^|[-_])(?:At|Pr|It|Si\d*|Pa|Ch|Se|Ss|Di)_|^Mpat_|^[0-9A-Za-z]+-Sp/.test(id)) return;
    if (!ext.settings || !ext.settings.global) return;

    const timeout = typeof opts.timeout === 'number' ? opts.timeout : 20000;
    const deadline = Date.now() + timeout;

    const attempt = () => {
      if (token !== landingToken) return;
      const el = ext.resolveTargetElement ? ext.resolveTargetElement(id) : null;
      // 見えていない要素（畳まれた附則など）の位置は 0 と出るので、押さえると見当違いの所へ飛ぶ
      const visible = el && (typeof el.checkVisibility !== 'function' || el.checkVisibility());
      if (el && visible) {
        const target = ext.resolveScrollTarget ? ext.resolveScrollTarget(el) : el;
        if (ext.pinScrollTarget) {
          ext.pinScrollTarget(target, { minDuration: 2500, settle: 1200, maxDuration: 12000 });
        }
        if (ext.flashJumpTarget) ext.flashJumpTarget(target);
        return;
      }
      if (Date.now() < deadline) setTimeout(attempt, 150);
    };
    attempt();
  };

  /**
   * 目次など、e-Gov が自分でスクロールするページ内リンクのクリックを見張る。
   * 本文中の参照リンクは e-Gov がダイアログを出すだけでスクロールしないので、
   * クリックのあとで実際に枠が動いたときだけ着地を保つ。
   * @param {MouseEvent} e
   */
  function handleInPageLinkClick(e) {
    if (!ext.settings || !ext.settings.global) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const link = ext.getComposedTarget ? ext.getComposedTarget(e, 'a[href]') : (e.target.closest && e.target.closest('a[href]'));
    if (!link || (ext.SELF_UI_SELECTOR && link.closest && link.closest(ext.SELF_UI_SELECTOR))) return;
    let url;
    try { url = new URL(link.getAttribute('href'), window.location.href); } catch (err) { return; }
    if (!url.hash || url.pathname !== window.location.pathname) return;

    const target = ext.resolveTargetElement ? ext.resolveTargetElement(url.hash) : null;
    if (!target) return;
    const scroller = ext.getScrollContainer ? ext.getScrollContainer(target) : null;
    if (!scroller) return;
    const readPos = () => (scroller === document.scrollingElement || scroller === document.documentElement) ? window.pageYOffset : scroller.scrollTop;
    const before = readPos();
    // e-Gov が動かす前の読んでいた位置（この捕捉はキャプチャ段階なので、e-Gov の処理より先に走る）
    const reading = captureReadingPosition(scroller);

    // e-Gov のスクロールが済むのを 2 フレーム待ってから確かめる
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
    raf(() => raf(() => {
      const moved = Math.abs(readPos() - before);
      if (moved < 1) return;
      if (reading && moved > 200) pushReadingPosition(reading);
      const scrollTarget = ext.resolveScrollTarget ? ext.resolveScrollTarget(target) : target;
      landingToken++;
      ext.pinScrollTarget(scrollTarget, { minDuration: 1500, settle: 1000, maxDuration: 8000 });
    }));
  }

  /* ------------------------------------------------------------------ */
  /* 元の位置へ戻る                                                       */
  /* ------------------------------------------------------------------ */

  /*
   * 定義語ポップアップの「定義へ」、参照条文の「ジャンプ」、条文ジャンプ検索、目次のクリックで
   * 読んでいた位置を離れたとき、右下のボタンでそこへ戻れるようにする。
   * ブラウザの「戻る」（Alt+←）は e-Gov の画面遷移に使われているので横取りしない。
   * 位置はスクロール量ではなく「枠の上端にあった要素と、その要素のずれ」で控える。
   * 高速レンダリングで上の条の高さが後から変わっても、同じ文に戻れる
   */

  /** 控えておく位置の数（古いものから捨てる） */
  const RETURN_STACK_LIMIT = 10;

  /** @type {{el: Element, rel: number, scroller: Element, label: string}[]} */
  const returnStack = [];

  /**
   * 枠の上端付近に見えている本文の要素と、その位置を控える
   * @param {Element} [scroller]
   * @returns {{el: Element, rel: number, scroller: Element, label: string}|null}
   */
  function captureReadingPosition(scroller) {
    const sc = scroller || (ext.getLawScrollContainer ? ext.getLawScrollContainer() : null);
    if (!sc || typeof document.elementFromPoint !== 'function') return null;
    const isDoc = ext.isDocumentScroller ? ext.isDocumentScroller(sc) : false;
    const rect = isDoc
      ? { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight }
      : sc.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    // ポップアップが上に重なっていることがあるので、何か所か当たってみる
    for (const dy of [24, 64, 120, 200]) {
      for (const fx of [0.5, 0.25, 0.75]) {
        const hit = document.elementFromPoint(rect.left + rect.width * fx, rect.top + dy);
        if (!hit || (!isDoc && !sc.contains(hit))) continue;
        if (hit.closest && hit.closest(`.egov-ext-tip, .egov-ext-return, ${ext.SELF_UI_SELECTOR}`)) continue;
        const el = hit.closest('p, div, td, th, li, section, article') || hit;
        if (el === sc) continue;
        return { el, rel: ext.topWithinScroller(el, sc), scroller: sc, label: positionLabel(el) };
      }
    }
    return null;
  }

  /**
   * 要素の位置を「第十二条」「附則第三条」の形で言う（ボタンの文言）
   * @param {Element} el
   * @returns {string}
   */
  function positionLabel(el) {
    let p = el;
    while (p && !(p.id && /(?:^|-)At_[0-9_]+(?:-|$)/.test(p.id))) p = p.parentElement;
    if (!p) return '';
    const m = p.id.match(/(?:^|-)At_([0-9_]+)(?:-|$)/);
    const toKanji = ext.numberToKanji || String;
    const nums = m[1].split('_').map(Number);
    let label = `第${toKanji(nums[0])}条` + nums.slice(1).map(n => `の${toKanji(n)}`).join('');
    if (/-Sp(?:-|$)/.test(p.id)) label = '附則' + label;
    if (ext.settings && ext.settings.horizontal && ext.convertLawTextToHorizontal) {
      label = ext.convertLawTextToHorizontal(label);
    }
    return label;
  }

  /**
   * 控えた位置を積む
   * @param {{el: Element, rel: number, scroller: Element, label: string}} entry
   */
  function pushReadingPosition(entry) {
    if (!entry) return;
    const top = returnStack[returnStack.length - 1];
    // 同じ所から続けて移動したときは一つにまとめる
    if (top && top.el === entry.el && Math.abs(top.rel - entry.rel) < 40) return;
    returnStack.push(entry);
    if (returnStack.length > RETURN_STACK_LIMIT) returnStack.shift();
    renderReturnButton();
  }

  /**
   * 今読んでいる位置を控える（移動する直前に呼ぶ）
   * @param {Element} [scroller]
   */
  ext.rememberReadingPosition = function(scroller) {
    if (!ext.settings || !ext.settings.global) return;
    pushReadingPosition(captureReadingPosition(scroller));
  };

  /** 最後に控えた位置へ戻る */
  ext.returnToReadingPosition = function() {
    let entry = returnStack.pop();
    while (entry && !entry.el.isConnected) entry = returnStack.pop();
    renderReturnButton();
    if (!entry || !ext.pinScrollTarget) return;
    ext.pinScrollTarget(entry.el, { scroller: entry.scroller, offset: entry.rel, minDuration: 1000, settle: 800, maxDuration: 6000 });
    if (ext.flashJumpTarget) ext.flashJumpTarget(entry.el);
  };

  /** 控えた位置をすべて捨て、ボタンを消す（別の法令へ移ったとき・機能を切ったとき） */
  ext.clearReturnStack = function() {
    returnStack.length = 0;
    renderReturnButton();
  };

  /** 右下の「戻る」ボタンを、控えた位置に合わせて出す・消す */
  function renderReturnButton() {
    let box = document.getElementById('egov-ext-return');
    if (!returnStack.length || !ext.settings || !ext.settings.global) {
      if (box) box.remove();
      return;
    }
    if (!box) {
      box = document.createElement('div');
      box.id = 'egov-ext-return';
      box.className = 'egov-ext-return';
      box.setAttribute('role', 'group');
      box.setAttribute('aria-label', '元の位置へ戻る');

      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'egov-ext-return-btn';
      back.addEventListener('click', (e) => {
        e.preventDefault();
        ext.returnToReadingPosition();
      });

      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'egov-ext-return-close';
      close.textContent = '×';
      close.title = '戻り先を消す';
      close.setAttribute('aria-label', '戻り先を消す');
      close.addEventListener('click', (e) => {
        e.preventDefault();
        ext.clearReturnStack();
      });

      box.appendChild(back);
      box.appendChild(close);
      document.body.appendChild(box);
    }
    const entry = returnStack[returnStack.length - 1];
    const back = box.querySelector('.egov-ext-return-btn');
    const where = entry.label ? `${entry.label}へ戻る` : '元の位置へ戻る';
    back.textContent = `↩ ${where}`;
    back.title = returnStack.length > 1 ? `${where}（ほかに ${returnStack.length - 1} か所）` : where;
  }

  /** ページ内リンクの見張りを一度だけ登録する */
  ext.setupAnchorLanding = function() {
    if (ext._anchorLandingReady) return;
    ext._anchorLandingReady = true;
    document.addEventListener('click', handleInPageLinkClick, true);
    window.addEventListener('hashchange', () => ext.landOnHash(window.location.hash));
  };

})(window.egovExt);

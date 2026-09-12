/**
 * tooltip.js
 *
 * 拡張機能内のホバー表示（定義語ホバー辞書・参照条文プレビュー・被引用一覧）で
 * 共通して使う、ツールチップの生成・配置・イベント制御の基盤モジュール。
 *
 * 以前は3つの機能がそれぞれ独自にツールチップDIVを作り、
 * document.body に個別の mouseover リスナーを張り、
 * ほぼ同じ位置計算コードを重複して持っていた。ここではそれらを1つに集約している。
 *
 * - 位置計算: 画面外にはみ出す場合は上下フリップ＋左右クランプ
 * - 表示制御: 表示ディレイ（マウス通過時のチラつき防止）と非表示ディレイ
 *             （ツールチップ本体へマウスを移動する猶予）
 * - リフロー: 「配置 → 測定 → 表示」を1パスにまとめ、強制同期レイアウトを避ける
 * - a11y   : role="tooltip" / aria-describedby / Escape / フォーカス表示
 */

window.egovExt = window.egovExt || {};

(function(ext) {
  /** ビューポート端との最小マージン（px） */
  const VIEWPORT_MARGIN = 10;

  /** アンカー要素とツールチップの間隔（px） */
  const ANCHOR_GAP = 8;

  /** 生成したツールチップの一意なID採番用カウンタ */
  let tooltipIdCounter = 0;

  /**
   * 生成済みのすべてのツールチップインスタンス。
   * Escape キーや「他のツールチップを開いたら閉じる」制御に使う。
   * @type {Set<Object>}
   */
  const instances = new Set();

  /**
   * 委譲リスナーが登録済みかどうか
   * @type {boolean}
   */
  let delegatesBound = false;

  /**
   * セレクタとハンドラの対応表。mouseover のたびに1回だけ closest() を実行し、
   * どのツールチップを開くかをここから引く。
   * @type {Array<{selector: string, tooltip: Object, resolveContent: Function}>}
   */
  const bindings = [];

  /**
   * bindings 全体をまとめた1本のセレクタ（キャッシュ）
   * @type {string}
   */
  let combinedSelector = '';

  /**
   * ツールチップを1つ生成する。
   *
   * @param {Object} [options]
   * @param {string} [options.variant='default'] - 'definition' | 'reference' | 'citation'
   * @param {number} [options.showDelay=120] - 表示までの遅延（ms）。マウス通過時のチラつきを防ぐ
   * @param {number} [options.hideDelay=180] - 非表示までの遅延（ms）。ツールチップ本体へ移動する猶予
   * @returns {{el: HTMLElement, show: Function, hide: Function, cancelHide: Function, destroy: Function}}
   */
  ext.createTooltip = function(options) {
    const {
      variant = 'default',
      showDelay = 120,
      hideDelay = 180,
      placement = 'auto',
      parent = null
    } = options || {};

    const el = document.createElement('div');
    el.className = `egov-ext-tip egov-ext-tip--${variant}`;
    el.setAttribute('role', 'tooltip');
    el.id = `egov-ext-tip-${++tooltipIdCounter}`;

    // 矢印（::after）は枠の外側に描くため、スクロールは内側の要素に持たせる。
    // ツールチップ自身に overflow を付けると矢印まで切り取られてしまう。
    const scroller = document.createElement('div');
    scroller.className = 'egov-ext-tip-scroll';
    el.appendChild(scroller);

    /** @type {number|null} */
    let showTimer = null;
    /** @type {number|null} */
    let hideTimer = null;
    /** 現在ツールチップを開いているアンカー要素 @type {HTMLElement|null} */
    let currentAnchor = null;
    /** 子ツールチップインスタンスのSet @type {Set<Object>} */
    const children = new Set();

    /** タイマーをすべて解除する */
    function clearTimers() {
      if (showTimer !== null) { clearTimeout(showTimer); showTimer = null; }
      if (hideTimer !== null) { clearTimeout(hideTimer); hideTimer = null; }
    }

    /**
     * ツールチップをアンカー要素に対して配置する。
     * 読み取り（getBoundingClientRect / offsetWidth）をまとめてから書き込むことで、
     * 強制同期レイアウトが1回で済むようにしている。
     * @param {HTMLElement} anchor
     */
    function position(anchor) {
      const anchorRect = anchor.getBoundingClientRect();
      const viewportW = document.documentElement.clientWidth;
      const viewportH = document.documentElement.clientHeight;

      // 表示前に測定できるよう、visibility:hidden のまま画面外に置いて実寸を得る
      el.style.left = '0px';
      el.style.top = '0px';
      const tipW = el.offsetWidth;
      const tipH = el.offsetHeight;

      if (placement === 'side') {
        // --- 水平方向: アンカーの右側に配置、はみ出す場合は左側へフリップ ---
        const spaceRight = viewportW - anchorRect.right - ANCHOR_GAP;
        const spaceLeft = anchorRect.left - ANCHOR_GAP;
        const flipLeft = tipW > spaceRight && spaceLeft > spaceRight;

        let left;
        if (flipLeft) {
          left = anchorRect.left - ANCHOR_GAP - tipW;
        } else {
          left = anchorRect.right + ANCHOR_GAP;
        }
        left = Math.max(VIEWPORT_MARGIN, Math.min(left, viewportW - tipW - VIEWPORT_MARGIN));

        // --- 垂直方向: アンカーの上端に揃え、ビューポート内にクランプ ---
        let top = anchorRect.top;
        top = Math.max(VIEWPORT_MARGIN, Math.min(top, viewportH - tipH - VIEWPORT_MARGIN));

        el.classList.toggle('is-flipped-left', flipLeft);
        el.classList.remove('is-flipped');
        el.style.setProperty('--egov-arrow-x', '0px');
        el.style.left = `${left + window.scrollX}px`;
        el.style.top = `${top + window.scrollY}px`;
        return;
      }

      // --- 垂直方向: 下に収まらなければ上へフリップする ---
      const spaceBelow = viewportH - anchorRect.bottom - ANCHOR_GAP;
      const spaceAbove = anchorRect.top - ANCHOR_GAP;
      const flipUp = tipH > spaceBelow && spaceAbove > spaceBelow;

      let top;
      if (flipUp) {
        top = anchorRect.top - ANCHOR_GAP - tipH;
      } else {
        top = anchorRect.bottom + ANCHOR_GAP;
      }
      // どちらにも収まらない場合はビューポート内にクランプする
      top = Math.max(VIEWPORT_MARGIN, Math.min(top, viewportH - tipH - VIEWPORT_MARGIN));

      // --- 水平方向: アンカー左端に揃え、はみ出す分だけ内側へ寄せる ---
      let left = anchorRect.left;
      const maxLeft = viewportW - tipW - VIEWPORT_MARGIN;
      if (left > maxLeft) left = maxLeft;
      if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN;

      // --- 矢印: アンカーの中心を指すよう、ツールチップ内での相対位置を渡す ---
      const anchorCenter = anchorRect.left + anchorRect.width / 2;
      const arrowX = Math.max(14, Math.min(anchorCenter - left, tipW - 14));

      el.classList.toggle('is-flipped', flipUp);
      el.classList.remove('is-flipped-left');
      el.style.setProperty('--egov-arrow-x', `${arrowX}px`);
      el.style.left = `${left + window.scrollX}px`;
      el.style.top = `${top + window.scrollY}px`;
    }

    const instance = {
      el,
      parent,
      children,

      /**
       * ツールチップを表示する。showDelay 経過後に実際の表示が行われる。
       * @param {HTMLElement} anchor - 基準となる要素
       * @param {Node} content - 表示する内容（DOMノード）
       * @param {boolean} [immediate=false] - true ならディレイ無しで即表示
       */
      show(anchor, content, immediate = false) {
        clearTimers();

        // 同じアンカーで既に表示中なら中身の作り直しはしない
        if (currentAnchor === anchor && el.classList.contains('visible')) return;

        const render = () => {
          showTimer = null;

          // 他のツールチップが開いていれば閉じる（自分・祖先・子孫は閉じる対象から除外）
          instances.forEach(other => {
            if (other === instance) return;
            // other が自分の祖先かチェック
            let cur = parent;
            while (cur) {
              if (cur === other) return;
              cur = cur.parent;
            }
            // other が自分の子孫かチェック
            if (children.has(other)) return;

            other.hide(true);
          });

          scroller.textContent = '';
          scroller.appendChild(content);
          scroller.scrollTop = 0;

          currentAnchor = anchor;
          position(anchor);
          el.classList.add('visible');

          anchor.setAttribute('aria-describedby', el.id);
        };

        if (immediate || showDelay <= 0) {
          render();
        } else {
          showTimer = setTimeout(render, showDelay);
        }
      },

      /**
       * 表示中のツールチップの内容を差し替え、必要に応じて再配置する。
       * @param {Node} newContent
       */
      update(newContent) {
        if (!el.classList.contains('visible') || !currentAnchor) return;
        scroller.textContent = '';
        scroller.appendChild(newContent);
        position(currentAnchor);
      },

      /**
       * ツールチップを隠す。
       * @param {boolean} [immediate=false] - true ならディレイ無しで即非表示
       */
      hide(immediate = false) {
        if (showTimer !== null) { clearTimeout(showTimer); showTimer = null; }
        if (hideTimer !== null) { clearTimeout(hideTimer); hideTimer = null; }

        const doHide = () => {
          hideTimer = null;
          el.classList.remove('visible');
          if (currentAnchor) {
            currentAnchor.removeAttribute('aria-describedby');
            currentAnchor = null;
          }
          // 子ツールチップも連動して閉じる
          children.forEach(c => c.hide(true));
        };

        if (immediate || hideDelay <= 0) {
          doHide();
        } else {
          hideTimer = setTimeout(doHide, hideDelay);
        }
      },

      /** 非表示予約を取り消す（ツールチップ本体にマウスが乗ったとき等） */
      cancelHide() {
        if (hideTimer !== null) { clearTimeout(hideTimer); hideTimer = null; }
        if (parent) parent.cancelHide();
      },

      /** 現在このツールチップを開いているアンカー要素 */
      get anchor() { return currentAnchor; },

      /** ツールチップをDOMから取り除き、インスタンスを破棄する */
      destroy() {
        clearTimers();
        if (parent && parent.children) {
          parent.children.delete(instance);
        }
        children.forEach(c => c.destroy());
        instances.delete(instance);
        if (el.parentNode) el.parentNode.removeChild(el);
      }
    };

    if (parent && parent.children) {
      parent.children.add(instance);
    }

    // ツールチップ本体にマウスが乗っている間は閉じない（中をスクロール・クリックできるようにする）
    el.addEventListener('mouseenter', () => instance.cancelHide());
    el.addEventListener('mouseleave', (e) => {
      // 子ツールチップへ移動した場合は親を閉じない
      const related = e.relatedTarget;
      if (related) {
        for (const child of children) {
          if (related === child.el || child.el.contains(related)) return;
        }
      }
      instance.hide();
    });

    instances.add(instance);
    return instance;
  };

  /**
   * ツールチップをDOMに接続する（未接続、またはSPA遷移で外れていた場合のみ）。
   * @param {Object} tooltip - createTooltip の戻り値
   */
  ext.attachTooltip = function(tooltip) {
    if (!document.body.contains(tooltip.el)) {
      document.body.appendChild(tooltip.el);
    }
  };

  /**
   * ホバーでツールチップを開く対象を登録する。
   *
   * 実際の mouseover / mouseout リスナーは document.body に1組だけ張られ、
   * 登録済みのセレクタをまとめた1本の closest() で振り分ける。
   * （以前は機能ごとに body へリスナーを張っていたため、
   *   マウスを動かすたびに同種の祖先探索が3回走っていた）
   *
   * @param {Object} config
   * @param {string} config.selector - ホバー対象のCSSセレクタ
   * @param {Object} config.tooltip - createTooltip の戻り値
   * @param {function(HTMLElement): (Node|null)} config.resolveContent
   *   アンカー要素から表示内容のDOMノードを作る関数。null を返すと表示しない
   * @param {function(): boolean} [config.isEnabled] - false を返す間は無効
   */
  ext.bindHoverTooltip = function(config) {
    bindings.push({
      selector: config.selector,
      tooltip: config.tooltip,
      resolveContent: config.resolveContent,
      isEnabled: config.isEnabled || (() => true)
    });
    combinedSelector = bindings.map(b => b.selector).join(', ');

    bindDelegatesOnce();
  };

  /**
   * イベント委譲の本体。1度だけ document.body へ登録する。
   */
  function bindDelegatesOnce() {
    if (delegatesBound) return;
    delegatesBound = true;

    /**
     * イベント発生位置から、対応する binding とアンカー要素を解決する
     * @param {Event} e
     * @returns {{binding: Object, anchor: HTMLElement}|null}
     */
    function resolveBinding(e) {
      if (!combinedSelector) return null;

      // 全セレクタをまとめた1回の closest() で判定する
      const anchor = ext.getComposedTarget(e, combinedSelector);
      if (!anchor) return null;

      for (let i = 0; i < bindings.length; i++) {
        const binding = bindings[i];
        if (binding.isEnabled() && anchor.matches(binding.selector)) {
          return { binding, anchor };
        }
      }
      return null;
    }

    /**
     * アンカーに対応するツールチップを開く
     * @param {Object} binding
     * @param {HTMLElement} anchor
     * @param {boolean} immediate - キーボードフォーカス時などディレイ無しで開くか
     */
    function openFor(binding, anchor, immediate) {
      const content = binding.resolveContent(anchor);
      if (!content) {
        // 表示するものが無い要素（他法令へのリンク等）にマウスが移った場合、
        // 直前の表示が残り続けないよう閉じる
        if (binding.tooltip.anchor && binding.tooltip.anchor !== anchor) {
          binding.tooltip.hide();
        }
        return;
      }
      ext.attachTooltip(binding.tooltip);
      binding.tooltip.show(anchor, content, immediate);
    }

    document.body.addEventListener('mouseover', (e) => {
      const resolved = resolveBinding(e);
      if (!resolved) return;
      resolved.binding.tooltip.cancelHide();
      openFor(resolved.binding, resolved.anchor, false);
    });

    document.body.addEventListener('mouseout', (e) => {
      const resolved = resolveBinding(e);
      if (!resolved) return;

      // ツールチップ本体へ移動した場合は閉じない（hideDelay 中に mouseenter が拾う）
      const related = e.relatedTarget;
      const tip = resolved.binding.tooltip.el;
      if (related && (related === tip || tip.contains(related))) return;

      resolved.binding.tooltip.hide();
    });

    // キーボード操作: フォーカスで表示、フォーカスが外れたら非表示
    document.body.addEventListener('focusin', (e) => {
      const resolved = resolveBinding(e);
      if (!resolved) return;
      openFor(resolved.binding, resolved.anchor, true);
    });

    document.body.addEventListener('focusout', (e) => {
      const resolved = resolveBinding(e);
      if (!resolved) return;
      resolved.binding.tooltip.hide(true);
    });

    // Escape で開いているツールチップをすべて即座に閉じる
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      instances.forEach(instance => instance.hide(true));
    });
  }

})(window.egovExt);

/**
 * refer_popup.js
 *
 * 参照条文プレビュー（ホバーで条文の中身を見せるポップアップ）のロジック。
 * ツールチップの生成・配置・表示制御は js/tooltip.js の共通基盤が担当し、
 * このモジュールは「リンクからプレビュー内容を作る」部分だけを受け持つ。
 */

window.egovExt = window.egovExt || {};

(function(ext) {
  /**
   * 参照条文プレビューのツールチップインスタンス
   * @type {Object|null}
   */
  ext.referenceTooltip = null;

  /**
   * リンクの参照先 ID から、実際の対象要素を解決する。
   * e-Gov の法令ページは ID の表記が揺れることがあるため、多段のフォールバックを行う。
   *
   * @param {string} targetId - URL のハッシュ部分
   * @returns {HTMLElement|null} 見つかった要素、なければ null
   */
  function resolveTargetElement(targetId) {
    if (!targetId) return null;

    /**
     * 通常のDOMとShadow DOMの両方から id / name で要素を探す
     * @param {string} id
     * @returns {HTMLElement|null}
     */
    const findById = (id) => document.getElementById(id) ||
                             document.querySelector(`[name="${id}"]`) ||
                             ext.deepQuerySelectorAll(document.body, `[id="${id}"], [name="${id}"]`)[0] ||
                             null;

    const direct = findById(targetId);
    if (direct) return direct;

    // 1. ハイフンとアンダースコアの表記揺れを相互変換して再検索
    let altId = null;
    if (targetId.includes('-')) {
      altId = targetId.replace(/-/g, '_');
    } else if (targetId.includes('_')) {
      altId = targetId.replace(/_/g, '-');
    }
    if (altId) {
      const alt = findById(altId);
      if (alt) return alt;
    }

    // 2. 改正附則などの前方一致・後方一致検索（ハイフン／アンダースコア両対応）
    const match = targetId.match(/^(Mp|Sp|Sp_.*)-(.+)$/);
    if (match) {
      const selector = `[id^="${match[1]}-"][id$="${match[2]}"], [id^="${match[1]}_"][id$="${match[2]}"]`;
      return document.querySelector(selector) ||
             ext.deepQuerySelectorAll(document.body, selector)[0] ||
             null;
    }

    return null;
  }

  /**
   * リンクが「同じ法令内へのリンク」かどうかを判定する。
   * 他法令へのリンクは、その中身がこのページに無いためプレビューしない。
   *
   * @param {HTMLAnchorElement} a - 判定対象のリンク
   * @param {HTMLElement|null} targetEl - 解決済みの参照先要素
   * @returns {boolean}
   */
  function isInternalLink(a, targetEl) {
    const currentLawId = ext.getLawIdFromUrl(window.location.href);
    const targetLawId = ext.getLawIdFromUrl(a.href);
    if (currentLawId && targetLawId && currentLawId !== targetLawId) return false;

    const hrefAttr = a.getAttribute('href');
    const stripSlash = (p) => p.replace(/\/$/, '');

    // ハッシュのみ / パスが一致 / 参照先要素が現在のDOMに存在する、のいずれかを満たせば内部リンク
    return hrefAttr.startsWith('#') ||
           a.pathname === window.location.pathname ||
           stripSlash(a.pathname) === stripSlash(window.location.pathname) ||
           !!targetEl;
  }

  /**
   * 参照先要素からプレビュー用のDOMを組み立てる。
   *
   * 参照先が `<a name="...">` のアンカーの場合、それ自体には中身が無いため、
   * 次の条見出しや章見出しが現れるまでの兄弟要素をかき集める。
   *
   * @param {HTMLElement} targetEl - 参照先要素
   * @returns {HTMLElement} プレビュー内容を格納したDIV
   */
  function buildPreviewContent(targetEl) {
    let clone;

    if (targetEl.tagName.toLowerCase() === 'a' && targetEl.hasAttribute('name')) {
      clone = document.createElement('div');
      let foundTitle = false;

      for (let current = targetEl.nextElementSibling; current; current = current.nextElementSibling) {
        const classList = current.classList;
        if (!classList) break;

        // 次の条タイトルに到達したら、そこが次の条文の始まりなので打ち切る
        const isTitle = classList.contains('_div_ArticleTitle') || classList.contains('ArticleTitle');
        if (isTitle) {
          if (foundTitle) break;
          foundTitle = true;
        }

        // 章・節の見出しに到達した場合も打ち切る
        const isHeader = classList.contains('ChapterTitle') || classList.contains('_div_ChapterTitle') ||
                         classList.contains('SectionTitle') || classList.contains('_div_SectionTitle');
        if (isHeader) break;

        clone.appendChild(current.cloneNode(true));
      }
    } else {
      clone = targetEl.cloneNode(true);
    }

    // クローンした要素から「引用」ボタンを確実に除去（ポップアップ内での不要表示・誤操作を防止）
    const citationBtns = clone.querySelectorAll('.egov-ext-citation-btn, [class*="citation-btn"]');
    citationBtns.forEach(btn => btn.remove());

    const container = document.createElement('div');
    container.className = 'egov-ext-preview-container';

    // ヘッダー（参照条文 ＋ ジャンプボタン）
    const header = document.createElement('div');
    header.className = 'egov-ext-tip-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'egov-ext-tip-header-title';
    titleWrap.textContent = '参照条文';
    header.appendChild(titleWrap);

    // ジャンプボタン
    if (ext.createTipActionButton) {
      const jumpBtn = ext.createTipActionButton({
        icon: 'jump',
        label: 'ジャンプ',
        title: 'この条文の場所へ移動',
        onClick: () => {
          if (ext.referenceTooltip) {
            ext.referenceTooltip.hide(0);
          }
          if (ext.fastSmoothScroll) {
            ext.fastSmoothScroll(targetEl, 250);
          } else if (targetEl.scrollIntoView) {
            targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }

          targetEl.classList.remove('egov-ext-jump-target');
          setTimeout(() => {
            targetEl.classList.add('egov-ext-jump-target');
            setTimeout(() => {
              targetEl.classList.remove('egov-ext-jump-target');
            }, 2500);
          }, 10);
        }
      });
      header.appendChild(jumpBtn);
    }
    container.appendChild(header);

    const body = document.createElement('div');
    body.className = 'egov-ext-tip-body';
    body.appendChild(clone);

    // 共通成形関数でポップアップDOMをインライン化・クリーンアップ
    ext.formatInlinePreview(body);
    container.appendChild(body);

    return container;
  }



  /**
   * 現在非同期ロード中の他法令リンク要素
   * @type {HTMLAnchorElement|null}
   */
  let activeExternalLink = null;

  /**
   * 他法令リンクの解析結果キャッシュ（同一リンクへのホバー時の再探索をO(1)化）
   * @type {WeakMap<HTMLAnchorElement, {lawName: string, path: string}>}
   */
  const parsedLawLinkCache = new WeakMap();

  /**
   * リンク要素および前後のテキストから法令名と条番号パスを抽出する
   * @param {HTMLAnchorElement} a
   * @param {string} targetLawId
   * @returns {{lawName: string, path: string}}
   */
  function parseLawLinkText(a, targetLawId) {
    if (a && typeof a === 'object' && parsedLawLinkCache.has(a)) {
      return parsedLawLinkCache.get(a);
    }

    const rawText = (a.textContent || '').trim();
    let result;

    // 1. "民法第七百九条", "地方自治法第十条第一項" のように法令名と条番号が結合している場合
    const fullMatch = rawText.match(/^(.+?(?:法|令|規則|府令|省令|憲法|条約|条例|布告|規程))(?:\s*)(第[0-9一二三四五六七八九十百千万]+条.*)?$/);
    if (fullMatch) {
      result = {
        lawName: fullMatch[1],
        path: fullMatch[2] || ''
      };
    } else if (/^第[0-9一二三四五六七八九十百千万]+条/.test(rawText)) {
      // 2. "第七百九条" のように条番号のみの場合、直前のテキストから法令名を探す
      const precedingName = findPrecedingLawName(a);
      result = {
        lawName: precedingName,
        path: rawText
      };
    } else {
      // 3. その他（法令名のみの場合や特殊表記）
      result = {
        lawName: rawText,
        path: ''
      };
    }

    if (a && typeof a === 'object') {
      parsedLawLinkCache.set(a, result);
    }
    return result;
  }

  /**
   * リンクの直前のテキストから法令名を探索する
   * 例: "内閣府設置法（平成十一年法律第八十九号）<a href="...">第四十九条</a>" -> "内閣府設置法"
   * @param {HTMLAnchorElement} a
   * @returns {string}
   */
  function findPrecedingLawName(a) {
    let prev = a.previousSibling;
    let step = 0;
    while (prev && step < 6) {
      step++;
      const txt = prev.textContent || '';
      const m = txt.match(/([^\s（(「]+?(?:法|令|規則|府令|省令|憲法|条約|条例|布告|規程))(?:（[^）]*）|\([^)]*\))?\s*$/);
      if (m) return m[1];
      prev = prev.previousSibling;
    }
    if (a.parentElement) {
      const parentText = a.parentElement.textContent || '';
      const linkIdx = parentText.indexOf(a.textContent);
      if (linkIdx > 0) {
        // 直前300文字に制限して末尾マッチを探索（巨大な段落での正規表現負荷を軽減）
        const beforeText = parentText.slice(Math.max(0, linkIdx - 300), linkIdx);
        const m = beforeText.match(/([^\s（(「]+?(?:法|令|規則|府令|省令|憲法|条約|条例|布告|規程))(?:（[^）]*）|\([^)]*\))?\s*$/);
        if (m) return m[1];
      }
    }
    return '';
  }

  /**
   * 他法令リンクのプレビューを非同期取得し、ツールチップを更新する
   * @param {HTMLAnchorElement} link
   * @param {string} lawId
   * @param {string} objectId
   * @param {string} lawName
   * @param {string} path
   */
  async function fetchAndPopulateExternalPreview(link, lawId, objectId, lawName, path) {
    activeExternalLink = link;

    try {
      if (!ext.getOrFetchArticlePreview) {
        throw new Error('プレビュー取得機能が初期化されていません');
      }
      const previewDOM = await ext.getOrFetchArticlePreview(lawId, objectId, '', lawName, path, '');
      if (!previewDOM) throw new Error('条文データを取得できませんでした');

      // 横書き設定が有効ならプレビュー内も横書き変換を適用
      if (ext.settings.horizontal && ext.applyHorizontalConversion) {
        ext.applyHorizontalConversion(previewDOM);
      }

      // まだこのリンクにユーザーが注目している場合（ホバー中・待機中・またはツールチップ表示中）
      const tip = ext.referenceTooltip;
      const isTargetActive = (activeExternalLink === link) ||
        (tip && (tip.anchor === link || tip.pendingAnchor === link));

      if (isTargetActive && tip) {
        if (tip.el.classList.contains('visible')) {
          tip.update(previewDOM.cloneNode(true));
        } else {
          // まだディレイ待機中（未表示）だった場合は即座にプレビューを表示（読み込み中フリーズを完全根絶）
          tip.show(link, previewDOM.cloneNode(true), true);
        }
      }
    } catch (err) {
      const tip = ext.referenceTooltip;
      const isTargetActive = (activeExternalLink === link) ||
        (tip && (tip.anchor === link || tip.pendingAnchor === link));

      if (isTargetActive && tip) {
        const errorFrag = ext.createErrorView
          ? ext.createErrorView(lawName, path, err.message, link.href)
          : document.createTextNode(err.message);
        if (tip.el.classList.contains('visible')) {
          tip.update(errorFrag);
        } else {
          tip.show(link, errorFrag, true);
        }
      }
    }
  }

  /**
   * 参照条文プレビューを有効化する。
   */
  ext.enablePopup = function() {
    if (!ext.settings.global || !ext.settings.popup) return;
    if (ext.referenceTooltip) return;

    ext.referenceTooltip = ext.createTooltip({ variant: 'reference' });

    ext.bindHoverTooltip({
      selector: 'a[href*="#"], a[href*="/law/"], a[href*="lawId="]',
      tooltip: ext.referenceTooltip,
      isEnabled: () => !!(ext.settings.global && ext.settings.popup),
      resolveContent: (a) => {
        // 左カラム（サイドバー、目次）や被引用一覧ツールチップ内のリンクはプレビューしない
        if (ext.deepClosest(a, ext.SIDEBAR_SELECTOR) || ext.deepClosest(a, '.egov-ext-tip--citation')) return null;

        const currentLawId = ext.getLawIdFromUrl(window.location.href);
        const targetLawId = ext.getLawIdFromUrl(a.href);
        const targetId = a.href.includes('#') ? a.href.split('#')[1] : null;
        const targetEl = targetId ? resolveTargetElement(targetId) : null;

        // 1. 同一法令内のリンク（内部リンク）: 現在のページのDOMから即時生成
        if (isInternalLink(a, targetEl)) {
          if (!targetEl) return null;
          const content = buildPreviewContent(targetEl);
          if (ext.settings.horizontal && ext.applyHorizontalConversion) {
            ext.applyHorizontalConversion(content);
          }
          return content;
        }

        // 2. 他法令へのリンク（外部リンク）: API / XML から非同期取得
        if (!targetLawId) return null;

        const objectId = targetId || 'Mp';
        const { lawName, path } = parseLawLinkText(a, targetLawId);
        const cacheKey = `${targetLawId}:${objectId}`;

        // すでにキャッシュが存在する場合は即座に表示
        if (ext.citationPreviewCache && ext.citationPreviewCache.has(cacheKey)) {
          const cachedDOM = ext.citationPreviewCache.get(cacheKey).cloneNode(true);
          if (ext.settings.horizontal && ext.applyHorizontalConversion) {
            ext.applyHorizontalConversion(cachedDOM);
          }
          return cachedDOM;
        }

        // キャッシュが無い場合はローディング画面を即座に返し、非同期取得を開始
        const loadingDOM = ext.createLoadingView
          ? ext.createLoadingView(lawName, path, a.href)
          : document.createTextNode('読み込み中...');
        fetchAndPopulateExternalPreview(a, targetLawId, objectId, lawName, path);
        return loadingDOM;
      }
    });
  };


  // テスト用に内部関数をエクスポート
  if (typeof process !== 'undefined' && process.env && process.env.NODE_ENV === 'test') {
    ext._testReferPopup = {
      isInternalLink,
      buildPreviewContent,
      parseLawLinkText,
      findPrecedingLawName,
      fetchAndPopulateExternalPreview
    };

  }

})(window.egovExt);

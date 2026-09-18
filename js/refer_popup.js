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
   * @param {string} targetId - URL のハッシュ部分
   * @returns {HTMLElement|null} 見つかった要素、なければ null
   */
  function resolveTargetElement(targetId) {
    if (ext.resolveTargetElement) {
      return ext.resolveTargetElement(targetId);
    }
    return document.getElementById(targetId) || document.querySelector(`[name="${targetId}"]`) || null;
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
   * objectId から条・項・号の表示用パス（例: "第2条第2項", "附則第3条", "別表第1"）を生成する
   * @param {string} objectId
   * @returns {string}
   */
  function formatPathFromObjectId(objectId) {
    if (!objectId) return '';
    const cleanId = objectId.replace(/^#/, '');
    const parts = [];

    // 附則（Sp）の判定
    const isSp = /(?:^|[-_])Sp(?:[-_]|$)/.test(cleanId);
    if (isSp) {
      parts.push('附則');
    }

    // 別表（AppdxTable）の判定
    const appdxM = cleanId.match(/(?:^|[-_])AppdxTable_([0-9]+(?:_[0-9]+)*)/);
    if (appdxM) {
      const nums = appdxM[1].split('_');
      const main = '別表第' + nums[0];
      const sub = nums.slice(1).length ? 'の' + nums.slice(1).join('の') : '';
      parts.push(main + sub);
    }

    // 条番号（At_...）の判定
    const atM = cleanId.match(/(?:^|[-_])At_([0-9]+(?:_[0-9]+)*)/);
    if (atM) {
      const atNums = atM[1].split('_');
      const main = '第' + atNums[0] + '条';
      const sub = atNums.slice(1).length ? 'の' + atNums.slice(1).join('の') : '';
      parts.push(main + sub);
    }

    // 項番号（Pr_...）の判定
    const prM = cleanId.match(/(?:^|[-_])Pr_([0-9]+(?:_[0-9]+)*)/);
    if (prM) {
      const prNums = prM[1].split('_');
      const main = '第' + prNums[0] + '項';
      const sub = prNums.slice(1).length ? 'の' + prNums.slice(1).join('の') : '';
      parts.push(main + sub);
    }

    // 号番号（It_...）の判定
    const itM = cleanId.match(/(?:^|[-_])It_([0-9]+(?:_[0-9]+)*)/);
    if (itM) {
      const itNums = itM[1].split('_');
      const main = '第' + itNums[0] + '号';
      const sub = itNums.slice(1).length ? 'の' + itNums.slice(1).join('の') : '';
      parts.push(main + sub);
    }

    return parts.join('');
  }

  /**
   * 同一法令内リンクから参照箇所の表示文字列（例: "第131条第1項第4号", "第27条から第29条まで"）を解決する
   * @param {HTMLElement} targetEl
   * @param {HTMLAnchorElement} [linkEl]
   * @param {string} [targetId]
   * @returns {string}
   */
  function resolveReferenceClausePath(targetEl, linkEl, targetId) {
    const resolvedId = targetId || (targetEl ? (targetEl.id || targetEl.getAttribute('name') || '') : '');
    const idPath = formatPathFromObjectId(resolvedId);
    const rawText = (linkEl ? (linkEl.textContent || '') : '').trim();

    // 1. リンクテキストがない場合はIDからのパスをそのまま使用
    if (!rawText) {
      return idPath;
    }

    // 2. 範囲指定（「〜から〜まで」など）
    const hasRange = /(?:から|至る).*まで/.test(rawText) || /[～〜-]/.test(rawText);
    if (hasRange) {
      // 範囲指定かつ条番号を含んでいる場合（例: 「第二十七条から第二十九条まで」「第２７条から第２９条まで」）
      if (/第[0-9０-９一二三四五六七八九十百千万]+条/.test(rawText)) {
        return rawText;
      }
      // 条番号を含まない範囲指定（例: 「第一項から第三項まで」「第１号から第３号まで」）
      // IDから親条番号（第◯条）を先頭に補完する
      if (idPath) {
        const atMatch = idPath.match(/(?:附則)?第[0-9]+条(?:の[0-9]+)*/);
        if (atMatch) {
          return atMatch[0] + rawText;
        }
      }
      return rawText;
    }

    // 3. 「前条」「次条」「同条」「前項」「次項」「同項」「前号」「次号」「同号」などの相対指定
    // または親条文を含まない単独の「第◯項」「第◯号」の場合
    // 例: 「第十一号」「第三項」「前項」など -> IDからの完全パス（第153条第1項第11号等）を優先
    const isRelativeOrPartial = /^(前条|次条|同条|前項|次項|同項|前号|次号|同号)/.test(rawText) ||
      (/^第[0-9０-９一二三四五六七八九十百千万]+(?:項|号)/.test(rawText) && !/第[0-9０-９一二三四五六七八九十百千万]+条/.test(rawText));

    if (isRelativeOrPartial) {
      return idPath || rawText;
    }

    // 4. リンクテキスト自体が条文を含む完全な表記（例: 「第百三十一条第一項第四号」「第２条第２項」）
    // リンクテキストを優先（リンク元の文脈表現を尊重）
    if (/^第[0-9０-９一二三四五六七八九十百千万]+条/.test(rawText) || /^附則/.test(rawText) || /^別表/.test(rawText)) {
      return rawText;
    }

    // 5. 法令名が前置されている場合（例: 「文化財保護法第１３１条第１項」）
    const lawClauseMatch = rawText.match(/(第[0-9０-９一二三四五六七八九十百千万]+条.*)$/);
    if (lawClauseMatch) {
      return lawClauseMatch[1];
    }

    // 6. フォールバック: IDからのパス、それも無ければリンクテキスト
    return idPath || rawText;
  }

  /**
   * 参照先要素からプレビュー用のDOMを組み立てる。
   *
   * 参照先が `<a name="...">` のアンカーの場合、それ自体には中身が無いため、
   * 次の条見出しや章見出しが現れるまでの兄弟要素をかき集める。
   *
   * @param {HTMLElement} targetEl - 参照先要素
   * @param {HTMLAnchorElement} [linkEl] - リンク要素
   * @param {string} [targetId] - リンク先のハッシュID
   * @returns {HTMLElement} プレビュー内容を格納したDIV
   */
  function buildPreviewContent(targetEl, linkEl, targetId) {
    if (!targetEl) return null;

    const resolvedTargetId = targetId || targetEl.id || targetEl.getAttribute('name') || '';
    const clausePath = resolveReferenceClausePath(targetEl, linkEl, resolvedTargetId);

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

    // ヘッダー（参照条文 ＋ 参照箇所 ＋ ジャンプボタン）
    const header = document.createElement('div');
    header.className = 'egov-ext-tip-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'egov-ext-tip-header-title';
    titleWrap.textContent = clausePath ? `参照条文（${clausePath}）` : '参照条文';
    header.appendChild(titleWrap);

    // ジャンプボタン
    if (ext.createTipActionButton) {
      const btnTargetId = targetEl.id || targetEl.getAttribute('name') || '';

      const jumpBtn = ext.createTipActionButton({
        icon: 'jump',
        label: 'ジャンプ',
        title: 'この条文の場所へ移動',
        targetId: btnTargetId,
        onClick: () => {
          if (ext.referenceTooltip) {
            ext.referenceTooltip.hide(0);
          }
          if (ext.fastSmoothScroll) {
            ext.fastSmoothScroll(targetEl);
          }
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
   * @param {string} [objectId]
   * @returns {{lawName: string, path: string}}
   */
  function parseLawLinkText(a, targetLawId, objectId) {
    if (a && typeof a === 'object' && parsedLawLinkCache.has(a)) {
      return parsedLawLinkCache.get(a);
    }

    const rawText = (a.textContent || '').trim();
    let result;

    // 1. "民法第七百九条", "特定非営利活動促進法（平成１０年法律第７号）第２条第２項" のように法令名（＋法令番号括弧）と条番号が結合している場合
    // 全角数字「０-９」および枝番号「の」、法令番号括弧（（平成...号））に対応
    // "法第５２条第１項" や "令第２条" のように「法」「令」等1文字から始まる略称表記にも対応
    const fullMatch = rawText.match(/^((?:.+?)?(?:法|令|規則|府令|省令|憲法|条約|条例|布告|規程)(?:（[^）]*）|\([^)]*\))?)\s*(第[0-9０-９一二三四五六七八九十百千万]+条.*)?$/);
    if (fullMatch && (fullMatch[2] || fullMatch[1])) {
      result = {
        lawName: fullMatch[1].trim(),
        path: (fullMatch[2] || '').trim()
      };
    } else if (/^第[0-9０-９一二三四五六七八九十百千万]+条/.test(rawText)) {
      // 2. "第七百九条", "第２条第２項" のように条番号のみの場合、直前のテキストから法令名を探す
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

    // path が空かつ objectId が指定されている場合、objectId から条・項・号を自動補完
    if (!result.path && objectId) {
      result.path = formatPathFromObjectId(objectId);
    }

    // 安全ガード: lawName の末尾に path が重複して含まれている場合、重複を除去
    if (result.path && result.lawName) {
      const cleanPath = result.path.trim();
      if (result.lawName.endsWith(cleanPath)) {
        result.lawName = result.lawName.slice(0, -cleanPath.length).trim();
      }
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
   * 参照条文プレビューを無効化（非表示・破棄）する。
   */
  ext.disablePopup = function() {
    if (ext.referenceTooltip) {
      ext.referenceTooltip.hide(true);
      if (ext.referenceTooltip.destroy) {
        ext.referenceTooltip.destroy();
      }
      ext.referenceTooltip = null;
    }
  };

  /**
   * 参照条文プレビューを有効化する。
   * 条文ページ以外（検索結果やトップページ等）では有効化しない。
   */
  ext.enablePopup = function() {
    if (!ext.settings.global || !ext.settings.popup || !(ext.checkIfLawPage && ext.checkIfLawPage())) {
      ext.disablePopup();
      return;
    }
    if (ext.referenceTooltip) return;

    ext.referenceTooltip = ext.createTooltip({ variant: 'reference' });

    ext.bindHoverTooltip({
      selector: 'a[href*="#"], a[href*="/law/"], a[href*="lawId="]',
      tooltip: ext.referenceTooltip,
      isEnabled: () => !!(ext.settings.global && ext.settings.popup && ext.checkIfLawPage && ext.checkIfLawPage()),
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
          const content = buildPreviewContent(targetEl, a, targetId);
          if (ext.settings.horizontal && ext.applyHorizontalConversion) {
            ext.applyHorizontalConversion(content);
          }
          return content;
        }

        // 2. 他法令へのリンク（外部リンク）: API / XML から非同期取得
        if (!targetLawId) return null;

        const objectId = targetId || 'Mp';
        const { lawName, path } = parseLawLinkText(a, targetLawId, objectId);
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
  ext.parseLawLinkText = parseLawLinkText;
  if (typeof process !== 'undefined' && process.env && process.env.NODE_ENV === 'test') {
    ext._testReferPopup = {
      isInternalLink,
      buildPreviewContent,
      formatPathFromObjectId,
      resolveReferenceClausePath,
      parseLawLinkText,
      findPrecedingLawName,
      fetchAndPopulateExternalPreview
    };
  }

})(window.egovExt);

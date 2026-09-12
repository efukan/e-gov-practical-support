/**
 * citation.js
 * 
 * e-Gov法令検索の各条文に対して、他法令からの被引用情報を表示するモジュール。
 * ページ読み込み時に一括でe-Gov内部APIから被引用データを取得・キャッシュし、
 * 被引用データが存在する条文のタイトル横にのみ「被引用」ボタンを挿入します。
 */

window.egovExt = window.egovExt || {};

(function(ext) {
  /**
   * 被引用データのキャッシュ用Map (キー: objectId (例: Mp-At_4), 値: inyo_list 配列)
   * @type {Map<string, Array>}
   */
  ext.citationMap = new Map();

  /**
   * 条文要素を指すセレクタ（大文字・小文字やアンダースコア表記のブレを網羅）
   * @type {string}
   */
  const ARTICLE_SELECTOR = '.Article, ._div_Article, .article, ._div_article, article';

  /**
   * 被引用表示ポップアップのツールチップインスタンス（js/tooltip.js の createTooltip の戻り値）
   * @type {Object|null}
   */
  ext.citationTooltip = null;

  /**
   * 引用元条文のフライアウトプレビュー用ツールチップインスタンス
   * @type {Object|null}
   */
  ext.citationPreviewTooltip = null;

  /**
   * 他法令リビジョン情報のキャッシュ用Map (キー: lawId, 値: { lawDataId, subRevision })
   * @type {Map<string, Object>}
   */
  ext.citationRevisionCache = new Map();

  /**
   * 引用元条文プレビューDOMのキャッシュ用Map (キー: `${lawId}:${objectId}`, 値: HTMLElement)
   * @type {Map<string, HTMLElement>}
   */
  ext.citationPreviewCache = new Map();

  /**
   * 法令XMLドキュメントのキャッシュ用Map (キー: `${lawId}:${asof}`, 値: Document)
   * @type {Map<string, Document>}
   */
  ext.citationXmlCache = new Map();

  /**
   * 現在表示中の法令ID (URLから取得)
   * @type {string|null}
   */
  let currentLawId = null;

  /**
   * 現在ホバー中の引用リンク要素
   * @type {HTMLElement|null}
   */
  let activePreviewLink = null;

  /**
   * 進行中の条文取得Promiseのキャッシュ（通信の重複排除・相乗り用）
   * (キー: `${lawId}:${objectId}`, 値: Promise<HTMLElement|null>)
   * @type {Map<string, Promise<HTMLElement|null>>}
   */
  const inFlightFetches = new Map();

  /**
   * 共通の初期化・適用関数
   */
  ext.enableCitations = async function() {
    if (!ext.settings.global || !ext.settings.citation) {
      ext.disableCitations();
      return;
    }

    const isLawPage = ext.checkIfLawPage();
    if (!isLawPage) return;

    // URLからLawIDを抽出する
    const lawId = ext.getLawIdFromUrl(window.location.href);
    if (!lawId) return;

    setupCitationTooltip();

    // すでに同じLawIDでロード済みの場合は、DOMへのボタン挿入のみ行う
    if (currentLawId === lawId && ext.citationMap.size > 0) {
      insertCitationButtons();
      return;
    }

    currentLawId = lawId;
    ext.citationMap.clear();

    try {
      // 1. DOMから全条文のObjectIdを収集する
      const objectIds = collectArticleObjectIds();
      if (objectIds.length === 0) return;

      // 2. 内部APIを叩いてデータを一括取得する
      const inyoDataList = await fetchInyoData(lawId, objectIds);
      if (!inyoDataList || inyoDataList.length === 0) return;

      // 3. キャッシュに登録する
      for (let i = 0; i < inyoDataList.length; i++) {
        const item = inyoDataList[i];
        if (item.selText && item.inyo_list && item.inyo_list.length > 0) {
          ext.citationMap.set(item.selText, item.inyo_list);
        }
      }

      // 4. データが存在する条文にのみ「被引用」ボタンを挿入する
      insertCitationButtons();
    } catch (e) {
      console.error("egov-ext: Error enabling citations:", e);
    }
  };

  /**
   * 追加した被引用ボタンやポップアップを画面から消去し、機能を完全に停止する関数
   */
  ext.disableCitations = function() {
    // ボタン削除に伴うMutationObserverの不要発火を防止
    const wasObserving = ext.globalDOMObserver !== null && ext.globalDOMObserver !== undefined;
    if (wasObserving) {
      ext.globalDOMObserver.disconnect();
    }

    try {
      // 挿入したボタンを削除
      const buttons = ext.deepQuerySelectorAll(document.body, '.egov-ext-citation-btn');
      buttons.forEach(btn => btn.remove());
    } finally {
      if (wasObserving && ext.reconnectDOMObserver) {
        ext.reconnectDOMObserver();
      }
    }

    // ポップアップを閉じる（インスタンス自体は再利用するため破棄しない）
    if (ext.citationTooltip) {
      ext.citationTooltip.hide(true);
    }
    if (ext.citationPreviewTooltip) {
      ext.citationPreviewTooltip.hide(true);
    }

    ext.citationMap.clear();
    ext.citationPreviewCache.clear();
    ext.citationXmlCache.clear();
    inFlightFetches.clear();
    activePreviewLink = null;
    currentLawId = null;
  };

  /**
   * 法令本文のDOMから、本則の各条文のObjectId（ID属性値）を収集する関数
   * @returns {Array<string>} ObjectIdの配列
   */
  function collectArticleObjectIds() {
    const objectIds = [];
    const container = ext.getLawContainer();

    // 本則の条文要素 (大文字・小文字、タグ名やアンダースコア表記のブレを網羅して広く探索)
    const articles = ext.deepQuerySelectorAll(container, ARTICLE_SELECTOR);
    articles.forEach(el => {
      if (el.id) {
        objectIds.push(el.id);
      }
    });

    return objectIds;
  }

  /**
   * e-Govの内部APIを叩いて、被引用データを一括取得する非同期関数
   * @param {string} lawId - 法令ID
   * @param {Array<string>} objectIds - 収集したObjectIdの配列
   * @returns {Promise<Array>} 被引用データの配列
   */
  async function fetchInyoData(lawId, objectIds) {
    try {
      // API 1: revision情報の取得
      const revRes = await fetch('https://laws.e-gov.go.jp/internal-api/SelectLawRevisionData.json', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/plain, */*'
        },
        body: JSON.stringify({ law_id: lawId })
      });
      if (!revRes.ok) throw new Error(`SelectLawRevisionData failed with status ${revRes.status}`);
      const revData = await revRes.json();
      
      const revisionList = revData.result.revision_list || revData.result.Amendment_History;
      if (!revData || !revData.result || !revisionList || revisionList.length === 0) {
        return null;
      }

      // 現在施行されているリビジョンを取得 (無ければ最初の要素を使用)
      const currentRevision = revisionList.find(r => r.IsCurrentEnforcement || r.isCurrentEnforcement) || revisionList[0];
      const lawDataId = currentRevision.law_data_id || currentRevision.LawDataId;
      const subRevision = currentRevision.subRevision || currentRevision.SubRevision;

      // 日付の取得 (YYYY/MM/DD形式)
      const date = new Date();
      const occasion = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;

      // API 2: 被引用データの一括取得
      const inyoRes = await fetch('https://laws.e-gov.go.jp/internal-api/SelectInyoLawData.json', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/plain, */*'
        },
        body: JSON.stringify({
          law_data_id: lawDataId,
          subRevision: subRevision,
          occasion: occasion,
          selTextList: objectIds
        })
      });
      if (!inyoRes.ok) throw new Error(`SelectInyoLawData failed with status ${inyoRes.status}`);
      const inyoData = await inyoRes.json();

      if (inyoData && inyoData.result && inyoData.result.success) {
        return inyoData.result.inyo_data || [];
      }
    } catch (e) {
      console.error("egov-ext: Failed to fetch inyo data:", e);
    }
    return null;
  }

  /**
   * 被引用データが存在する条文タイトル（見出し）の直後に「被引用」ボタンを挿入する関数
   */
  function insertCitationButtons() {
    const container = ext.getLawContainer();

    // ボタンの一括挿入に伴うMutationObserverのカスケード発火（全ボタンへの不要走査）を完全に防止する
    const wasObserving = ext.globalDOMObserver !== null && ext.globalDOMObserver !== undefined;
    if (wasObserving) {
      ext.globalDOMObserver.disconnect();
    }

    try {
      const articles = ext.deepQuerySelectorAll(container, ARTICLE_SELECTOR);
      articles.forEach(articleEl => {
        const objectId = articleEl.id;
        if (!objectId || !ext.citationMap.has(objectId)) return;

        // すでにボタンが挿入されているかチェック
        if (articleEl.querySelector('.egov-ext-citation-btn')) return;

        // 条文のタイトル要素 (例: 「第１条」など) を探す (大文字・小文字・ハイフン表記等のバリエーションを網羅)
        const titleEl = articleEl.querySelector('.ArticleTitle, ._div_ArticleTitle, .articletitle, ._div_articletitle, .article-title, .paragraph-title, .paragraphtitle');
        if (!titleEl) return;

        // ボタン要素の作成 (イベントはグローバルデリゲーションで処理するため貼らない)
        const btn = document.createElement('button');
        btn.className = 'egov-ext-citation-btn';
        btn.type = 'button';
        btn.title = 'この条文の被引用法令一覧を表示';
        btn.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"/></svg>引用`;

        // タイトルの直後に挿入 (インライン)
        // 公職選挙法などのように、_div_ArticleTitle の中に本文が同居しているケースに対応するため、
        // 内部の最初の span (「第一条」等の条数ラベル) の直後に挿入を試みる。
        const labelSpan = titleEl.querySelector('span');
        if (labelSpan && labelSpan.parentNode === titleEl) {
          labelSpan.parentNode.insertBefore(btn, labelSpan.nextSibling);
        } else {
          titleEl.appendChild(btn);
        }
      });
    } finally {
      if (wasObserving && ext.reconnectDOMObserver) {
        ext.reconnectDOMObserver();
      }
    }
  }

  /**
   * 被引用ポップアップおよびフライアウトプレビューを共通ツールチップ基盤に登録する（初回のみ）。
   */
  function setupCitationTooltip() {
    if (ext.citationTooltip) return;

    ext.citationTooltip = ext.createTooltip({ variant: 'citation' });
    ext.citationPreviewTooltip = ext.createTooltip({
      variant: 'preview',
      placement: 'side',
      parent: ext.citationTooltip,
      showDelay: 300,
      hideDelay: 380
    });

    ext.bindHoverTooltip({
      selector: '.egov-ext-citation-btn',
      tooltip: ext.citationTooltip,
      isEnabled: () => !!(ext.settings.global && ext.settings.citation),
      resolveContent: (btn) => {
        const articleEl = btn.closest(ARTICLE_SELECTOR);
        if (!articleEl || !articleEl.id) return null;

        const inyoList = ext.citationMap.get(articleEl.id);
        if (!inyoList || inyoList.length === 0) return null;

        // 親条文のタイトル（例: 「第２条」など）を取得してプレビュー内のハイライトに活用
        const titleEl = articleEl.querySelector('.ArticleTitle, ._div_ArticleTitle, .articletitle, ._div_articletitle, .article-title, .paragraph-title, .paragraphtitle');
        const parentTitle = titleEl ? titleEl.textContent.trim() : '';

        const frag = buildCitationList(inyoList, parentTitle);
        // 一覧ポップアップが開いた直後に先頭数件をバックグラウンド先行取得（プリフェッチ）
        prefetchCitationArticles(frag, parentTitle);
        return frag;
      }
    });

    activePreviewLink = null;

    // 被引用一覧内の各リンクへのホバーによるフライアウト条文プレビュー表示
    ext.citationTooltip.el.addEventListener('mouseover', (e) => {
      const link = e.target.closest('.egov-ext-citation-link');
      if (!link) return;

      // 既に同じリンク上でホバー処理中なら何もしない（子要素間移動のバブリング重複防止）
      if (activePreviewLink === link) return;

      const lawId = link.dataset.lawId;
      const objectId = link.dataset.objectId;
      if (!lawId || !objectId) return;

      activePreviewLink = link;
      ext.citationPreviewTooltip.cancelHide();
      handleLinkHover(link);
    });

    ext.citationTooltip.el.addEventListener('mouseout', (e) => {
      const link = e.target.closest('.egov-ext-citation-link');
      if (!link) return;

      const related = e.relatedTarget;
      // 移動先が同じリンクの内部なら、リンクから離れていないので何もしない！
      if (related && (related === link || link.contains(related))) return;

      // 移動先が子ツールチップ（プレビュー）なら閉じない
      const previewEl = ext.citationPreviewTooltip ? ext.citationPreviewTooltip.el : null;
      if (related && previewEl && (related === previewEl || previewEl.contains(related))) return;

      if (activePreviewLink === link) {
        activePreviewLink = null;
      }

      if (ext.citationPreviewTooltip) {
        ext.citationPreviewTooltip.hide();
      }
    });
  }

  /**
   * キャッシュまたは進行中のリクエストから条文プレビューDOMを取得する。
   * 同一条文への重複通信を完全に排除し、先行するPromiseがあれば自動で相乗りする。
   * @param {string} lawId
   * @param {string} objectId
   * @param {string} parentTitle
   * @param {string} lawName
   * @param {string} path
   * @param {string} enforcementDate
   * @returns {Promise<HTMLElement|null>}
   */
  async function getOrFetchArticlePreview(lawId, objectId, parentTitle, lawName, path, enforcementDate) {
    const cacheKey = `${lawId}:${objectId}`;

    // 1. 完了済みキャッシュがある場合
    if (ext.citationPreviewCache.has(cacheKey)) {
      return ext.citationPreviewCache.get(cacheKey);
    }

    // 2. 現在通信中のPromiseがある場合、その完了を待つ（重複リクエスト排除・相乗り）
    if (inFlightFetches.has(cacheKey)) {
      return await inFlightFetches.get(cacheKey);
    }

    // 3. 新規通信を開始し、Promiseを登録
    const fetchPromise = (async () => {
      try {
        const dom = await fetchAndBuildArticlePreview(lawId, objectId, parentTitle, lawName, path, enforcementDate);
        if (dom) {
          ext.citationPreviewCache.set(cacheKey, dom);
        }
        return dom;
      } finally {
        inFlightFetches.delete(cacheKey);
      }
    })();

    inFlightFetches.set(cacheKey, fetchPromise);
    return await fetchPromise;
  }
  ext.getOrFetchArticlePreview = getOrFetchArticlePreview;

  /**
   * 被引用一覧の各リンクの条文をバックグラウンドで先行取得（プリフェッチ）する。
   * ユーザーの初回ホバーの通信帯域を阻害しないよう、少しディレイを置いてから順次取得を開始する。
   * @param {DocumentFragment|HTMLElement} container
   * @param {string} parentTitle
   */
  function prefetchCitationArticles(container, parentTitle) {
    const links = container.querySelectorAll('.egov-ext-citation-link');
    const limit = Math.min(5, links.length);
    for (let i = 0; i < limit; i++) {
      const link = links[i];
      const lawId = link.dataset.lawId;
      const objectId = link.dataset.objectId;
      const enforcementDate = link.dataset.enforcementDate || '';
      const lawName = link.dataset.lawName || '';
      const path = link.dataset.path || '';
      const cacheKey = `${lawId}:${objectId}`;

      if (!lawId || !objectId || ext.citationPreviewCache.has(cacheKey) || inFlightFetches.has(cacheKey)) continue;

      setTimeout(async () => {
        try {
          await getOrFetchArticlePreview(lawId, objectId, parentTitle, lawName, path, enforcementDate);
        } catch (e) {
          // プリフェッチの失敗は無視（ホバー時に再試行される）
        }
      }, 150 + i * 100);
    }
  }

  /**
   * 被引用法令一覧のDOMを組み立てる。
   * @param {Array<Object>} inyoList - 被引用データの配列
   * @param {string} parentTitle - 引用元の親条文タイトル
   * @returns {DocumentFragment}
   */
  function buildCitationList(inyoList, parentTitle) {
    const frag = document.createDocumentFragment();

    const header = document.createElement('div');
    header.className = 'egov-ext-tip-header';
    header.textContent = '被引用法令一覧';
    frag.appendChild(header);

    const list = document.createElement('ul');
    list.className = 'egov-ext-citation-list';

    inyoList.forEach(item => {
      const li = document.createElement('li');

      const link = document.createElement('a');
      link.className = 'egov-ext-citation-link';
      link.href = `https://laws.e-gov.go.jp${item.url || ''}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';

      // 条文プレビュー用のメタデータを保持
      let objectId = '';
      if (item.url) {
        const hashIdx = item.url.indexOf('#');
        if (hashIdx !== -1) {
          objectId = item.url.substring(hashIdx + 1);
        }
      }
      let enforcementDate = item.enforcement_date || item.scheduled_enforcement_date || '';
      if (!enforcementDate && item.url) {
        const dateMatch = item.url.match(/\/([0-9]{4})([0-9]{2})([0-9]{2})_/);
        if (dateMatch) {
          enforcementDate = `${dateMatch[1]}/${dateMatch[2]}/${dateMatch[3]}`;
        }
      }
      link.dataset.lawId = item.law_id || '';
      link.dataset.objectId = objectId;
      link.dataset.enforcementDate = enforcementDate;
      link.dataset.lawName = item.law_name || '';
      link.dataset.path = item.path || '';
      link.dataset.parentTitle = parentTitle || '';

      const lawName = document.createElement('span');
      lawName.className = 'egov-ext-citation-lawname';
      lawName.textContent = item.law_name || '';
      link.appendChild(lawName);

      const path = document.createElement('span');
      path.className = 'egov-ext-citation-path';
      path.textContent = item.path || '';
      link.appendChild(path);

      li.appendChild(link);
      list.appendChild(li);
    });

    frag.appendChild(list);
    return frag;
  }

  /**
   * 被引用リンクにホバーした際に条文プレビューを表示する処理
   * @param {HTMLAnchorElement} link
   */
  async function handleLinkHover(link) {
    const lawId = link.dataset.lawId;
    const objectId = link.dataset.objectId;
    const enforcementDate = link.dataset.enforcementDate || '';
    const lawName = link.dataset.lawName || '';
    const path = link.dataset.path || '';
    const parentTitle = link.dataset.parentTitle || '';
    const cacheKey = `${lawId}:${objectId}`;

    ext.attachTooltip(ext.citationPreviewTooltip);

    // 1. キャッシュが存在する場合、即時表示
    if (ext.citationPreviewCache.has(cacheKey)) {
      const cachedDOM = ext.citationPreviewCache.get(cacheKey);
      ext.citationPreviewTooltip.show(link, cachedDOM.cloneNode(true), false);
      return;
    }

    // 2. キャッシュが無い場合、ローディング表示をセットして表示予約
    const loadingFrag = createLoadingView(lawName, path, link.href);
    ext.citationPreviewTooltip.show(link, loadingFrag, false);

    // 3. データを非同期取得（先行通信があれば重複リクエストせず自動相乗り）
    try {
      const previewDOM = await getOrFetchArticlePreview(lawId, objectId, parentTitle, lawName, path, enforcementDate);
      if (!previewDOM) throw new Error('条文データを取得できませんでした');

      // まだこのリンクにユーザーが注目している場合（ホバー中またはツールチップ表示中）
      const isTargetActive = (activePreviewLink === link) || 
        (ext.citationPreviewTooltip.anchor === link && ext.citationPreviewTooltip.el.classList.contains('visible'));

      if (isTargetActive) {
        if (ext.citationPreviewTooltip.el.classList.contains('visible')) {
          ext.citationPreviewTooltip.update(previewDOM.cloneNode(true));
        } else {
          // まだディレイ待機中（または未表示）だった場合は即座にプレビューを表示
          ext.citationPreviewTooltip.show(link, previewDOM.cloneNode(true), true);
        }
      }
    } catch (err) {
      const isTargetActive = (activePreviewLink === link) || 
        (ext.citationPreviewTooltip.anchor === link && ext.citationPreviewTooltip.el.classList.contains('visible'));

      if (isTargetActive) {
        const errorFrag = createErrorView(lawName, path, err.message, link.href);
        if (ext.citationPreviewTooltip.el.classList.contains('visible')) {
          ext.citationPreviewTooltip.update(errorFrag);
        } else {
          ext.citationPreviewTooltip.show(link, errorFrag, true);
        }
      }
    }

  }

  /**
   * e-Gov 公式 API v2（law_file/xml）から法令XMLを取得し、パース済み Document を返す
   * @param {string} lawId
   * @param {string} enforcementDate - YYYY/MM/DD 形式
   * @returns {Promise<Document|null>}
   */
  async function fetchLawXmlDocument(lawId, enforcementDate) {
    if (!lawId) return null;
    const asof = enforcementDate ? enforcementDate.replace(/\//g, '-') : '';
    const cacheKey = `${lawId}:${asof}`;

    if (ext.citationXmlCache.has(cacheKey)) {
      return ext.citationXmlCache.get(cacheKey);
    }

    const url = asof
      ? `https://laws.e-gov.go.jp/api/2/law_file/xml/${encodeURIComponent(lawId)}?asof=${encodeURIComponent(asof)}`
      : `https://laws.e-gov.go.jp/api/2/law_file/xml/${encodeURIComponent(lawId)}`;

    try {
      const res = await fetch(url, {
        headers: { 'Accept': 'application/xml, text/xml, */*' }
      });
      if (!res.ok) return null;
      const xmlText = await res.text();
      const parser = new (window.DOMParser || DOMParser)();
      const doc = parser.parseFromString(xmlText, 'text/xml');
      if (doc.querySelector('parsererror')) {
        return null;
      }
      ext.citationXmlCache.set(cacheKey, doc);
      return doc;
    } catch (e) {
      console.warn('egov-ext: Failed to fetch law XML:', e);
      return null;
    }
  }

  /**
   * 法令XMLドキュメントから目的の条文ノード（<Article> または単文法令の <Paragraph>）を特定する
   * @param {Document} xmlDoc
   * @param {string} objectId
   * @param {string} path
   * @returns {Element|null}
   */
  function findTargetArticleNodeInXml(xmlDoc, objectId, path) {
    if (!xmlDoc) return null;

    // 1. objectId から条番号（Num属性）を抽出して照合
    // 例: "Mp-At_4" -> "4", "Mp-At_1_2" -> "1_2", "Mp-Ch_3-At_20" -> "20"
    const atMatch = (objectId || '').match(/At_([0-9_]+)/);
    if (atMatch) {
      const numAttr = atMatch[1];
      const target = xmlDoc.querySelector(`Article[Num="${numAttr}"]`);
      if (target) return target;
    }

    // 2. path（例: "第四条", "第一条の二" など）から ArticleTitle のテキスト照合
    const cleanPath = (path || '').trim();
    if (cleanPath) {
      const articles = xmlDoc.querySelectorAll('Article');
      for (let i = 0; i < articles.length; i++) {
        const titleEl = articles[i].querySelector(':scope > ArticleTitle');
        if (titleEl) {
          const tText = titleEl.textContent.trim();
          if (tText === cleanPath || cleanPath.includes(tText) || tText.includes(cleanPath)) {
            return articles[i];
          }
        }
      }
    }

    // 3. 条文番号のない単文法令（Paragraph直接型）の場合
    const articlesCount = xmlDoc.querySelectorAll('Article').length;
    if (articlesCount === 0) {
      const singlePara = xmlDoc.querySelector('MainProvision > Paragraph') || xmlDoc.querySelector('Paragraph');
      if (singlePara) return singlePara;
    }

    return null;
  }

  /**
   * XMLの条文ノード（<Article> または <Paragraph>）を
   * renderArticlePreview が受け取れる Content 構造化オブジェクトに変換する
   * @param {Element} node
   * @returns {Object|null}
   */
  function xmlNodeToContent(node) {
    if (!node) return null;

    const lawTitleNode = node.ownerDocument ? node.ownerDocument.querySelector('LawTitle') : null;
    const lawTitle = lawTitleNode ? lawTitleNode.textContent.trim() : '';

    // 単文法令（Paragraph直接型）の場合
    if (node.tagName.toLowerCase() === 'paragraph') {
      const pSentenceNode = node.querySelector(':scope > ParagraphSentence');
      const sentences = pSentenceNode
        ? Array.from(pSentenceNode.querySelectorAll(':scope > Sentence')).map(s => ({ '#text': s.textContent }))
        : [];
      return {
        LawTitle: lawTitle,
        Paragraph: [
          {
            ParagraphNum: '',
            ParagraphSentence: { Sentence: sentences }
          }
        ]
      };
    }

    // 通常の <Article> の場合
    const content = {
      LawTitle: lawTitle
    };

    const captionNode = node.querySelector(':scope > ArticleCaption');
    if (captionNode) {
      content.ArticleCaption = captionNode.textContent.trim();
    }

    const titleNode = node.querySelector(':scope > ArticleTitle');
    if (titleNode) {
      content.ArticleTitle = titleNode.textContent.trim();
    }

    const paragraphNodes = node.querySelectorAll(':scope > Paragraph');
    if (paragraphNodes.length > 0) {
      content.Paragraph = Array.from(paragraphNodes).map(pNode => {
        const pObj = {};
        const numNode = pNode.querySelector(':scope > ParagraphNum');
        pObj.ParagraphNum = numNode ? numNode.textContent.trim() : '';

        const pSentenceNode = pNode.querySelector(':scope > ParagraphSentence');
        if (pSentenceNode) {
          pObj.ParagraphSentence = {
            Sentence: Array.from(pSentenceNode.querySelectorAll(':scope > Sentence')).map(s => ({
              '#text': s.textContent
            }))
          };
        }

        // Item（号）
        const itemNodes = pNode.querySelectorAll(':scope > Item');
        if (itemNodes.length > 0) {
          pObj.Item = Array.from(itemNodes).map(itNode => {
            const itObj = {};
            const itTitle = itNode.querySelector(':scope > ItemTitle');
            if (itTitle) itObj.ItemTitle = itTitle.textContent.trim();

            const itSentence = itNode.querySelector(':scope > ItemSentence');
            if (itSentence) {
              itObj.ItemSentence = {
                Sentence: Array.from(itSentence.querySelectorAll(':scope > Sentence')).map(s => ({
                  '#text': s.textContent
                }))
              };
            }

            // Subitem1（イ、ロ、ハ...）
            const sub1Nodes = itNode.querySelectorAll(':scope > Subitem1');
            if (sub1Nodes.length > 0) {
              itObj.Subitem1 = Array.from(sub1Nodes).map(sub1Node => {
                const sub1Obj = {};
                const s1Title = sub1Node.querySelector(':scope > Subitem1Title');
                if (s1Title) sub1Obj.Subitem1Title = s1Title.textContent.trim();

                const s1Sentence = sub1Node.querySelector(':scope > Subitem1Sentence');
                if (s1Sentence) {
                  sub1Obj.Subitem1Sentence = {
                    Sentence: Array.from(s1Sentence.querySelectorAll(':scope > Sentence')).map(s => ({
                      '#text': s.textContent
                    }))
                  };
                }

                // Subitem2（（１）、（２）...）
                const sub2Nodes = sub1Node.querySelectorAll(':scope > Subitem2');
                if (sub2Nodes.length > 0) {
                  sub1Obj.Subitem2 = Array.from(sub2Nodes).map(sub2Node => {
                    const sub2Obj = {};
                    const s2Title = sub2Node.querySelector(':scope > Subitem2Title');
                    if (s2Title) sub2Obj.Subitem2Title = s2Title.textContent.trim();

                    const s2Sentence = sub2Node.querySelector(':scope > Subitem2Sentence');
                    if (s2Sentence) {
                      sub2Obj.Subitem2Sentence = {
                        Sentence: Array.from(s2Sentence.querySelectorAll(':scope > Sentence')).map(s => ({
                          '#text': s.textContent
                        }))
                      };
                    }
                    return sub2Obj;
                  });
                }

                return sub1Obj;
              });
            }

            return itObj;
          });
        }

        return pObj;
      });
    }

    return content;
  }

  /**
   * XML APIから条文を取得してプレビューDOMを生成するフォールバック処理
   * @param {string} lawId
   * @param {string} objectId
   * @param {string} parentTitle
   * @param {string} lawName
   * @param {string} path
   * @param {string} enforcementDate
   * @returns {Promise<HTMLElement|null>}
   */
  async function fetchArticlePreviewFromXml(lawId, objectId, parentTitle, lawName, path, enforcementDate, targetUrl) {
    const xmlDoc = await fetchLawXmlDocument(lawId, enforcementDate);
    if (!xmlDoc) return null;

    const targetNode = findTargetArticleNodeInXml(xmlDoc, objectId, path);
    if (!targetNode) return null;

    const content = xmlNodeToContent(targetNode);
    if (!content) return null;

    const highlightTerms = extractHighlightTerms(parentTitle);
    return renderArticlePreview(content, highlightTerms, lawName, path, targetUrl);
  }

  /**
   * 条文テキストを取得しプレビュー用DOMを生成する統合関数。
   * まず軽量な e-Gov内部API（SelectInyoLawTextData.json）を試し、
   * HTML形式法令（isHTML: true）や未対応・エラー法令の場合は自動で公式XML API（law_file/xml）へフォールバックします。
   */
  async function fetchAndBuildArticlePreview(lawId, objectId, parentTitle, lawName, path, enforcementDate) {
    const date = new Date();
    const occasion = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;
    const targetUrl = 'https://laws.e-gov.go.jp/law/' + encodeURIComponent(lawId) + (objectId ? '#' + objectId : '');

    let isHtmlLaw = false;

    // 1. 軽量な SelectInyoLawTextData.json を試行
    try {
      const textRes = await fetch('https://laws.e-gov.go.jp/internal-api/SelectInyoLawTextData.json', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/plain, */*'
        },
        body: JSON.stringify({
          law_id: lawId,
          occasion: occasion,
          enforcement_date: enforcementDate || occasion,
          objectID: objectId
        })
      });

      if (textRes.ok) {
        const data = await textRes.json();
        if (data && data.result && data.result.success && data.result.inyo_text_data) {
          const inyoTextData = data.result.inyo_text_data;
          if (inyoTextData.isHTML) {
            isHtmlLaw = true;
          } else {
            const inyoArray = inyoTextData.InyoResult_array || [];
            if (inyoArray.length > 0) {
              const target = findTargetArticle(inyoArray, objectId, path);
              if (target && target.Content) {
                if (inyoTextData.LawTitle && !target.Content.LawTitle) {
                  target.Content.LawTitle = inyoTextData.LawTitle;
                }
                const highlightTerms = extractHighlightTerms(parentTitle);
                return renderArticlePreview(target.Content, highlightTerms, lawName, path, targetUrl);
              }
            }
          }
        }
      }
    } catch (e) {
      // 内部APIの失敗・JSONエラー時は XML フォールバックへ
    }

    // 2. 公式XML API（law_file/xml）へのフォールバック（HTML形式法令・JSON未対応法令の救済）
    try {
      const xmlPreviewDOM = await fetchArticlePreviewFromXml(lawId, objectId, parentTitle, lawName, path, enforcementDate, targetUrl);
      if (xmlPreviewDOM) {
        return xmlPreviewDOM;
      }
    } catch (e) {
      console.warn('egov-ext: XML fallback failed:', e);
    }

    // 3. XMLからも取得できなかった場合
    if (isHtmlLaw) {
      return createHtmlNoticeView(lawName, path, targetUrl);
    }
    return null;
  }


  /**
   * 被引用条文一覧（InyoResult_array）から、目的の条文要素を特定する。
   * 階層構造（Chapter, Section）によるプレフィックスの違いや条タイトル・番号を柔軟に照合する。
   */
  function findTargetArticle(inyoArray, objectId, path) {
    if (!inyoArray || inyoArray.length === 0) return null;
    const cleanId = (objectId || '').replace(/^#/, '');

    // 1. ObjectId 完全一致
    let target = inyoArray.find(x => {
      const xId = (x.ObjectId || '').replace(/^#/, '');
      return xId === cleanId;
    });
    if (target && target.Content) return target;

    // 2. 階層ObjectId（#Mp-Ch_3-At_20, #Sp-At_1 など）の後方一致
    target = inyoArray.find(x => {
      const xId = (x.ObjectId || '').replace(/^#/, '');
      return xId.endsWith('-' + cleanId) || (cleanId.startsWith('Mp-') && xId.endsWith(cleanId.slice(3))) || (cleanId.startsWith('Sp-') && xId.endsWith(cleanId.slice(3)));
    });
    if (target && target.Content) return target;

    // 3. ArticleTitle と path の完全一致（例: "第二十条" === "第二十条"）
    target = inyoArray.find(x => x.Content && x.Content.ArticleTitle && x.Content.ArticleTitle === path);
    if (target && target.Content) return target;

    // 4. path が ArticleTitle を含む場合（例: "第二十条第一項" と "第二十条"）
    target = inyoArray.find(x => {
      const type = x.type || x.Type;
      return type === 'Article' && path && x.Content?.ArticleTitle && path.includes(x.Content.ArticleTitle);
    });
    if (target && target.Content) return target;

    // 5. Article要素の優先フォールバック
    target = inyoArray.find(x => {
      const type = x.type || x.Type;
      return type === 'Article' && x.Content;
    });
    if (target && target.Content) return target;

    // 6. 単文法令（条文番号がなく本則・項が直接書かれている法令）のフォールバック
    target = inyoArray.find(x => x.Content && (x.Content.Paragraph || x.Content.ParagraphSentence));
    if (target && target.Content) return target;

    // 7. 最終フォールバック
    return inyoArray[0] || null;
  }

  /**
   * 親条文タイトルから検索・ハイライト用の用語リストを生成
   * 例: "第２条" → ["第二条", "第２条", "第2条"]
   * 例: "第六十七条の十五の二" → ["第六十七条の十五の二", "第６７条の１５の２", "第67条の15の2"]
   */
  function extractHighlightTerms(parentTitle) {
    if (!parentTitle) return [];
    const match = parentTitle.match(/第([一二三四五六七八九十百千万0-9０-９]+)条((?:の[一二三四五六七八九十百千万0-9０-９]+)*)/);
    if (!match) {
      return [parentTitle.trim()].filter(Boolean);
    }

    const fullMatched = match[0];
    const mainNumStr = match[1];
    const branchPart = match[2] || '';
    const branchTokens = branchPart ? branchPart.split('の').filter(Boolean) : [];

    const terms = new Set();
    terms.add(fullMatched);

    try {
      function getRepresentations(numStr) {
        const isDigits = /^[0-9０-９]+$/.test(numStr);
        let half = '';
        let full = '';
        let kanji = '';

        if (isDigits) {
          half = ext.toHalfWidthArabic ? ext.toHalfWidthArabic(numStr) : numStr;
          full = ext.toFullWidthArabic ? ext.toFullWidthArabic(half) : numStr;
          kanji = convertDigitsToKanji(half);
        } else {
          half = ext.kanjiToArabic ? ext.kanjiToArabic(numStr) : numStr;
          full = ext.toFullWidthArabic ? ext.toFullWidthArabic(half) : half;
          kanji = numStr;
        }
        return { half, full, kanji };
      }

      const mainReps = getRepresentations(mainNumStr);
      const branchReps = branchTokens.map(t => getRepresentations(t));

      // 1. 漢数字組み合わせ
      const kanjiCombined = `第${mainReps.kanji}条${branchReps.map(b => 'の' + b.kanji).join('')}`;
      terms.add(kanjiCombined);
      if (kanjiCombined.includes('千')) {
        terms.add(kanjiCombined.replace(/千/g, '一千'));
        terms.add(kanjiCombined.replace(/一千/g, '千'));
      }

      // 2. 全角アラビア数字組み合わせ
      const fullCombined = `第${mainReps.full}条${branchReps.map(b => 'の' + b.full).join('')}`;
      terms.add(fullCombined);

      // 3. 半角アラビア数字組み合わせ
      const halfCombined = `第${mainReps.half}条${branchReps.map(b => 'の' + b.half).join('')}`;
      terms.add(halfCombined);

    } catch (e) {
      // フォールバック
    }

    return Array.from(terms).filter(t => t && t.length >= 2);
  }

  function convertDigitsToKanji(str) {
    return str.replace(/[0-9０-９]+/g, (m) => {
      const half = ext.toHalfWidthArabic ? ext.toHalfWidthArabic(m) : m;
      const num = parseInt(half, 10);
      if (isNaN(num)) return m;
      return arabicToKanjiNumber(num);
    });
  }

  function arabicToKanjiNumber(n) {
    if (n <= 0) return String(n);
    const kanjiDigits = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
    if (n < 10) return kanjiDigits[n];
    if (n < 100) {
      const tens = Math.floor(n / 10);
      const ones = n % 10;
      return (tens === 1 ? '' : kanjiDigits[tens]) + '十' + kanjiDigits[ones];
    }
    if (n < 1000) {
      const hundreds = Math.floor(n / 100);
      const rest = n % 100;
      const tens = Math.floor(rest / 10);
      const ones = rest % 10;
      let res = (hundreds === 1 ? '' : kanjiDigits[hundreds]) + '百';
      if (tens > 0) res += (tens === 1 ? '' : kanjiDigits[tens]) + '十';
      if (ones > 0) res += kanjiDigits[ones];
      return res;
    }
    if (n < 10000) {
      const thousands = Math.floor(n / 1000);
      const rest = n % 1000;
      const hundreds = Math.floor(rest / 100);
      const rest2 = rest % 100;
      const tens = Math.floor(rest2 / 10);
      const ones = rest2 % 10;
      let res = (thousands === 1 ? '千' : kanjiDigits[thousands] + '千');
      if (hundreds > 0) res += (hundreds === 1 ? '' : kanjiDigits[hundreds]) + '百';
      if (tens > 0) res += (tens === 1 ? '' : kanjiDigits[tens]) + '十';
      if (ones > 0) res += kanjiDigits[ones];
      return res;
    }
    return String(n);
  }

  function stripHtmlTags(str) {
    if (!str) return '';
    return str.replace(/<[^>]*>/g, '');
  }

  /**
   * テキスト内のキーワードをハイライト（<mark>）したDocumentFragmentを生成
   */
  function highlightTextNode(text, terms) {
    if (!terms || terms.length === 0 || !text) {
      return document.createTextNode(text);
    }
    const escaped = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).filter(Boolean);
    if (escaped.length === 0) return document.createTextNode(text);

    const regex = new RegExp(`(${escaped.join('|')})`, 'g');
    const frag = document.createDocumentFragment();
    let lastIdx = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIdx) {
        frag.appendChild(document.createTextNode(text.substring(lastIdx, match.index)));
      }
      const mark = document.createElement('mark');
      mark.className = 'egov-ext-citation-highlight';
      mark.textContent = match[0];
      frag.appendChild(mark);
      lastIdx = regex.lastIndex;
    }
    if (lastIdx < text.length) {
      frag.appendChild(document.createTextNode(text.substring(lastIdx)));
    }
    return frag;
  }

  /**
   * 文章（Sentence構造）からテキストを抽出してDOMに変換
   */
  function parseSentenceToDOM(sentenceContainer, terms) {
    const frag = document.createDocumentFragment();
    if (!sentenceContainer) return frag;

    if (typeof sentenceContainer === 'string') {
      const cleanText = stripHtmlTags(sentenceContainer);
      if (cleanText) {
        frag.appendChild(highlightTextNode(cleanText, terms));
      }
      return frag;
    }

    const sentences = Array.isArray(sentenceContainer.Sentence)
      ? sentenceContainer.Sentence
      : (sentenceContainer.Sentence ? [sentenceContainer.Sentence] : (Array.isArray(sentenceContainer) ? sentenceContainer : []));

    for (const s of sentences) {
      if (!s) continue;
      if (typeof s === 'string') {
        const cleanText = stripHtmlTags(s);
        if (cleanText) {
          frag.appendChild(highlightTextNode(cleanText, terms));
        }
        continue;
      }
      let fullText = '';
      if (s['#childs']) {
        for (const c of s['#childs']) {
          if (c['#text']) fullText += c['#text'];
        }
      } else if (s['#text']) {
        fullText += s['#text'];
      }
      const cleanText = stripHtmlTags(fullText);
      if (cleanText) {
        frag.appendChild(highlightTextNode(cleanText, terms));
      }
    }
    return frag;
  }

  /**
   * 条文構造化JSONからプレビュー用DOM要素を生成
   */
  function renderArticlePreview(content, terms, lawName, path, targetUrl) {
    const container = document.createElement('div');
    container.className = 'egov-ext-preview-container';

    const finalLawName = lawName || (content && content.LawTitle) || '';

    // ヘッダー
    const header = document.createElement('div');
    header.className = 'egov-ext-tip-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'egov-ext-tip-header-title';

    const lawTitleEl = document.createElement('span');
    lawTitleEl.className = 'egov-ext-preview-lawname';
    lawTitleEl.textContent = finalLawName;
    titleWrap.appendChild(lawTitleEl);

    if (path) {
      const pathEl = document.createElement('span');
      pathEl.className = 'egov-ext-preview-path';
      pathEl.textContent = ` ${path}`;
      titleWrap.appendChild(pathEl);
    }
    header.appendChild(titleWrap);

    // 別タブで開くボタン
    if (targetUrl && ext.createTipActionButton) {
      const openBtn = ext.createTipActionButton({
        icon: 'open',
        label: '開く',
        title: '別タブでこの条文を開く',
        url: targetUrl,
        onClick: () => {
          window.open(targetUrl, '_blank', 'noopener,noreferrer');
        }
      });
      header.appendChild(openBtn);
    }

    container.appendChild(header);

    // 本文ブロック
    const body = document.createElement('div');
    body.className = 'egov-ext-preview-body';


    if (content) {
      // 見出し（ArticleCaption）
      if (content.ArticleCaption) {
        const caption = document.createElement('div');
        caption.className = 'egov-ext-preview-caption';
        caption.appendChild(highlightTextNode(content.ArticleCaption, terms));
        body.appendChild(caption);
      }

      // 条番号（ArticleTitle）
      if (content.ArticleTitle) {
        const title = document.createElement('div');
        title.className = 'egov-ext-preview-title';
        title.textContent = content.ArticleTitle;
        body.appendChild(title);
      }

      // 項（Paragraph）
      const paragraphs = Array.isArray(content.Paragraph)
        ? content.Paragraph
        : (content.Paragraph ? [content.Paragraph] : (content.ParagraphSentence ? [content] : []));

      for (const p of paragraphs) {
        const pDiv = document.createElement('div');
        pDiv.className = 'egov-ext-preview-paragraph';

        if (p.ParagraphNum && p.ParagraphNum.trim()) {
          const numSpan = document.createElement('span');
          numSpan.className = 'egov-ext-preview-paragraph-num';
          numSpan.textContent = `${p.ParagraphNum} `;
          pDiv.appendChild(numSpan);
        }

        if (p.ParagraphSentence) {
          const pSentence = document.createElement('span');
          pSentence.className = 'egov-ext-preview-sentence';
          pSentence.appendChild(parseSentenceToDOM(p.ParagraphSentence, terms));
          pDiv.appendChild(pSentence);
        }

        // 号（Item）
        if (p.Item) {
          const items = Array.isArray(p.Item) ? p.Item : [p.Item];
          for (const it of items) {
            const itemDiv = document.createElement('div');
            itemDiv.className = 'egov-ext-preview-item';

            if (it.ItemTitle) {
              const itTitle = document.createElement('span');
              itTitle.className = 'egov-ext-preview-item-title';
              itTitle.textContent = `${it.ItemTitle} `;
              itemDiv.appendChild(itTitle);
            }

            if (it.ItemSentence) {
              const itSentence = document.createElement('span');
              itSentence.className = 'egov-ext-preview-sentence';
              itSentence.appendChild(parseSentenceToDOM(it.ItemSentence, terms));
              itemDiv.appendChild(itSentence);
            }

            // イ、ロ、ハ... (Subitem1)
            if (it.Subitem1) {
              const subitems = Array.isArray(it.Subitem1) ? it.Subitem1 : [it.Subitem1];
              for (const sub of subitems) {
                const subDiv = document.createElement('div');
                subDiv.className = 'egov-ext-preview-subitem';

                if (sub.Subitem1Title) {
                  const subTitle = document.createElement('span');
                  subTitle.className = 'egov-ext-preview-subitem-title';
                  subTitle.textContent = `${sub.Subitem1Title} `;
                  subDiv.appendChild(subTitle);
                }

                if (sub.Subitem1Sentence) {
                  const subSentence = document.createElement('span');
                  subSentence.className = 'egov-ext-preview-sentence';
                  subSentence.appendChild(parseSentenceToDOM(sub.Subitem1Sentence, terms));
                  subDiv.appendChild(subSentence);
                }

                // （１）、（２）... (Subitem2)
                if (sub.Subitem2) {
                  const sub2items = Array.isArray(sub.Subitem2) ? sub.Subitem2 : [sub.Subitem2];
                  for (const s2 of sub2items) {
                    const s2Div = document.createElement('div');
                    s2Div.className = 'egov-ext-preview-subitem2';

                    if (s2.Subitem2Title) {
                      const s2Title = document.createElement('span');
                      s2Title.className = 'egov-ext-preview-subitem-title';
                      s2Title.textContent = `${s2.Subitem2Title} `;
                      s2Div.appendChild(s2Title);
                    }

                    if (s2.Subitem2Sentence) {
                      const s2Sentence = document.createElement('span');
                      s2Sentence.className = 'egov-ext-preview-sentence';
                      s2Sentence.appendChild(parseSentenceToDOM(s2.Subitem2Sentence, terms));
                      s2Div.appendChild(s2Sentence);
                    }

                    subDiv.appendChild(s2Div);
                  }
                }

                itemDiv.appendChild(subDiv);
              }
            }

            pDiv.appendChild(itemDiv);
          }
        }

        body.appendChild(pDiv);
      }
    }

    container.appendChild(body);
    return container;
  }

  function buildPreviewHeader(lawName, path, targetUrl) {
    const header = document.createElement('div');
    header.className = 'egov-ext-tip-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'egov-ext-tip-header-title';
    titleWrap.textContent = `${lawName} ${path}`.trim();
    header.appendChild(titleWrap);

    if (targetUrl && ext.createTipActionButton) {
      const openBtn = ext.createTipActionButton({
        icon: 'open',
        label: '開く',
        title: '別タブでこの条文を開く',
        url: targetUrl,
        onClick: () => {
          window.open(targetUrl, '_blank', 'noopener,noreferrer');
        }
      });
      header.appendChild(openBtn);
    }
    return header;
  }

  function createLoadingView(lawName, path, targetUrl) {
    const container = document.createElement('div');
    container.className = 'egov-ext-preview-container';
    container.appendChild(buildPreviewHeader(lawName, path, targetUrl));

    const loading = document.createElement('div');
    loading.className = 'egov-ext-tip-loading';
    loading.innerHTML = '<span class="egov-ext-tip-spinner"></span>条文を読み込み中...';
    container.appendChild(loading);

    return container;
  }

  function createErrorView(lawName, path, msg, targetUrl) {
    const container = document.createElement('div');
    container.className = 'egov-ext-preview-container';
    container.appendChild(buildPreviewHeader(lawName, path, targetUrl));

    const error = document.createElement('div');
    error.className = 'egov-ext-tip-error';
    error.textContent = msg || '条文データの取得に失敗しました';
    container.appendChild(error);

    return container;
  }

  function createHtmlNoticeView(lawName, path, targetUrl) {
    const container = document.createElement('div');
    container.className = 'egov-ext-preview-container';
    container.appendChild(buildPreviewHeader(lawName, path, targetUrl));

    const notice = document.createElement('div');
    notice.className = 'egov-ext-tip-error';
    notice.textContent = '本法令はHTML形式のためプレビューできません。クリックして直接ご覧ください。';
    container.appendChild(notice);

    return container;
  }


  // 外部モジュール（refer_popup.js 等）連携用に公開
  ext.createLoadingView = createLoadingView;
  ext.createErrorView = createErrorView;
  ext.renderArticlePreview = renderArticlePreview;

  // テスト検証用に内部関数をエクスポート
  if (typeof process !== 'undefined' && process.env && process.env.NODE_ENV === 'test') {
    ext._testCitation = {
      extractHighlightTerms,
      renderArticlePreview,
      highlightTextNode,
      findTargetArticle,
      getOrFetchArticlePreview,
      fetchLawXmlDocument,
      findTargetArticleNodeInXml,
      xmlNodeToContent,
      fetchArticlePreviewFromXml,
      get inFlightFetches() { return inFlightFetches; },
      get activePreviewLink() { return activePreviewLink; }
    };
  }

})(window.egovExt);

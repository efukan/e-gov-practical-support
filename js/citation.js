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
   * 現在表示中の法令ID (URLから取得)
   * @type {string|null}
   */
  let currentLawId = null;

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
    // 挿入したボタンを削除
    const buttons = ext.deepQuerySelectorAll(document.body, '.egov-ext-citation-btn');
    buttons.forEach(btn => btn.remove());

    // ポップアップを閉じる（インスタンス自体は再利用するため破棄しない）
    if (ext.citationTooltip) {
      ext.citationTooltip.hide(true);
    }

    ext.citationMap.clear();
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
  }

  /**
   * 被引用ポップアップを共通ツールチップ基盤に登録する（初回のみ）。
   * 表示位置・ディレイ・Escape・外側クリックによる非表示はすべて基盤側が担当する。
   */
  function setupCitationTooltip() {
    if (ext.citationTooltip) return;

    ext.citationTooltip = ext.createTooltip({ variant: 'citation' });

    ext.bindHoverTooltip({
      selector: '.egov-ext-citation-btn',
      tooltip: ext.citationTooltip,
      isEnabled: () => !!(ext.settings.global && ext.settings.citation),
      resolveContent: (btn) => {
        const articleEl = btn.closest(ARTICLE_SELECTOR);
        if (!articleEl || !articleEl.id) return null;

        const inyoList = ext.citationMap.get(articleEl.id);
        if (!inyoList || inyoList.length === 0) return null;

        return buildCitationList(inyoList);
      }
    });
  }

  /**
   * 被引用法令の一覧DOMを組み立てる。
   * 外部から取得したデータを扱うため、innerHTML は使わず DOM API で構築する。
   * @param {Array<Object>} inyoList - 被引用データの配列
   * @returns {DocumentFragment}
   */
  function buildCitationList(inyoList) {
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

})(window.egovExt);

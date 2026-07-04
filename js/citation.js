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
   * 被引用表示ポップアップ（ツールチップ）のDOM要素
   * @type {HTMLElement|null}
   */
  ext.citationTooltipEl = null;

  /**
   * ポップアップ非表示用の遅延タイマーID
   * @type {number|null}
   */
  let tooltipHideTimer = null;

  /**
   * 現在表示中の法令ID (URLから取得)
   * @type {string|null}
   */
  let currentLawId = null;

  /**
   * 共通の初期化・適用関数
   */
  ext.enableCitations = async function() {
    console.log("egov-ext: enableCitations started. Settings citation:", ext.settings.citation, "global:", ext.settings.global);
    if (!ext.settings.global || !ext.settings.citation) {
      ext.disableCitations();
      return;
    }

    const isLawPage = ext.checkIfLawPage();
    if (!isLawPage) return;

    // URLからLawIDを抽出する
    const lawId = extractLawIdFromUrl();
    if (!lawId) return;

    // すでに同じLawIDでロード済みの場合は、DOMへのボタン挿入のみ行う
    if (currentLawId === lawId && ext.citationMap.size > 0) {
      insertCitationButtons();
      return;
    }

    currentLawId = lawId;
    ext.citationMap.clear();

    // ツールチップの作成
    createCitationTooltip();

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

    // ツールチップを削除
    if (ext.citationTooltipEl) {
      ext.citationTooltipEl.remove();
      ext.citationTooltipEl = null;
    }

    ext.citationMap.clear();
    currentLawId = null;
  };

  /**
   * 現在のURLから法令ID（law_id）を抽出する関数
   * @returns {string|null} 法令ID、見つからない場合は null
   */
  function extractLawIdFromUrl() {
    const url = window.location;
    // パラメータ形式: document?lawid=321CONSTITUTION
    const params = new URLSearchParams(url.search);
    const queryLawId = params.get('lawid');
    if (queryLawId) return queryLawId;

    // パス形式: /law/321CONSTITUTION
    const match = url.pathname.match(/\/law\/([^/]+)/);
    if (match && match[1]) {
      return match[1];
    }
    return null;
  }

  /**
   * 法令本文のDOMから、本則の各条文のObjectId（ID属性値）を収集する関数
   * @returns {Array<string>} ObjectIdの配列
   */
  function collectArticleObjectIds() {
    const objectIds = [];
    const container = document.querySelector('.LawBody') || 
                      document.querySelector('.main-content') || 
                      document.querySelector('.provisiontext') || 
                      document.querySelector('article.law') || 
                      document.body;

    // 本則の条文要素 (大文字・小文字、タグ名やアンダースコア表記のブレを網羅して広く探索)
    const articles = ext.deepQuerySelectorAll(container, '.Article, ._div_Article, .article, ._div_article, article');
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
    const container = document.querySelector('.LawBody') || 
                      document.querySelector('.main-content') || 
                      document.querySelector('.provisiontext') || 
                      document.querySelector('article.law') || 
                      document.body;

    const articles = ext.deepQuerySelectorAll(container, '.Article, ._div_Article, .article, ._div_article, article');
    articles.forEach(articleEl => {
      const objectId = articleEl.id;
      if (!objectId || !ext.citationMap.has(objectId)) return;

      // すでにボタンが挿入されているかチェック
      if (articleEl.querySelector('.egov-ext-citation-btn')) return;

      // 条文のタイトル要素 (例: 「第１条」など) を探す (大文字・小文字・ハイフン表記等のバリエーションを網羅)
      const titleEl = articleEl.querySelector('.ArticleTitle, ._div_ArticleTitle, .articletitle, ._div_articletitle, .article-title, .paragraph-title, .paragraphtitle');
      if (!titleEl) return;

      // ボタン要素の作成
      const btn = document.createElement('button');
      btn.className = 'egov-ext-citation-btn';
      btn.type = 'button';
      btn.title = 'この条文の被引用法令一覧を表示';
      btn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"/></svg>被引用`;

      // イベントリスナーの登録
      btn.addEventListener('mouseenter', (e) => showTooltip(e, objectId));
      btn.addEventListener('mouseleave', hideTooltipDeferred);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        showTooltip(e, objectId, true); // クリック時はピン留め的に表示を固定できるようにする
      });

      // タイトルの直後に挿入 (インライン)
      titleEl.appendChild(btn);
    });
  }

  /**
   * 被引用表示用のポップアップ（ツールチップ）要素を初期化する関数
   */
  function createCitationTooltip() {
    if (document.getElementById('egov-ext-citation-tooltip')) {
      ext.citationTooltipEl = document.getElementById('egov-ext-citation-tooltip');
      return;
    }

    const tooltip = document.createElement('div');
    tooltip.id = 'egov-ext-citation-tooltip';
    tooltip.className = 'egov-ext-citation-tooltip';
    
    // ポップアップ内にマウスが入った時は消えないように制御
    tooltip.addEventListener('mouseenter', () => {
      if (tooltipHideTimer) clearTimeout(tooltipHideTimer);
    });
    tooltip.addEventListener('mouseleave', hideTooltipDeferred);

    document.body.appendChild(tooltip);
    ext.citationTooltipEl = tooltip;
  }

  /**
   * ポップアップを表示する関数
   * @param {Event} event - イベントオブジェクト
   * @param {string} objectId - 対象のObjectId
   * @param {boolean} [isClick=false] - クリックによるトリガーかどうか
   */
  function showTooltip(event, objectId, isClick = false) {
    if (tooltipHideTimer) clearTimeout(tooltipHideTimer);

    const inyoList = ext.citationMap.get(objectId);
    if (!inyoList || inyoList.length === 0) return;

    if (!ext.citationTooltipEl) {
      createCitationTooltip();
    }

    const btn = event.currentTarget;
    
    // ポップアップ内のコンテンツを構築
    let html = '<div class="egov-ext-citation-tooltip-header">被引用法令一覧</div>';
    html += '<ul class="egov-ext-citation-tooltip-list">';
    
    inyoList.forEach(item => {
      const url = `https://laws.e-gov.go.jp${item.url}`;
      html += `<li>
        <a href="${url}" target="_blank" rel="noopener noreferrer" class="egov-ext-citation-link">
          <span class="egov-ext-citation-lawname">${item.law_name}</span>
          <span class="egov-ext-citation-path">${item.path}</span>
        </a>
      </li>`;
    });
    html += '</ul>';
    
    ext.citationTooltipEl.innerHTML = html;
    ext.citationTooltipEl.classList.add('visible');

    // 位置の計算
    const rect = btn.getBoundingClientRect();
    const tooltipRect = ext.citationTooltipEl.getBoundingClientRect();

    // 画面スクロール分を考慮した絶対配置の座標
    const scrollY = window.pageYOffset || document.documentElement.scrollTop;
    const scrollX = window.pageXOffset || document.documentElement.scrollLeft;

    let top = rect.top + scrollY - tooltipRect.height - 8; // ボタンの直上
    let left = rect.left + scrollX + (rect.width / 2) - (tooltipRect.width / 2);

    // 画面の上端からはみ出る場合は、ボタンの下側に表示する
    if (rect.top - tooltipRect.height - 8 < 0) {
      top = rect.bottom + scrollY + 8;
    }

    // 左右のはみ出しを防ぐ調整
    if (left < 10) {
      left = 10;
    } else if (left + tooltipRect.width > window.innerWidth - 10) {
      left = window.innerWidth - tooltipRect.width - 10;
    }

    ext.citationTooltipEl.style.top = `${top}px`;
    ext.citationTooltipEl.style.left = `${left}px`;
  }

  /**
   * ポップアップを少し遅れて非表示にする関数
   */
  function hideTooltipDeferred() {
    if (tooltipHideTimer) clearTimeout(tooltipHideTimer);
    tooltipHideTimer = setTimeout(() => {
      if (ext.citationTooltipEl) {
        ext.citationTooltipEl.classList.remove('visible');
      }
    }, 300); // 300msの遅延後に非表示にする
  }

})(window.egovExt);

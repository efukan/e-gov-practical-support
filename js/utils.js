/**
 * utils.js
 * 
 * 共通設定、非同期タスク制御、DOMユーティリティ、漢数字変換などの
 * 汎用ヘルパー関数および共有状態を管理するモジュール。
 */

window.egovExt = window.egovExt || {};

(function(ext) {
  /**
   * デバッグログを出力するかどうか。
   * 開発時は DevTools のコンソールで `window.egovExt.DEBUG = true` を実行すると有効になる。
   * @type {boolean}
   */
  ext.DEBUG = false;

  /**
   * ext.DEBUG が有効なときだけコンソールに出力するログ関数。
   * エラーは常に出したいので console.error をそのまま使うこと。
   * @param {...*} args
   */
  ext.log = function(...args) {
    if (ext.DEBUG) console.log('egov-ext:', ...args);
  };

  /**
   * グローバルな設定状態を保持するオブジェクト。
   * デフォルト値の定義は js/settings.js（ext.DEFAULT_SETTINGS）に一本化されている。
   * @type {Object<string, boolean>}
   */
  ext.settings = Object.assign({}, ext.DEFAULT_SETTINGS);

  /**
   * 法令本文のメインコンテナを指すセレクタ。
   * closest() などに渡す際は、カンマ区切りの1回の呼び出しで祖先を1度だけ遡れる。
   * @type {string}
   */
  ext.LAW_CONTAINER_SELECTOR = '.LawBody, .main-content, .provisiontext, article.law';

  /**
   * 目次・サイドバーを指すセレクタ（変換対象から除外する領域）
   * @type {string}
   */
  ext.SIDEBAR_SELECTOR = '.sidebar, #sidebar, .toc';

  /**
   * 拡張機能自身が挿入した自作UI要素を指すセレクタ
   * @type {string}
   */
  ext.SELF_UI_SELECTOR = '.egov-ext-tip, .egov-ext-header-container, #egov-ext-jump-container, #egov-ext-fav-btn, #egov-ext-quick-toggles, #egov-ext-search-btn, #egov-ext-settings-btn, .egov-ext-citation-btn, .egov-ext-backref-btn, .egov-ext-note-flag, .egov-ext-mk-toolbar, .egov-ext-mk-card';

  /**
   * 非同期実行タスクの追跡管理オブジェクト（多重起動防止およびキャンセル排他制御用）
   * @type {Object<string, Object|null>}
   */
  ext.activeTasks = {
    horizontal_leaf: null,
    horizontal_item: null,
    horizontal_para: null,
    dim: null,
    definitionExtract: null,
    definitionHighlight: null
  };

  /**
   * 目次（TOC）操作状態の管理用グローバル変数
   * @type {boolean}
   */
  ext.isTOCInteracting = false;

  /**
   * 目次操作サスペンド解除用のタイマーID
   * @type {number|null}
   */
  ext.tocInteractionTimeout = null;

  /**
   * 定義語キャッシュマップ
   * @type {Map<string, Object>}
   */
  ext.definitionMap = new Map();

  /**
   * 変更が加えられたDOM要素のセット
   * @type {Set<HTMLElement>}
   */
  ext.modifiedElements = ext.modifiedElements || new Set();

  /**
   * 対象要素の元のHTMLを保存する関数
   * @param {HTMLElement} element
   */
  ext.saveOriginalHTML = function(element) {
    if (!element) return;

    // 自作UIおよび目次（サイドバー）の要素は対象外とする
    if (element.closest && (element.closest(ext.SIDEBAR_SELECTOR) || element.closest(ext.SELF_UI_SELECTOR))) {
      return;
    }

    // 親子要素の二重管理・復元競合（親による子の復元上書き）を防ぐため、
    // 互いに包含関係を持たない末端の行・文ブロックコンテナを特定して退避する
    const targetSelector = [
      '._div_ParagraphSentence', '.ParagraphSentence',
      '._div_ItemSentence', '.ItemSentence',
      '._div_SubitemSentence', '.SubitemSentence',
      '._div_ParagraphNum', '.ParagraphNum',
      '._div_ItemTitle', '.ItemTitle',
      '._div_ArticleTitle', '.ArticleTitle',
      '._div_ArticleCaption', '.ArticleCaption'
    ].join(', ');

    const target = element.closest ? element.closest(targetSelector) : null;
    const actualElement = target || element;

    if (actualElement._egov_originalHTML === undefined) {
      // 自作UI（被引用ボタン等）が既に挿入されている場合は、クローンから自作UIを除去して純粋な元HTMLを退避する
      if (actualElement.querySelector && actualElement.querySelector(ext.SELF_UI_SELECTOR)) {
        const clone = actualElement.cloneNode(true);
        const selfUIs = clone.querySelectorAll(ext.SELF_UI_SELECTOR);
        for (let i = 0; i < selfUIs.length; i++) {
          selfUIs[i].remove();
        }
        actualElement._egov_originalHTML = clone.innerHTML;
      } else {
        actualElement._egov_originalHTML = actualElement.innerHTML;
      }
      ext.modifiedElements.add(actualElement);
    }
  };

  /**
   * 保存されたすべての要素のHTMLを元に戻す関数
   */
  ext.restoreAllOriginalHTML = function() {
    if (ext.modifiedElements) {
      ext.modifiedElements.forEach(element => {
        if (element.isConnected && element._egov_originalHTML !== undefined) {
          if (element.innerHTML !== element._egov_originalHTML) {
            element.innerHTML = element._egov_originalHTML;
          }
        }
        delete element._egov_originalHTML;
      });
      ext.modifiedElements.clear();
    }
  };

  /**
   * ページ内に Shadow Root が存在するかどうかのフラグ。
   * false の場合は Shadow DOM を考慮した重い探索をすべて省略できる（高速化の要）。
   * @type {boolean}
   */
  ext.hasShadowRoots = false;

  /**
   * Shadow Root の初回全走査が完了したかどうかのフラグ。
   * 完了後は、Shadow Root が1つも無かった場合に再走査をスキップする。
   * @type {boolean}
   */
  ext.shadowScanCompleted = false;

  /**
   * グローバルなDOM監視用Observer（content.jsで実体化）
   * @type {MutationObserver|null}
   */
  ext.globalDOMObserver = null;

  /**
   * 特定の非同期タスクを中断する関数
   * @param {string} name - タスク識別名
   */
  ext.cancelTask = function(name) {
    if (ext.activeTasks[name]) {
      ext.activeTasks[name].cancelled = true;
      ext.activeTasks[name] = null;
    }
  };

  /**
   * すべての非同期タスクを中断する関数（除外タスク指定可能）
   * @param {string[]|string} [excludeNames=[]] - 中断対象外とするタスク名
   */
  ext.cancelAllTasks = function(excludeNames = []) {
    const excludeSet = new Set(Array.isArray(excludeNames) ? excludeNames : [excludeNames]);
    for (const name in ext.activeTasks) {
      if (excludeSet.has(name)) continue;
      ext.cancelTask(name);
    }
  };

  /**
   * 指定ノードの子孫要素数を数える。ただし limit に達した時点で打ち切る。
   * querySelectorAll('*').length と違い、巨大なサブツリーでも全要素を列挙しない。
   * @param {Node} node - 起点ノード
   * @param {number} limit - 数え上げの上限
   * @returns {number} 子孫要素数（limit で打ち切られた場合は limit）
   */
  ext.countDescendantsUpTo = function(node, limit) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return 0;

    let count = 0;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      count++;
      if (count >= limit) return limit;
    }
    return count;
  };

  /**
   * 法令本文のメインコンテナ要素を取得する。
   * `.LawBody` → `.main-content` → `.provisiontext` → `article.law` の優先順で探し、
   * 見つからない場合は document.body を返す（Shadow DOM 対応）。
   * @param {HTMLElement} [root=document.body] - 探索の起点
   * @returns {HTMLElement} メインコンテナ、または document.body
   */
  ext.getLawContainer = function(root) {
    const scope = root || document.body;
    // 内側のコンテナを優先したいので、まとめて1回のクエリにはせず優先順に探す
    const PRIORITY = ['.LawBody', '.main-content', '.provisiontext', 'article.law'];
    for (let i = 0; i < PRIORITY.length; i++) {
      const found = ext.deepQuerySelectorAll(scope, PRIORITY[i])[0];
      if (found) return found;
    }
    return document.body;
  };

  /**
   * URLから法令ID（例: 322AC0000000067）を抽出する。
   * @param {string} urlString - 解析対象のURL
   * @returns {string|null} 抽出された法令ID（大文字）、見つからない場合は null
   */
  ext.getLawIdFromUrl = function(urlString) {
    if (!urlString) return null;
    try {
      const url = new URL(urlString, window.location.origin);

      // 1. /law/[法令ID] パスから抽出
      const pathMatch = url.pathname.match(/\/law\/([0-9A-Z]+)/i);
      if (pathMatch) return pathMatch[1].toUpperCase();

      // 2. ?lawId= / ?lawid= クエリから抽出（e-Gov 側で表記が揺れるため両方を見る）
      const lawIdParam = url.searchParams.get('lawId') || url.searchParams.get('lawid');
      if (lawIdParam) return lawIdParam.toUpperCase();

      // 3. パス中に含まれる一般的な法令IDパターン (例: /document/322AC0000000067)
      const generalMatch = url.pathname.match(/\/([0-9]{3}[A-Z]{2}[0-9]+)/i);
      if (generalMatch) return generalMatch[1].toUpperCase();
    } catch (e) {
      // 相対パスなど URL として解釈できない場合のフォールバック
      const pathMatch = urlString.match(/\/law\/([0-9A-Z]+)/i);
      if (pathMatch) return pathMatch[1].toUpperCase();
    }
    return null;
  };

  /**
   * テキスト変換の対象となるブロック要素のセレクタ
   * @type {string}
   */
  ext.BLOCK_SELECTOR = 'div, p, h1, h2, h3, h4, h5, h6, li, td, th';

  /**
   * テキスト変換（薄字化・定義語ハイライト等）の対象から除外する要素のセレクタ。
   * 見出し・法令名・条番号・目次など、書き換えても意味がない or 壊れる領域を列挙する。
   * @type {string}
   */
  ext.EXCLUDED_SELECTORS = [
    '[class*="ArticleCaption"]',
    '[class*="PartTitle"]',
    '[class*="ChapterTitle"]',
    '[class*="SectionTitle"]',
    '[class*="SubsectionTitle"]',
    '[class*="DivisionTitle"]',
    '[class*="SupplProvisionLabel"]',
    '[class*="revisionamendinglawtitle"]',
    '[class*="timebar"]',
    '[class*="openingtocitems"]',
    '[class*="lawdetaillawtitle"]',
    '[class*="title-law"]',
    '[class*="lawtitle"]',
    '[class*="LawTitle"]',
    '[class*="law-title"]',
    '[class*="Law-Title"]',
    '[class*="appid"]',
    '[class*="ItemTitle"]',
    '[class*="itemtitle"]',
    '[class*="ParagraphNum"]',
    '[class*="paragraphtitle"]'
  ].join(', ');

  /**
   * テキスト変換の対象とする「末端ブロック要素」を収集する。
   * ブロック要素のうち、自身がさらにブロック要素を内包していないものだけを返す
   * （親子で二重に変換して壊すのを防ぐため）。サイドバー・タイトルバー・
   * EXCLUDED_SELECTORS に該当する領域はここで除外される。
   *
   * @param {HTMLElement} container - 探索の起点
   * @param {HTMLElement|null} [selfCandidate=null] - container 自身も候補に含める場合に渡す
   *   （MutationObserver で追加された単一ノードを処理するケース）
   * @returns {HTMLElement[]} 変換対象の末端ブロック要素の配列
   */
  const SKIP_SELECTOR = ext.SIDEBAR_SELECTOR + ', ' + ext.EXCLUDED_SELECTORS + ', ' + ext.SELF_UI_SELECTOR;

  ext.collectLeafBlocks = function(container, selfCandidate = null) {
    if (!container) return [];

    const candidates = [];
    if (selfCandidate && selfCandidate.matches && selfCandidate.matches(ext.BLOCK_SELECTOR)) {
      candidates.push(selfCandidate);
    }
    const found = ext.deepQuerySelectorAll(container, ext.BLOCK_SELECTOR);
    for (let i = 0; i < found.length; i++) {
      candidates.push(found[i]);
    }

    const titlebar = document.getElementById('titlebar');
    const results = [];

    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];

      // 末端判定。querySelector は最初の1件で打ち切られるため
      // querySelectorAll(...).length === 0 より大幅に速い。
      if (el.querySelector(ext.BLOCK_SELECTOR)) continue;

      if (titlebar && (titlebar === el || titlebar.contains(el))) continue;
      // サイドバーと除外セレクタは1回の祖先走査でまとめて判定する
      if (ext.deepClosest(el, SKIP_SELECTOR)) continue;

      results.push(el);
    }

    return results;
  };

  /**
   * 要素配列を指定サイズのチャンクに分割し、非同期かつ非ブロッキングで処理を実行する
   * @param {string} taskName - タスク識別名
   * @param {Array<HTMLElement>} items - 処理対象の要素配列
   * @param {Function} processFunc - 各要素に適用する個別処理関数
   * @param {number} chunkSize - 1チャンク内の処理要素数
   * @param {Function|null} onComplete - 完了時のコールバック
   * @returns {Object} キャンセル検知用の状態オブジェクト
   */
  ext.runTaskInChunks = function(taskName, items, processFunc, chunkSize = 150, onComplete = null) {
    ext.cancelTask(taskName);

    const state = { cancelled: false };
    // 終わった（または取り消された）ことを待てるようにする（ext.waitForTasks）
    state.done = new Promise(resolve => { state.resolveDone = resolve; });
    ext.activeTasks[taskName] = state;

    let index = 0;
    function runNextChunk() {
      if (state.cancelled) {
        state.resolveDone();
        if (onComplete) onComplete(state);
        return;
      }

      // 自らのDOM変更によるMutationObserverの無限ループを防ぐため、チャンク処理中のみ一時的に監視を解除
      const wasObserving = ext.globalDOMObserver !== null && ext.globalDOMObserver !== undefined;
      if (wasObserving) {
        ext.globalDOMObserver.disconnect();
      }

      const end = Math.min(index + chunkSize, items.length);
      for (let i = index; i < end; i++) {
        processFunc(items[i]);
      }
      index = end;

      // チャンク処理終了後に監視を再開
      if (wasObserving && ext.reconnectDOMObserver) {
        ext.reconnectDOMObserver();
      }

      if (index < items.length) {
        if (window.requestIdleCallback) {
          window.requestIdleCallback(runNextChunk);
        } else {
          setTimeout(runNextChunk, 0);
        }
      } else {
        if (ext.activeTasks[taskName] === state) {
          ext.activeTasks[taskName] = null;
        }
        state.resolveDone();
        if (onComplete) onComplete(state);
      }
    }

    runNextChunk();
    return state;
  };

  /**
   * チャンク分割処理を Promise でラップした関数（async/await 順序制御用）
   * @param {string} taskName - タスク識別名
   * @param {Array<HTMLElement>} items - 処理対象の要素配列
   * @param {Function} processFunc - 各要素に適用する個別処理関数
   * @param {number} chunkSize - 1チャンク内の処理要素数
   * @returns {Promise<Object>} キャンセル検知用の状態オブジェクト
   */
  /**
   * 指定した分割処理が走っていれば、終わるまで待つ（途中で同じ名前の処理が始め直されたら、それも待つ）。
   * 待つのは timeoutMs まで。分割処理は画面が空いたときに少しずつ進むので、地方税法のような
   * 大きな法令では 30 秒以上かかり、待ち続けると後の処理がいつまでも始まらない
   * @param {string[]} taskNames
   * @param {number} [timeoutMs=4000]
   * @returns {Promise<void>}
   */
  ext.waitForTasks = async function(taskNames, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    for (let guard = 0; guard < 20; guard++) {
      const pending = taskNames.map(n => ext.activeTasks[n]).filter(st => st && st.done);
      const rest = deadline - Date.now();
      if (!pending.length || rest <= 0) return;
      await Promise.race([
        Promise.all(pending.map(st => st.done)),
        new Promise(resolve => setTimeout(resolve, rest))
      ]);
    }
  };

  ext.runTaskInChunksPromise = function(taskName, items, processFunc, chunkSize = 150) {
    return new Promise((resolve) => {
      ext.runTaskInChunks(taskName, items, processFunc, chunkSize, (state) => {
        resolve(state);
      });
    });
  };

  /**
   * HTML特殊文字をエスケープしてXSSを予防する汎用関数
   * @param {string} str - エスケープ対象の文字列
   * @returns {string} エスケープ済みの文字列
   */
  ext.escapeHTML = function(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  };

  /**
   * イベントの伝播経路（Shadow DOM を含む）を走査して、指定のセレクタにマッチする要素を見つける
   * @param {Event} event - ブラウザのイベントオブジェクト
   * @param {string} selector - 検索対象のCSSセレクタ
   * @returns {HTMLElement|null} マッチした最も近い要素、見つからない場合は null
   */
  ext.getComposedTarget = function(event, selector) {
    // 高速化パス: ページに Shadow Root が無いなら composedPath() の走査は不要。
    // mouseover のたびに呼ばれるホットパスなので、この分岐の効果は大きい。
    if (!ext.hasShadowRoots) {
      return event.target && event.target.closest ? event.target.closest(selector) : null;
    }

    if (typeof event.composedPath === 'function') {
      const path = event.composedPath();
      for (let i = 0; i < path.length; i++) {
        const el = path[i];
        if (el && el.closest) {
          const found = el.closest(selector);
          if (found) return found;
        }
      }
    }
    return event.target && event.target.closest ? event.target.closest(selector) : null;
  };

  /**
   * Shadow DOM の境界を超えて親要素を遡り、指定のセレクタにマッチする要素を見つける
   * @param {HTMLElement} element - 探索の起点となるDOM要素
   * @param {string} selector - 検索対象のCSSセレクタ
   * @returns {HTMLElement|null} マッチした要素、見つからない場合は null
   */
  ext.deepClosest = function(element, selector) {
    let curr = element;
    while (curr) {
      if (curr.closest) {
        const found = curr.closest(selector);
        if (found) return found;
      }
      const root = curr.getRootNode ? curr.getRootNode() : null;
      if (root && root.host) {
        curr = root.host;
      } else {
        break;
      }
    }
    return null;
  };

  /**
   * Shadow DOM の境界を越えて、すべての要素を再帰的に検索するディープクエリ関数 (カプセル化対策 - 高速化版)
   * @param {HTMLElement} root - 探索開始ノード
   * @param {string} selector - CSSセレクタ
   * @returns {HTMLElement[]} マッチした要素の配列
   */
  ext.deepQuerySelectorAll = function(root, selector) {
    const results = [];
    if (!root) return results;

    /** 通常の querySelectorAll だけで済ませる高速パス */
    const shallowQuery = () => {
      if (root.querySelectorAll) {
        try {
          return Array.from(root.querySelectorAll(selector));
        } catch (e) {}
      }
      return results;
    };

    // 高速化パス1: ページ内に Shadow Root が見つかっていない場合は再帰探索が不要。
    // isMainOrSidebar の判定（祖先を何度も遡る）より先に評価することで無駄な走査を避ける。
    if (!ext.hasShadowRoots) return shallowQuery();

    // 高速化パス2: 検索元が法令本文やサイドバー配下であることが明確なら、その内部に Shadow Root は無い
    if (root.closest && root.closest(ext.LAW_CONTAINER_SELECTOR + ', ' + ext.SIDEBAR_SELECTOR)) {
      return shallowQuery();
    }

    // 従来の再帰的探索フォールバック（Shadow DOM が存在する可能性のあるエリア用）
    if (root.querySelectorAll) {
      try {
        const matches = root.querySelectorAll(selector);
        for (let i = 0; i < matches.length; i++) {
          results.push(matches[i]);
        }
      } catch (e) {}
    }
    
    function findShadows(node) {
      if (!node) return;
      
      if (node.shadowRoot) {
        try {
          const matches = node.shadowRoot.querySelectorAll(selector);
          for (let i = 0; i < matches.length; i++) {
            if (!results.includes(matches[i])) {
              results.push(matches[i]);
            }
          }
        } catch (e) {}
        findShadows(node.shadowRoot);
      }
      
      let child = node.firstElementChild;
      while (child) {
        findShadows(child);
        child = child.nextElementSibling;
      }
    }
    
    findShadows(root);
    return results;
  };

  /**
   * 現在表示されているページが法令本文表示ページであるかを判定する関数。
   * トップページや検索結果一覧（/result）など、条文表示以外のページは確実に false を返す。
   * @returns {boolean} 法令表示ページの場合は true、それ以外は false
   */
  ext.checkIfLawPage = function() {
    const pathname = window.location.pathname || '';

    // 1. トップページや検索結果一覧（/result）など、明確に非条文ページであるURLは即座に除外
    if (pathname === '/' || pathname === '' || pathname === '/result' || pathname.startsWith('/result/') || pathname.startsWith('/result?')) {
      return false;
    }

    // 2. URLに /law/ または /document/ が含まれている場合は条文ページ
    const isUrlMatch = pathname.includes('/law/') || pathname.includes('/document');
    if (isUrlMatch) return true;

    // 3. クエリパラメータに lawId / lawid が含まれている場合も条文ページ
    try {
      const searchParams = new URLSearchParams(window.location.search);
      if (searchParams.has('lawId') || searchParams.has('lawid')) {
        return true;
      }
    } catch (e) {}

    // 4. URL判定から漏れた場合でも、DOMに法令本文を示す主要クラスが存在していれば法令ページとみなす
    // （※p.sentence は検索結果一覧等にも紛れ込むため除外し、条文構造固有の要素に限定）
    const hasLawDOM = ext.deepQuerySelectorAll(document.body, '.LawBody, .provisiontext, article.law, ._div_Article, .Article, ._div_ParagraphSentence, .ParagraphSentence, ._div_ArticleTitle, .ArticleTitle');
    return hasLawDOM.length > 0;
  };

  /**
   * 漢数字の文字列をアラビア数字の数値文字列に変換する関数
   * 例: "百二十三" -> "123", "二〇二六" -> "2026"
   * @param {string} kanjiStr - 対象の漢数字文字列
   * @returns {string} 置換後のアラビア数値文字列
   */
  ext.kanjiToArabic = function(kanjiStr) {
    if (!kanjiStr) return '';
    
    const kanjiMap = {
      '〇': 0, '一': 1, '二': 2, '三': 3, '四': 4,
      '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
      '０': 0, '１': 1, '２': 2, '３': 3, '４': 4,
      '５': 5, '６': 6, '７': 7, '８': 8, '９': 9
    };
    
    const units = {
      '十': 10,
      '百': 100,
      '千': 1000
    };
    
    const largeUnits = {
      '万': 10000,
      '億': 100000000,
      '兆': 1000000000000
    };

    // 桁区切り単位（十、百、千、万等）が含まれているかチェック
    let hasUnit = false;
    for (let key in units) {
      if (kanjiStr.includes(key)) hasUnit = true;
    }
    for (let key in largeUnits) {
      if (kanjiStr.includes(key)) hasUnit = true;
    }

    // 単位なし（単なる数字の羅列、例: 年号「二〇二六」や枝番「一二」など）
    if (!hasUnit) {
      let result = '';
      for (let i = 0; i < kanjiStr.length; i++) {
        const char = kanjiStr[i];
        if (kanjiMap[char] !== undefined) {
          result += kanjiMap[char];
        } else {
          result += char;
        }
      }
      return result;
    }

    // 単位あり（例: 百二十三, 二万五千など）の解析
    let total = 0;
    let currentSection = 0; // 万、億などの単位で区切られた現在の区間
    let currentNum = 0;

    for (let i = 0; i < kanjiStr.length; i++) {
      const char = kanjiStr[i];
      if (kanjiMap[char] !== undefined) {
        currentNum = kanjiMap[char];
      } else if (units[char] !== undefined) {
        const unitVal = units[char];
        if (currentNum === 0) currentNum = 1; // "十"は"一十"の意味
        currentSection += currentNum * unitVal;
        currentNum = 0;
      } else if (largeUnits[char] !== undefined) {
        const largeUnitVal = largeUnits[char];
        if (currentNum > 0) {
          currentSection += currentNum;
        }
        if (currentSection === 0) currentSection = 1;
        total += currentSection * largeUnitVal;
        currentSection = 0;
        currentNum = 0;
      }
    }

    if (currentNum > 0) {
      currentSection += currentNum;
    }
    total += currentSection;

    return total.toString();
  };

  /**
   * 半角アラビア数字を全角アラビア数字に変換する関数
   * 例: "123" -> "１２３"
   * @param {string|number} numStr - 置換前の半角文字列または数値
   * @returns {string} 全角数値文字列
   */
  ext.toFullWidthArabic = function(numStr) {
    if (!numStr) return '';
    return numStr.toString().replace(/[0-9]/g, function(s) {
      return String.fromCharCode(s.charCodeAt(0) + 0xFEE0);
    });
  };

  /**
   * 全角アラビア数字を半角アラビア数字に変換する関数
   * 例: "１２３" -> "123"
   * @param {string|number} numStr - 置換前の全角文字列
   * @returns {string} 半角数値文字列
   */
  ext.toHalfWidthArabic = function(numStr) {
    if (!numStr) return '';
    return numStr.toString().replace(/[０-９]/g, function(s) {
      return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
    });
  };

  /**
   * 漢数字の文字列を全角アラビア数字の数値文字列に変換するヘルパー関数
   * 例: "百二十三" -> "１２３"
   * @param {string} kanjiStr - 漢数字文字列
   * @returns {string} 全角アラビア数値文字列
   */
  ext.kanjiToFullWidthArabic = function(kanjiStr) {
    const arabic = ext.kanjiToArabic(kanjiStr);
    return ext.toFullWidthArabic(arabic);
  };

  /**
   * ヘッダーコンテナ（右上の切り替えボタン・お気に入りボタン・条文ジャンプ検索ボックスを格納する親要素）を取得または作成する関数
   * @returns {HTMLElement} ヘッダーのコンテナDIV要素
   */
  ext.getOrCreateHeaderContainer = function() {
    let container = document.getElementById('egov-ext-header-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'egov-ext-header-container';
      container.className = 'egov-ext-header-container';
      document.body.appendChild(container);
    }
    return container;
  };

  /**
   * 空になったヘッダーコンテナをDOMから削除する関数
   */
  ext.checkAndRemoveHeaderContainer = function() {
    const container = document.getElementById('egov-ext-header-container');
    if (container && container.children.length === 0) {
      container.remove();
    }
  };

  /**
   * 本文の枠がページの中でスクロールしているときの、枠の上端からの余白（px）。
   * 枠の中には固定ヘッダーが無いので、前の号の末尾が数行見える 72px は要らない。
   * 大きく空けると、号を指すリンクで一つ前の号が先に目に入り「違う号に飛んだ」と読める
   * @type {number}
   */
  const INNER_SCROLL_OFFSET = 12;

  /**
   * スクロールしているのが文書全体（window）かどうか
   * @param {Element} scroller
   * @returns {boolean}
   */
  function isDocumentScroller(scroller) {
    return !scroller || scroller === document.scrollingElement || scroller === document.documentElement || scroller === document.body;
  }

  /**
   * 要素を縦にスクロールさせている祖先を返す。
   * e-Gov の条文ページは、ページ全体ではなく本文の枠（section#revision）がスクロールする
   * （ヘッダーと目次は枠の外にある）。window.scrollBy で位置を直しても本文は動かないので、
   * スクロール位置を直す処理は必ずここで枠を求めてから行う。
   * @param {Element} el
   * @returns {Element} スクロールしている要素（無ければ document.scrollingElement）
   */
  ext.getScrollContainer = function(el) {
    const docScroller = document.scrollingElement || document.documentElement;
    if (!el || typeof window.getComputedStyle !== 'function') return docScroller;
    let p = el.parentElement;
    while (p && p !== document.body && p !== document.documentElement) {
      const oy = window.getComputedStyle(p).overflowY;
      if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && p.scrollHeight > p.clientHeight + 1) {
        return p;
      }
      p = p.parentElement;
    }
    return docScroller;
  };

  /**
   * 要素の上端が、スクロール枠の上端から何 px 下にあるか
   * @param {Element} el
   * @param {Element} scroller
   * @returns {number}
   */
  function topWithinScroller(el, scroller) {
    const base = isDocumentScroller(scroller) ? 0 : scroller.getBoundingClientRect().top;
    return el.getBoundingClientRect().top - base;
  }

  /**
   * スクロール枠を delta px だけ瞬時に動かす
   * @param {Element} scroller
   * @param {number} delta
   */
  function scrollScrollerBy(scroller, delta) {
    if (isDocumentScroller(scroller)) {
      if (typeof window.scrollBy === 'function') {
        try { window.scrollBy(0, delta); } catch (e) {}
      }
    } else {
      scroller.scrollTop += delta;
    }
  }

  /**
   * 要素が、まだ描かれていない content-visibility:auto の中にあるか。
   * そうした要素の getBoundingClientRect() は描かれる前の古い位置を返す
   * （実測：個人情報保護法の附則第一条が実際には 71,496px 下にあるのに -157px と出た）。
   * 位置を測る前に scrollIntoView で描かせる必要がある
   * @param {Element} el
   * @returns {boolean}
   */
  function isSkippedByContentVisibility(el) {
    return typeof el.checkVisibility === 'function' && !el.checkVisibility({ contentVisibilityAuto: true });
  }

  /**
   * 要素を枠の上端へ瞬時に寄せる（scroll-margin-top に従う）。描かれていない要素も描かせてから寄せる
   * @param {Element} el
   */
  function scrollIntoViewInstant(el) {
    if (typeof el.scrollIntoView !== 'function') return;
    try {
      el.scrollIntoView({ block: 'start', behavior: 'instant' });
    } catch (e) {
      el.scrollIntoView(true);
    }
  }

  /**
   * スクロール枠の現在位置
   * @param {Element} scroller
   * @returns {number}
   */
  function scrollPosition(scroller) {
    return isDocumentScroller(scroller) ? (window.pageYOffset || 0) : scroller.scrollTop;
  }

  /**
   * 法令本文をスクロールさせている枠（e-Gov の現行画面では section#revision）。
   * 本文の中の要素から求める。getLawContainer() が返す .main-content は枠の外側にあり、
   * そこから上をたどっても枠に当たらない
   * @returns {Element|null}
   */
  ext.getLawScrollContainer = function() {
    const probe = document.querySelector('[id^="Mp-"], [id*="-Sp-"], .provisiontext, .LawBody') ||
                  (ext.getLawContainer ? ext.getLawContainer() : null);
    return probe && probe !== document.body ? ext.getScrollContainer(probe) : null;
  };

  /** 要素の上端がスクロール枠の上端から何 px 下にあるか（jump.js の「元の位置へ戻る」でも使う） */
  ext.topWithinScroller = function(el, scroller) {
    return topWithinScroller(el, scroller);
  };

  /** スクロールしているのが文書全体（window）かどうか */
  ext.isDocumentScroller = function(scroller) {
    return isDocumentScroller(scroller);
  };

  /**
   * 条文へ移動したときに、目的の要素を枠の上端からどれだけ下に置くか（px）を求め、
   * CSS変数 --egov-header-offset（scroll-margin-top。e-Gov 自身の目次移動もこれに従う）を更新する。
   * 本文が枠の中でスクロールする e-Gov の現行画面では小さな余白、
   * ページ全体がスクロールする場合は固定ヘッダーの高さ＋余白。
   * @param {Element} [scroller] - スクロール枠（省略時は本文から求める）
   * @returns {number}
   */
  ext.updateHeaderOffset = function(scroller) {
    if (typeof document === 'undefined') return 72;
    const sc = scroller || ext.getLawScrollContainer();
    let offset;
    if (sc && !isDocumentScroller(sc)) {
      offset = INNER_SCROLL_OFFSET;
    } else {
      let headerHeight = 0;
      const titlebar = document.getElementById('titlebar');
      if (titlebar && window.getComputedStyle) {
        const tbStyle = window.getComputedStyle(titlebar);
        if (tbStyle.position === 'fixed' || tbStyle.position === 'sticky') {
          headerHeight = Math.max(headerHeight, titlebar.offsetHeight || 0);
        }
      }
      offset = Math.max(72, headerHeight + 20);
    }
    if (document.documentElement && document.documentElement.style) {
      document.documentElement.style.setProperty('--egov-header-offset', `${offset}px`);
    }
    return offset;
  };

  /**
   * e-Gov の要素 id から、編・章・節・款・目の段を取り除いた形にする。
   * 本文の id は「Mp-Ch_1-At_2-Pr_1-It_14」のように所属する章・節を挟むが、
   * URL や他の法令からのリンクは「Mp-At_2-Pr_1-It_14」と条から書く。
   * @param {string} id
   * @returns {string}
   */
  function stripHierarchy(id) {
    return id.replace(/-(?:Pa|Ch|Se|Ss|Di)_[0-9]+(?:_[0-9]+)*(?=-|$)/g, '');
  }
  ext.stripHierarchyFromId = stripHierarchy;

  /**
   * 比較用に id をそろえる（区切りの表記揺れ「-」「_」をなくしてから段を取り除く）
   * @param {string} id
   * @returns {string}
   */
  function normalizeIdForMatch(id) {
    return id.replace(/-/g, '_').replace(/_(?:Pa|Ch|Se|Ss|Di)_[0-9]+(?:_[0-9]+)*(?=_[A-Za-z]|$)/g, '');
  }

  /**
   * リンクの参照先 ID から、実際の対象要素を解決する共通関数。
   * 章・節を省いた短い形（Mp-At_2-Pr_1-It_14）、ハイフン／アンダースコアの表記揺れ
   * （Mp-At_ ⇄ Mp_At_）、改正附則の前方一致・後方一致に対応。
   *
   * @param {string} targetId - 要素IDまたはハッシュ
   * @returns {HTMLElement|null}
   */
  ext.resolveTargetElement = function(targetId) {
    if (!targetId || typeof document === 'undefined') return null;
    targetId = String(targetId).replace(/^#/, '');
    try { targetId = decodeURIComponent(targetId); } catch (e) {}
    if (!targetId) return null;

    const escapeAttr = (s) => s.replace(/["\\]/g, '\\$&');
    const findById = (id) => document.getElementById(id) ||
                             document.querySelector(`[name="${escapeAttr(id)}"]`) ||
                             (ext.deepQuerySelectorAll ? ext.deepQuerySelectorAll(document.body, `[id="${escapeAttr(id)}"], [name="${escapeAttr(id)}"]`)[0] : null);

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

    const match = targetId.match(/^(Mp|Sp|[0-9A-Za-z]+-Sp)[-_](.+)$/);
    if (!match) return null;
    const prefix = match[1];
    const candidates = (ext.deepQuerySelectorAll ? ext.deepQuerySelectorAll(document.body, `[id^="${escapeAttr(prefix)}-"], [id^="${escapeAttr(prefix)}_"]`)
                                                 : Array.from(document.querySelectorAll(`[id^="${escapeAttr(prefix)}-"], [id^="${escapeAttr(prefix)}_"]`)));

    // 2. 章・節を省いた短い形。段を取り除いた id が完全に一致するものだけを採る
    //    （後方一致だけで探すと「At_2」が別の段の「At_2」に当たりうる）
    const wanted = normalizeIdForMatch(targetId);
    // 段だけを指す id（Mp-Ch_3）は段を取ると何も残らず、どの要素とも一致してしまう
    for (let i = 0; wanted.length > prefix.length && i < candidates.length; i++) {
      if (normalizeIdForMatch(candidates[i].id) === wanted) return candidates[i];
    }

    // 3. 改正附則などの後方一致（区切りの直後から一致するものに限る）
    const tail = match[2];
    for (let i = 0; i < candidates.length; i++) {
      const id = candidates[i].id;
      if (id.length > tail.length && id.endsWith(tail) && /[-_]/.test(id[id.length - tail.length - 1])) {
        return candidates[i];
      }
    }

    return null;
  };

  /**
   * 目的の要素から、実際にスクロールおよびハイライトすべき可視要素（項・号・見出し等）を解決する。
   * 空の <a> アンカータグの場合は直近の最小可視コンテナ（項・号・条・見出し）を特定。
   * すでに可視要素自身（項や号など）である場合は、親の Article に無暗に拡大せずそのまま返す。
   *
   * @param {HTMLElement} targetEl - 解決前の要素
   * @returns {HTMLElement} スクロール・ハイライト対象の要素
   */
  ext.resolveScrollTarget = function(targetEl) {
    if (!targetEl) return null;

    // 空のアンカー <a> の場合
    if (targetEl.tagName && targetEl.tagName.toLowerCase() === 'a' && targetEl.hasAttribute('name')) {
      // 1. 最小の可視ブロック親要素（項、号、条見出し、条文）があるか探索
      const closestBlock = targetEl.closest('._div_Paragraph, .Paragraph, ._div_Item, .Item, ._div_Subitem1, .Subitem1, ._div_ArticleTitle, .ArticleTitle, ._div_Article, Article');
      if (closestBlock) {
        return closestBlock;
      }

      // 2. 親コンテナがないフラット構造の場合、直後の可視要素を探索
      let sib = targetEl.nextElementSibling;
      while (sib) {
        if (sib.offsetHeight > 0 || (sib.textContent && sib.textContent.trim().length > 0)) {
          return sib;
        }
        sib = sib.nextElementSibling;
      }
      return targetEl;
    }

    // すでに可視要素（_div_Paragraph, _div_Item, _div_ArticleTitle 等）の場合はそのまま返す
    return targetEl;
  };

  /**
   * 実行中の位置保持（pinScrollTarget）
   * @type {{stop: Function, target: Element}|null}
   */
  let activePin = null;

  /** 実行中の位置保持を止める */
  ext.cancelScrollPin = function() {
    if (activePin) activePin.stop();
  };

  /**
   * 目的の要素を、スクロール枠の上端から offset の位置にしばらくとどめる。
   *
   * なぜ要るか：高速レンダリング（content-visibility:auto）は画面外の条を仮の高さ 350px で並べる。
   * 移動した直後に、目的の条より上にある条が実寸で描かれて縮む（または伸びる）と、
   * ブラウザのスクロールアンカリングでは補われず、目的の条が画面の外へ押し出される
   * （実測：憲法第九条へのリンクで 1,239px、建築基準法第二条第十四号で 280px 上にずれ、
   * 画面には第十八号が出ていた）。横書き変換や引用ボタンの挿入も同じ時期に高さを変える。
   * そこで、ずれが落ち着くまで毎フレーム位置を測って戻す。
   * 利用者が自分でスクロールし始めたら（ホイール・タッチ・キー・マウスボタン）すぐ手を離す。
   *
   * @param {Element} target
   * @param {Object} [opts]
   * @param {number} [opts.offset] - 枠の上端からの位置（省略時は updateHeaderOffset）
   * @param {number} [opts.minDuration=1500] - 少なくともこの時間は見張る（ms）
   * @param {number} [opts.settle=1000] - この時間ずれが出なければ終える（ms）
   * @param {number} [opts.maxDuration=8000] - 最長の見張り時間（ms）
   * @returns {{stop: Function}|null}
   */
  ext.pinScrollTarget = function(target, opts = {}) {
    ext.cancelScrollPin();
    if (!target || typeof target.getBoundingClientRect !== 'function') return null;

    const scroller = opts.scroller || ext.getScrollContainer(target);
    const offset = typeof opts.offset === 'number' ? opts.offset : ext.updateHeaderOffset(scroller);
    const minDuration = typeof opts.minDuration === 'number' ? opts.minDuration : 1500;
    const settle = typeof opts.settle === 'number' ? opts.settle : 1000;
    const maxDuration = typeof opts.maxDuration === 'number' ? opts.maxDuration : 8000;

    const raf = typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame.bind(window)
      : (fn) => setTimeout(fn, 16);
    const caf = typeof window.cancelAnimationFrame === 'function'
      ? window.cancelAnimationFrame.bind(window)
      : clearTimeout;
    const now = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

    // 時間は最初のフレームから数える。裏のタブで開いたページでは rAF が止まっており、
    // 開いた時刻から数えると、表に出したときにはもう見張りが終わっている
    let start = null;
    let lastMove = 0;
    let frame = null;
    let stopped = false;

    const USER_EVENTS = ['wheel', 'touchstart', 'keydown', 'mousedown'];
    const onUserInput = () => pin.stop();

    const pin = {
      target,
      stop() {
        if (stopped) return;
        stopped = true;
        if (frame !== null) caf(frame);
        USER_EVENTS.forEach(type => window.removeEventListener(type, onUserInput, true));
        if (activePin === pin) activePin = null;
      }
    };

    const place = () => {
      const delta = Math.round(topWithinScroller(target, scroller) - offset);
      if (Math.abs(delta) < 1) return;
      const before = scrollPosition(scroller);
      scrollScrollerBy(scroller, delta);
      // 端まで来て動けないときは「動いた」に数えない（数えると最長時間まで回り続ける）
      if (Math.abs(scrollPosition(scroller) - before) >= 1) lastMove = now();
    };

    const loop = () => {
      frame = null;
      if (stopped) return;
      // 外された・隠された要素は位置が測れないのでやめる
      if (!target.isConnected || (typeof target.checkVisibility === 'function' && !target.checkVisibility())) {
        pin.stop();
        return;
      }
      const t = now();
      if (start === null) { start = t; lastMove = t; }
      place();
      const elapsed = t - start;
      if (elapsed >= maxDuration || (elapsed >= minDuration && t - lastMove >= settle)) {
        pin.stop();
        return;
      }
      frame = raf(loop);
    };

    USER_EVENTS.forEach(type => window.addEventListener(type, onUserInput, { capture: true, passive: true }));
    activePin = pin;
    if (isSkippedByContentVisibility(target)) {
      // 位置を測れないので、まずブラウザに描かせて寄せる（測って直すのは次のフレームから）
      scrollIntoViewInstant(target);
    } else {
      place();
    }
    frame = raf(loop);
    return pin;
  };

  /**
   * 着地した要素を一時的にハイライトする（どの項・号に来たかを目で確かめられるように）
   * @param {Element} el
   */
  ext.flashJumpTarget = function(el) {
    if (!el || !el.classList) return;
    el.classList.remove('egov-ext-jump-target');
    if (ext._flashTimers) ext._flashTimers.forEach(t => clearTimeout(t));
    ext._flashTimers = [];
    ext._flashTimers.push(setTimeout(() => {
      el.classList.add('egov-ext-jump-target');
      ext._flashTimers.push(setTimeout(() => el.classList.remove('egov-ext-jump-target'), 2500));
    }, 10));
  };

  /**
   * 条文の中の要素へ移動する（条文ジャンプ・ポップアップの「ジャンプ」ボタン）。
   *
   * 近い移動だけ滑らかに動かし、遠い移動は瞬時に飛ぶ。遠くまで smooth で動かすと、
   * 途中の条が仮の高さから実寸に変わるたびに行き先がずれ、着いたあとで大きく跳ねる。
   * どちらも着いたあとは pinScrollTarget で位置を保つ。
   *
   * @param {HTMLElement} target - スクロール先の要素
   * @param {Object} [opts]
   * @param {Element} [opts.flashTarget] - 着いたあと光らせる要素（省略時は target）
   * @param {boolean} [opts.remember=true] - 移動の前に読んでいた位置を控える（「元の位置へ戻る」用）
   */
  ext.fastSmoothScroll = function(target, opts = {}) {
    if (!target) return;

    const scrollTarget = ext.resolveScrollTarget ? ext.resolveScrollTarget(target) : target;
    if (!scrollTarget || typeof scrollTarget.getBoundingClientRect !== 'function') return;

    ext.cancelScrollPin();
    if (ext._pendingSmoothScroll) ext._pendingSmoothScroll();

    const scroller = ext.getScrollContainer(scrollTarget);
    const offset = ext.updateHeaderOffset(scroller);
    const viewHeight = isDocumentScroller(scroller) ? (window.innerHeight || 800) : (scroller.clientHeight || 800);
    // 描かれていない要素は位置が当てにならないので、遠いものとして扱う
    const delta = isSkippedByContentVisibility(scrollTarget)
      ? Infinity
      : Math.round(topWithinScroller(scrollTarget, scroller) - offset);

    // 画面の半分より遠くへ動くときは、読んでいた位置を控えておく（右下の「戻る」ボタンで戻れる）
    if (opts.remember !== false && Math.abs(delta) > viewHeight / 2 && ext.rememberReadingPosition) {
      ext.rememberReadingPosition(scroller);
    }

    const reduceMotion = typeof window.matchMedia === 'function' &&
                         window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const scrollApi = isDocumentScroller(scroller) ? window : scroller;

    if (Math.abs(delta) <= viewHeight * 1.5 && !reduceMotion && typeof scrollApi.scrollBy === 'function') {
      try {
        scrollApi.scrollBy({ top: delta, behavior: 'smooth' });
      } catch (e) {
        scrollScrollerBy(scroller, delta);
      }
      // 滑らかに動いている間は位置を直さない（直すと動きと取り合う）。止まってから保つ
      const eventTarget = isDocumentScroller(scroller) ? window : scroller;
      let timer = null;
      const startPin = () => {
        eventTarget.removeEventListener('scrollend', startPin);
        clearTimeout(timer);
        ext._pendingSmoothScroll = null;
        ext.pinScrollTarget(scrollTarget, { scroller, offset });
      };
      eventTarget.addEventListener('scrollend', startPin, { once: true });
      timer = setTimeout(startPin, 700);
      ext._pendingSmoothScroll = () => {
        eventTarget.removeEventListener('scrollend', startPin);
        clearTimeout(timer);
        ext._pendingSmoothScroll = null;
      };
    } else {
      // 遠い移動はブラウザの scrollIntoView で寄せる（途中の条の描き直しも含めて一度で済む）
      scrollIntoViewInstant(scrollTarget);
      ext.pinScrollTarget(scrollTarget, { scroller, offset });
    }

    ext.flashJumpTarget(opts.flashTarget || scrollTarget);
  };
  /**
   * 参照条文ポップアップや定義語ツールチップ用のDOMを整形する共通関数
   * 条番号、項番号、号番号、各カラムをインライン配置し、余計な改行を除去して
   * 原文法令通りの自然な横並び・全角スペース区切りレイアウトを構築する。
   * @param {HTMLElement} container - ポップアップの本文要素
   */
  ext.formatInlinePreview = function(container) {
    if (!container) return;

    // ポップアップ・プレビュー内に混入した引用ボタンなどの自作UI要素を確実に除去
    const unwantedElements = container.querySelectorAll('.egov-ext-citation-btn, [class*="citation-btn"], .egov-ext-backref-btn, .egov-ext-note-flag');
    unwantedElements.forEach(el => el.remove());

    const isHorizontalOn = !ext.settings || ext.settings.horizontal !== false;

    // 0. 要素間の改行・インデントのみで構成された不要な空白テキストノードを除去
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    const toRemove = [];
    const textNodes = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (/^[\r\n\t ]+$/.test(node.nodeValue)) {
        toRemove.push(node);
      } else {
        textNodes.push(node);
      }
    }
    toRemove.forEach(n => n.remove());

    // 各テキストノードの先頭・末尾にある余計な改行やインデントを除去し、空になったノードはDOMから完全除去
    textNodes.forEach(n => {
      n.nodeValue = n.nodeValue.replace(/^[\r\n\t ]+/, '').replace(/[\r\n\t ]+$/, '');
      if (!n.nodeValue) {
        n.remove();
      }
    });

    // 1. 条タイトル (ArticleTitle) のインライン化 & 直後第1項 (Paragraph) のインライン化
    const articleTitles = container.querySelectorAll('._div_ArticleTitle, .ArticleTitle');
    articleTitles.forEach(t => {
      t.classList.add('egov-ext-inline');
      Array.from(t.children).forEach(child => {
        if (child.tagName.toLowerCase() === 'div') {
          child.classList.add('egov-ext-inline');
        }
      });
      // 末尾を整理し、厳密に1つの全角スペースで終わるように正規化
      let tText = t.textContent.replace(/[　 ]+$/, '');
      if (isHorizontalOn && ext.convertLawTextToHorizontal) {
        tText = ext.convertLawTextToHorizontal(tText);
      }
      t.textContent = tText + '　';

      // 条タイトルの直後にある第1項（Paragraph）をインライン化して横並びにする
      let nextPara = t.nextElementSibling;
      while (nextPara && !nextPara.matches('._div_Paragraph, .Paragraph, .paragraph')) {
        if (nextPara.matches('._div_ArticleTitle, .ArticleTitle')) break;
        nextPara = nextPara.nextElementSibling;
      }
      if (!nextPara) {
        const parentArticle = t.closest('._div_Article, .Article, article');
        if (parentArticle) {
          nextPara = parentArticle.querySelector('._div_Paragraph, .Paragraph, .paragraph');
        }
      }
      if (nextPara) {
        nextPara.classList.add('egov-ext-inline');
        Array.from(nextPara.children).forEach(child => {
          if (child.tagName.toLowerCase() === 'div') {
            child.classList.add('egov-ext-inline');
          }
        });
        // nextPara の先頭にある余計な全角・半角スペースを除去して二重空白を防止
        const nextTextNodes = [];
        const nextWalker = document.createTreeWalker(nextPara, NodeFilter.SHOW_TEXT, null);
        while (nextWalker.nextNode()) {
          nextTextNodes.push(nextWalker.currentNode);
        }
        for (let i = 0; i < nextTextNodes.length; i++) {
          const tNode = nextTextNodes[i];
          tNode.nodeValue = tNode.nodeValue.replace(/^[　 \t\r\n]+/, '');
          if (!tNode.nodeValue) {
            tNode.remove();
          } else {
            break;
          }
        }
      }
    });

    // 2. 項番号 (ParagraphNum) / 条タイトル (paragraphtitle) のインライン化 & 算用数字変換
    const paraNums = container.querySelectorAll('._div_ParagraphNum, .ParagraphNum, .paragraphtitle');
    paraNums.forEach(pn => {
      pn.classList.add('egov-ext-inline');
      if (isHorizontalOn) {
        if (/第[一二三四五六七八九十百千0-9０-９]+条/.test(pn.textContent) && ext.convertLawTextToHorizontal) {
          pn.textContent = ext.convertLawTextToHorizontal(pn.textContent);
        } else if (ext.convertParagraphNumToHorizontal) {
          pn.textContent = ext.convertParagraphNumToHorizontal(pn.textContent);
        }
      }
      let pnText = pn.textContent.replace(/[　 ]+$/, '');
      pn.textContent = pnText + '　';

      // 直後の後続要素（sentence等）の先頭にある余計な全角・半角スペースを除去して二重空白を防止
      const nextElem = pn.nextElementSibling;
      if (nextElem) {
        const nextTextNodes = [];
        const nextWalker = document.createTreeWalker(nextElem, NodeFilter.SHOW_TEXT, null);
        while (nextWalker.nextNode()) {
          nextTextNodes.push(nextWalker.currentNode);
        }
        for (let i = 0; i < nextTextNodes.length; i++) {
          const tNode = nextTextNodes[i];
          tNode.nodeValue = tNode.nodeValue.replace(/^[　 \t\r\n]+/, '');
          if (!tNode.nodeValue) {
            tNode.remove();
          } else {
            break;
          }
        }
      }
    });

    // 3. 号番号 (ItemTitle) のインライン化 & 算用数字(1)化
    const itemTitles = container.querySelectorAll('._div_ItemTitle, .ItemTitle, .itemtitle, .egov-ext-preview-item-title, [class*="ItemTitle"]');
    itemTitles.forEach(it => {
      it.classList.add('egov-ext-inline');
      if (isHorizontalOn && ext.convertItemTitleToHorizontal) {
        it.textContent = ext.convertItemTitleToHorizontal(it.textContent);
      }
      // 末尾の全角・半角スペースを整理し、厳密に1つの全角スペースで終わるように正規化
      let itText = it.textContent.replace(/[　 ]+$/, '');
      it.textContent = itText + '　';

      // 直後の後続要素（ItemSentence等）の先頭にある余計な全角・半角スペースを除去して二重空白を防止
      const nextElem = it.nextElementSibling;
      if (nextElem) {
        const nextTextNodes = [];
        const nextWalker = document.createTreeWalker(nextElem, NodeFilter.SHOW_TEXT, null);
        while (nextWalker.nextNode()) {
          nextTextNodes.push(nextWalker.currentNode);
        }
        for (let i = 0; i < nextTextNodes.length; i++) {
          const tNode = nextTextNodes[i];
          tNode.nodeValue = tNode.nodeValue.replace(/^[　 \t\r\n]+/, '');
          if (!tNode.nodeValue) {
            tNode.remove();
          } else {
            break;
          }
        }
      }
    });

    // 4. カラム (Column) のインライン化 & カラム間全角スペース補完
    const columns = container.querySelectorAll('._div_Column, .Column, .column, [class*="Column"]');
    columns.forEach(col => {
      col.classList.add('egov-ext-inline');
      Array.from(col.children).forEach(child => {
        if (child.tagName.toLowerCase() === 'div') {
          child.classList.add('egov-ext-inline');
        }
      });
      const next = col.nextElementSibling;
      if (next && next.matches('._div_Column, .Column, .column, [class*="Column"]')) {
        // 1. col の末尾にある全角・半角スペース（および空テキストノード）を逆順走査で確実に除去
        const colTextNodes = [];
        const colWalker = document.createTreeWalker(col, NodeFilter.SHOW_TEXT, null);
        while (colWalker.nextNode()) {
          colTextNodes.push(colWalker.currentNode);
        }
        for (let i = colTextNodes.length - 1; i >= 0; i--) {
          const tNode = colTextNodes[i];
          tNode.nodeValue = tNode.nodeValue.replace(/[　 \t\r\n]+$/, '');
          if (!tNode.nodeValue) {
            tNode.remove();
          } else {
            break;
          }
        }

        // 2. next の先頭にある全角・半角スペース（および空テキストノード）を順方向走査で確実に除去
        const nextTextNodes = [];
        const nextWalker = document.createTreeWalker(next, NodeFilter.SHOW_TEXT, null);
        while (nextWalker.nextNode()) {
          nextTextNodes.push(nextWalker.currentNode);
        }
        for (let i = 0; i < nextTextNodes.length; i++) {
          const tNode = nextTextNodes[i];
          tNode.nodeValue = tNode.nodeValue.replace(/^[　 \t\r\n]+/, '');
          if (!tNode.nodeValue) {
            tNode.remove();
          } else {
            break;
          }
        }

        // 3. col と next の間にある既存の余計な空白テキストノードを除去
        let sib = col.nextSibling;
        while (sib && sib !== next) {
          const nextSib = sib.nextSibling;
          if (sib.nodeType === Node.TEXT_NODE) {
            sib.remove();
          }
          sib = nextSib;
        }

        // 4. カラム間に厳密に1つの全角スペースを挿入
        col.insertAdjacentText('afterend', '　');
      }
    });

    // 5. 段落・号・文コンテナのインライン化と余計な改行の除去
    const sentences = container.querySelectorAll('._div_ParagraphSentence, .ParagraphSentence, ._div_ItemSentence, .ItemSentence, ._div_Sentence, .Sentence, .sentence, ._div_Item, .Item, .item');
    sentences.forEach(s => {
      s.classList.add('egov-ext-inline');
      s.querySelectorAll('br').forEach(br => br.remove());
    });

    // 6. 重複全角スペースの最終正規化（同一テキストノード内集約＋要素境界をまたぐ二重空白の根絶）
    container.normalize();
    const finalWalker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    let prevTextNode = null;
    while (finalWalker.nextNode()) {
      const node = finalWalker.currentNode;
      // 単一テキストノード内の連続全角スペースを集約
      if (node.nodeValue.includes('　　')) {
        node.nodeValue = node.nodeValue.replace(/　{2,}/g, '　');
      }
      // 要素境界をまたぐ二重空白（前のノード末尾が全角空白、かつ現在のノード先頭も全角空白）を正規化
      if (prevTextNode && /[　 ]+$/.test(prevTextNode.nodeValue) && /^[　 ]+/.test(node.nodeValue)) {
        node.nodeValue = node.nodeValue.replace(/^[　 ]+/, '');
      }
      if (node.nodeValue) {
        prevTextNode = node;
      }
    }
  };

  /**
   * ツールチップ・プレビューヘッダー用のコンパクトなアクションボタンを生成する共通関数
   * @param {Object} options
   * @param {'open'|'jump'} options.icon - アイコン種類
   * @param {string} options.label - ボタンのテキスト
   * @param {string} options.title - title / aria-label 属性
   * @param {string} [options.url] - 展開先URL（別タブで開く場合）
   * @param {string} [options.targetId] - スクロール先要素ID（ジャンプの場合）
   * @param {Function} [options.onClick] - クリック時のコールバック
   * @returns {HTMLButtonElement}
   */
  ext.createTipActionButton = function(options) {
    const { icon = 'open', label = '開く', title = '', url = '', targetId = '', onClick } = options || {};
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `egov-ext-tip-action-btn egov-ext-btn-${icon}`;
    btn.dataset.action = icon;
    if (url) btn.dataset.url = url;
    if (targetId) btn.dataset.targetId = targetId;

    if (title) {
      btn.title = title;
      btn.setAttribute('aria-label', title);
    }

    let iconSvg = '';
    if (icon === 'open') {
      // 外部リンクアイコン（別タブで開く ↗）
      iconSvg = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>';
    } else if (icon === 'jump') {
      // 下向きジャンプ矢印アイコン（この条文へジャンプ ↓）
      iconSvg = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><polyline points="19 12 12 19 5 12"></polyline></svg>';
    }

    btn.innerHTML = `${iconSvg}<span>${label}</span>`;

    // 直接のクリックリスナーもバインド（クローンされない状況での高速即時実行）
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (typeof onClick === 'function') {
        onClick(e);
      } else if (icon === 'open' && url) {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    });

    return btn;
  };

  /**
   * ツールチップ内アクションボタン用グローバルイベントデリゲーション
   * （DOMが cloneNode(true) されて個別の addEventListener が消滅した場合でも確実に動作を保証）
   */
  if (typeof document !== 'undefined') {
    document.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('.egov-ext-tip-action-btn') : null;
      if (!btn) return;

      const action = btn.dataset.action;
      const url = btn.dataset.url;
      const targetId = btn.dataset.targetId;

      if (action === 'open' && url) {
        e.preventDefault();
        e.stopPropagation();
        window.open(url, '_blank', 'noopener,noreferrer');
      } else if (action === 'jump' && btn.dataset.defIndex !== undefined && ext.jumpToDefinition) {
        // 定義語ポップアップの「定義へ」
        e.preventDefault();
        e.stopPropagation();
        ext.jumpToDefinition(Number(btn.dataset.defIndex));
      } else if (action === 'jump') {
        e.preventDefault();
        e.stopPropagation();
        if (ext.referenceTooltip) {
          ext.referenceTooltip.hide(0);
        }
        if (targetId) {
          const targetEl = ext.resolveTargetElement ? ext.resolveTargetElement(targetId) : (document.getElementById(targetId) || document.querySelector(`[name="${targetId}"]`));
          if (targetEl && ext.fastSmoothScroll) {
            ext.fastSmoothScroll(targetEl);
          }
        }
      }
    }, true);
  }

})(window.egovExt);


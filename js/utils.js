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
  ext.SELF_UI_SELECTOR = '.egov-ext-tip, .egov-ext-header-container, #egov-ext-jump-container, #egov-ext-status-badge, .egov-ext-citation-btn';

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
   * すべての非同期タスクを中断する関数
   */
  ext.cancelAllTasks = function() {
    for (const name in ext.activeTasks) {
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
    ext.activeTasks[taskName] = state;

    let index = 0;
    function runNextChunk() {
      if (state.cancelled) {
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
   * 現在表示されているページが法令本文表示ページであるかをDOM構造から判定する関数
   * @returns {boolean} 法令表示ページの場合は true、それ以外は false
   */
  ext.checkIfLawPage = function() {
    const isUrlMatch = window.location.pathname.includes('/law/') || window.location.pathname.includes('/document');
    if (isUrlMatch) return true;

    // URL判定から漏れた場合でも、DOMに法令本文を示す主要クラスが存在していれば法令ページとみなす
    const hasLawDOM = ext.deepQuerySelectorAll(document.body, '.LawBody, .provisiontext, ._div_ParagraphSentence, .ParagraphSentence, ._div_ArticleTitle, .ArticleTitle, article.law, article.article, p.sentence');
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
   * ヘッダーコンテナ（ステータスバッジと条文ジャンプ検索ボックスを格納する親要素）を取得または作成する関数
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
   * 拡張機能の稼働状況を画面の右上のヘッダーエリアにバッジとして視覚表示する関数
   * @param {number|null} [termsCount=null] - 登録された定義語の件数
   */
  ext.updateStatusBadge = function(termsCount = null) {
    const existing = document.getElementById('egov-ext-status-badge');
    if (existing) {
      existing.remove();
    }
    
    if (!ext.settings.global) {
      ext.checkAndRemoveHeaderContainer();
      return;
    }

    const isLawPage = ext.checkIfLawPage();
    
    const badge = document.createElement('div');
    badge.id = 'egov-ext-status-badge';
    badge.className = 'egov-ext-status-badge';
    
    const dot = document.createElement('span');
    dot.style.width = '8px';
    dot.style.height = '8px';
    dot.style.borderRadius = '50%';
    dot.style.background = isLawPage ? '#4caf50' : '#ff9800'; // 法令ページは緑、その他はオレンジ
    dot.style.display = 'inline-block';
    
    badge.appendChild(dot);
    
    let label = isLawPage ? 'e-Gov実務サポート: 稼働中' : 'e-Gov実務サポート: 有効';
    if (isLawPage && ext.settings.definition) {
      const count = termsCount !== null ? termsCount : ext.definitionMap.size;
      label += ` (定義語: ${count}件)`;
    }
    badge.appendChild(document.createTextNode(label));
    
    const headerContainer = ext.getOrCreateHeaderContainer();
    if (headerContainer.firstChild) {
      headerContainer.insertBefore(badge, headerContainer.firstChild);
    } else {
      headerContainer.appendChild(badge);
    }
  };

  /**
   * スクロールアニメーションの requestAnimationFrame ID を管理する変数
   * @type {number|null}
   */
  ext.activeScrollAnimationFrame = null;

  /**
   * 固定ヘッダー（titlebarや上部ナビゲーション）の高さを測定し、
   * CSS変数 --egov-header-offset を更新する。
   * @returns {number} ヘッダーの高さ＋余白（ピクセル）
   */
  ext.updateHeaderOffset = function() {
    if (typeof document === 'undefined') return 72;
    let headerHeight = 0;
    const titlebar = document.getElementById('titlebar');
    if (titlebar && window.getComputedStyle) {
      const tbStyle = window.getComputedStyle(titlebar);
      if (tbStyle.position === 'fixed' || tbStyle.position === 'sticky') {
        headerHeight = Math.max(headerHeight, titlebar.offsetHeight || 0);
      }
    }
    const offset = Math.max(72, headerHeight + 20);
    if (document.documentElement && document.documentElement.style) {
      document.documentElement.style.setProperty('--egov-header-offset', `${offset}px`);
    }
    return offset;
  };

  /**
   * リンクの参照先 ID から、実際の対象要素を解決する共通関数。
   * ハイフン／アンダースコアの表記揺れ（Mp-At_ ⇄ Mp_At_）や改正附則の前方一致・後方一致に対応。
   *
   * @param {string} targetId - 要素IDまたはハッシュ
   * @returns {HTMLElement|null}
   */
  ext.resolveTargetElement = function(targetId) {
    if (!targetId || typeof document === 'undefined') return null;

    const findById = (id) => document.getElementById(id) ||
                             document.querySelector(`[name="${id}"]`) ||
                             (ext.deepQuerySelectorAll ? ext.deepQuerySelectorAll(document.body, `[id="${id}"], [name="${id}"]`)[0] : null);

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
             (ext.deepQuerySelectorAll ? ext.deepQuerySelectorAll(document.body, selector)[0] : null);
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
   * 自然で滑らかなスムーズスクロール関数
   * CSS scroll-margin-top とブラウザネイティブの scrollIntoView を活用し、
   * content-visibility: auto の仮想化を崩すことなく、固定ヘッダー下へ正確かつ滑らかにスクロールします。
   *
   * @param {HTMLElement} target - スクロール先の要素
   * @param {number} [customDuration=null] - オプション（互換性用）
   * @param {number} [topPadding=28] - オプション（互換性用）
   */
  ext.fastSmoothScroll = function(target, customDuration = null, topPadding = 28) {
    if (!target) return;

    // ヘッダーオフセットCSS変数を最新化
    ext.updateHeaderOffset();

    // スクロール対象の可視要素をピンポイント解決（項・号・見出し等）
    const scrollTarget = ext.resolveScrollTarget ? ext.resolveScrollTarget(target) : target;
    if (!scrollTarget) return;

    // ブラウザネイティブの scrollIntoView による滑らかなスクロール（Compositor駆動）
    if (scrollTarget.scrollIntoView) {
      try {
        scrollTarget.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (e) {
        scrollTarget.scrollIntoView(true);
      }
    } else if (typeof window !== 'undefined' && window.scrollTo) {
      const rect = scrollTarget.getBoundingClientRect ? scrollTarget.getBoundingClientRect() : { top: 0 };
      const offset = ext.updateHeaderOffset ? ext.updateHeaderOffset() : 72;
      const top = (window.pageYOffset || 0) + rect.top - offset;
      window.scrollTo(0, Math.max(0, top));
    }

    // ハイライトアニメーションの付与（既存のアニメーションをリセットして再発火）
    scrollTarget.classList.remove('egov-ext-jump-target');
    setTimeout(() => {
      scrollTarget.classList.add('egov-ext-jump-target');
      setTimeout(() => {
        scrollTarget.classList.remove('egov-ext-jump-target');
      }, 2500);
    }, 10);
  };

  /**
   * ポップアップ表示用にDOM要素（見出しと本文）をインライン化・成形する共通関数
   * @param {HTMLElement} container - 成形対象のコンテナ要素
   */
  ext.formatInlinePreview = function(container) {
    // ポップアップ・プレビュー内に混入した引用ボタンなどの自作UI要素を確実に除去
    const unwantedElements = container.querySelectorAll('.egov-ext-citation-btn, [class*="citation-btn"]');
    unwantedElements.forEach(el => el.remove());

    const titles = container.querySelectorAll('._div_ArticleTitle, .ArticleTitle, .paragraphtitle');

    titles.forEach(t => {
      t.classList.add('egov-ext-inline');
      let hasInnerDiv = false;
      Array.from(t.children).forEach(child => {
         if (child.tagName.toLowerCase() === 'div') {
           child.classList.add('egov-ext-inline');
           hasInnerDiv = true;
         }
      });
      if (!hasInnerDiv) {
        if (!t.textContent.includes('　')) {
          const space = document.createElement('span');
          space.textContent = '　';
          t.appendChild(space);
        }
      }
    });

    const sentences = container.querySelectorAll('._div_ParagraphSentence, .ParagraphSentence, ._div_ItemSentence, .ItemSentence, ._div_Sentence, .Sentence, .sentence');
    sentences.forEach(s => {
      const text = s.textContent.trim();
      if (!/^[0-9０-９]/.test(text)) {
        s.classList.add('egov-ext-inline');
        s.querySelectorAll('br').forEach(br => br.remove());
      }
    });
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


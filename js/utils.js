/**
 * utils.js
 * 
 * 共通設定、非同期タスク制御、DOMユーティリティ、漢数字変換などの
 * 汎用ヘルパー関数および共有状態を管理するモジュール。
 */

window.egovExt = window.egovExt || {};

(function(ext) {
  /**
   * グローバルな設定状態を保持するオブジェクト。デフォルト値はすべて true（オン）。
   * @type {Object<string, boolean>}
   */
  ext.settings = {
    global: true,
    scrollspy: true,
    popup: true,
    definition: true,
    newtab: true,
    dim: true,
    jump: true,
    horizontal: true,
    fastrender: true,
    citation: true
  };

  /**
   * 非同期実行タスクの追跡管理オブジェクト（多重起動防止およびキャンセル排他制御用）
   * @type {Object<string, Object|null>}
   */
  ext.activeTasks = {
    horizontal: null,
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

    // 目次（サイドバー）の要素はイベントリスナ破壊防止のため、innerHTMLによる保存・復元の対象外とする
    if (element.closest && element.closest('.sidebar, #sidebar, .toc')) {
      return;
    }

    // 親子要素の二重管理・復元競合を防ぐため、標準的な行・段落コンテナ（最外ブロック）を特定して退避する
    const targetSelector = [
      '._div_Paragraph', '.Paragraph',
      '._div_Item', '.Item',
      '._div_Subitem', '.Subitem',
      '._div_ArticleTitle', '.ArticleTitle',
      '._div_ArticleCaption', '.ArticleCaption',
      '._div_ParagraphSentence', '.ParagraphSentence',
      '._div_ItemSentence', '.ItemSentence',
      '._div_SubitemSentence', '.SubitemSentence'
    ].join(', ');

    const target = element.closest ? element.closest(targetSelector) : null;
    const actualElement = target || element;

    if (actualElement._egov_originalHTML === undefined) {
      actualElement._egov_originalHTML = actualElement.innerHTML;
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
   * 復元処理後に正規化（テキストノードの結合）を行う対象要素のセット
   * @type {Set<HTMLElement>}
   */
  ext.normalizeQueue = new Set();

  /**
   * ページ内に Shadow Root が存在するかどうかのフラグ
   * @type {boolean}
   */
  ext.hasShadowRoots = false;

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
    ext.cancelTask('horizontal');
    ext.cancelTask('dim');
    ext.cancelTask('definitionExtract');
    ext.cancelTask('definitionHighlight');
    ext.cancelTask('horizontal_leaf');
    ext.cancelTask('horizontal_item');
    ext.cancelTask('horizontal_para');
  };

  /**
   * 登録された要素のテキストノードを結合（正規化）してキャッシュをクリアする関数
   */
  ext.processNormalizeQueue = function() {
    if (!ext.normalizeQueue) return;
    ext.normalizeQueue.clear();
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
   * イベントの伝播経路（Shadow DOM を含む）を走査して、指定のセレクタにマッチする要素を見つける
   * @param {Event} event - ブラウザのイベントオブジェクト
   * @param {string} selector - 検索対象のCSSセレクタ
   * @returns {HTMLElement|null} マッチした最も近い要素、見つからない場合は null
   */
  ext.getComposedTarget = function(event, selector) {
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

    // 高速化パス: ページ内に Shadow Root が見つかっていない場合、
    // または検索元ノードが法令本文やサイドバー配下であることが明確な場合は、通常の querySelectorAll を使用する
    const isMainOrSidebar = root.closest && (
      root.closest('.LawBody') || 
      root.closest('.main-content') || 
      root.closest('.provisiontext') || 
      root.closest('article.law') || 
      root.closest('.sidebar') || 
      root.closest('#sidebar') || 
      root.closest('.toc')
    );

    if (!ext.hasShadowRoots || isMainOrSidebar) {
      if (root.querySelectorAll) {
        try {
          const matches = root.querySelectorAll(selector);
          return Array.from(matches);
        } catch (e) {}
      }
      return results;
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
   * 現在スクロール中かどうかを示すフラグ
   * @type {boolean}
   */
  ext.isScrolling = false;

  /**
   * スクロール開始前に高速レンダリングが有効だったかどうかを保持するフラグ
   * @type {boolean}
   */
  ext.wasFastRenderEnabled = false;

  /**
   * カスタムの高速スムーズスクロール関数
   * @param {HTMLElement} target - スクロール先の要素
   * @param {number} [duration=250] - スクロールにかかる時間（ミリ秒）
   */
  ext.fastSmoothScroll = function(target, duration = 250) {
    // すでにスクロール中の場合は、もともと高速レンダリングが有効だったフラグを引き継ぐ
    let wasFastRenderEnabled = ext.isScrolling && ext.wasFastRenderEnabled;

    // 既存のスクロールアニメーションが動いている場合はキャンセル
    if (ext.activeScrollAnimationFrame !== null) {
      cancelAnimationFrame(ext.activeScrollAnimationFrame);
      ext.activeScrollAnimationFrame = null;
    }

    ext.isScrolling = true;

    function getScrollContainer(node) {
      let parent = node.parentElement;
      while (parent && parent !== document.body && parent !== document.documentElement) {
        const style = window.getComputedStyle(parent);
        if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && parent.scrollHeight > parent.clientHeight) {
          return parent;
        }
        parent = parent.parentElement;
      }
      return window;
    }

    const scrollContainer = getScrollContainer(target);
    const isWindow = scrollContainer === window;

    // 現在のスクロール位置を一時保存
    const startPosition = isWindow ? window.pageYOffset || document.documentElement.scrollTop : scrollContainer.scrollTop;

    // もともと高速レンダリングが有効だったか判定（引き継いでいない場合のみクラス所持状況から判定）
    if (!wasFastRenderEnabled) {
      wasFastRenderEnabled = document.body.classList.contains('egov-fastrender-enabled');
    }
    ext.wasFastRenderEnabled = wasFastRenderEnabled;

    // クラスを削除して全体のレイアウト高さを確定させる
    if (document.body.classList.contains('egov-fastrender-enabled')) {
      document.body.classList.remove('egov-fastrender-enabled');
      // 強制的にドキュメント全体の再レイアウト（リフロー）を行い、要素の高さを確定させる
      document.body.offsetHeight;
    }

    // 正確なターゲットの絶対スクロール位置を取得する
    const targetRect = target.getBoundingClientRect();
    const targetPosition = isWindow 
      ? targetRect.top + (window.pageYOffset || document.documentElement.scrollTop)
      : scrollContainer.scrollTop + targetRect.top - scrollContainer.getBoundingClientRect().top;

    const distance = targetPosition - startPosition;

    let startTime = null;

    function animation(currentTime) {
      if (startTime === null) startTime = currentTime;
      const timeElapsed = currentTime - startTime;
      
      const progress = Math.min(timeElapsed / duration, 1);
      const ease = progress < 0.5 
        ? 2 * progress * progress 
        : -1 + (4 - 2 * progress) * progress;

      const currentScroll = startPosition + distance * ease;

      if (isWindow) {
        window.scrollTo(0, currentScroll);
      } else {
        scrollContainer.scrollTop = currentScroll;
      }

      if (timeElapsed < duration) {
        ext.activeScrollAnimationFrame = requestAnimationFrame(animation);
      } else {
        // アニメーション完了時は正確な目的地に完全に着地させる
        if (isWindow) {
          window.scrollTo(0, targetPosition);
        } else {
          scrollContainer.scrollTop = targetPosition;
        }

        ext.activeScrollAnimationFrame = null;
        ext.isScrolling = false;

        // 高速レンダリングを再有効化する
        if (wasFastRenderEnabled) {
          document.body.classList.add('egov-fastrender-enabled');
          // content-visibility: auto 適用による上部要素の高さ変動（縮小・膨張）と、
          // それに伴うスクロール位置の強制リセット・引き戻しを打ち消すため、
          // 同期的にリフローを発生させた上で正しい位置に再調整する。
          document.body.offsetHeight;
          target.scrollIntoView({ behavior: 'auto', block: 'start' });
        }
        ext.wasFastRenderEnabled = false;
      }
    }

    ext.activeScrollAnimationFrame = requestAnimationFrame(animation);
  };

  /**
   * ポップアップ表示用にDOM要素（見出しと本文）をインライン化・成形する共通関数
   * @param {HTMLElement} container - 成形対象のコンテナ要素
   */
  ext.formatInlinePreview = function(container) {
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

})(window.egovExt);

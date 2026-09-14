/**
 * content.js
 * 
 * オーケストレーター（監視およびイベント伝達）を担当するメインスクリプト。
 * 分割された各機能モジュール（utils, horizontal, dim, scrollspy, popup, jump, definition）
 * の呼び出し制御と、MutationObserverによる動的DOM監視を行います。
 */

window.egovExt = window.egovExt || {};

(function(ext) {
  /**
   * DOM更新の連続実行を遅延（デバウンス）させるためのタイマーID
   * @type {number|null}
   */
  let domUpdateTimer = null;

  /**
   * 前回の動的適用処理が実行されたタイムスタンプ（ミリ秒）
   * @type {number}
   */
  let lastExecutionTime = 0;

  /**
   * DOM更新適用をデバウンスする際の遅延時間（ミリ秒）
   * @type {number}
   */
  const DEBOUNCE_DELAY = 200;

  /**
   * DOM更新が頻発した際、最長で一度処理を強制適用する最大遅延（ミリ秒）
   * @type {number}
   */
  const MAX_DELAY = 1000;

  /**
   * MutationObserver で追加を検知したノードを「同期的に」変換する子孫要素数の上限。
   * これを超える大がかりなDOM入れ替えは、UIを固めないよう非同期の全体適用に委ねる。
   * @type {number}
   */
  const SYNC_PROCESS_LIMIT = 250;

  /**
   * 重複監視およびメモリリークを防ぐための、MutationObserver監視対象Shadow Root/要素のセット
   * @type {Set<Node>}
   */
  let observedRootsSet = new Set();

  /**
   * 前回処理時のページのURL文字列（定義語抽出の再処理判定用）
   * @type {string}
   */
  let lastObservedUrl = '';

  /**
   * 前回処理時の法令ID（同一法令内でのタブ切り替え時に定義語抽出をスキップするため）
   * @type {string}
   */
  let lastObservedLawId = '';

  /**
   * 別タブで開く機能のクリックリスナーが登録されたかどうかのフラグ
   * @type {boolean}
   */
  let newTabListenerAdded = false;

  /**
   * 拡張機能が読み込まれた時に最初に実行される初期化関数
   * @returns {Promise<void>}
   */
  async function init() {
    ext.log('init started');

    // 保存されているユーザー設定を読み込む（失敗時はデフォルト値が返る）
    ext.settings = await ext.loadSettings();
    ext.log('settings loaded:', ext.settings);

    try {
      // 読み込んだ設定を反映して各機能を初期適用する
      applySettings();

      // 画面の動的変化を常に見張るため、MutationObserverを開始する
      observeDOMChanges();
      ext.log('initialization complete');
    } catch (e) {
      console.error("egov-ext: Error during initialization execution:", e);
    }
  }

  /**
   * 現在の settings の状態に合わせて、各機能の有効/無効化や初期化を制御する司令塔関数
   */
  function applySettings() {
    ext.updateStatusBadge();
    if (ext.applyDefinitionColor) {
      ext.applyDefinitionColor(ext.settings.definitionColor);
    }

    if (!ext.settings.global) {
      document.body.classList.remove('egov-fastrender-enabled');
      
      // 監視を一時停止
      if (ext.globalDOMObserver) {
        ext.globalDOMObserver.disconnect();
        ext.globalDOMObserver = null;
      }
      observedRootsSet.clear();

      if (ext.disableDefinitionHighlighting) ext.disableDefinitionHighlighting();
      if (ext.disableConjunctionHighlight) ext.disableConjunctionHighlight();
      if (ext.disableDimParentheses) ext.disableDimParentheses();
      if (ext.removeHorizontalConversion) ext.removeHorizontalConversion();
      // 3機能の書き換えをまとめて1回だけ巻き戻す
      ext.restoreAllOriginalHTML();
      if (ext.removeJumpSearch) ext.removeJumpSearch();
      if (ext.disableCitations) ext.disableCitations();
      if (ext.scrollSpyObserver) {
        ext.scrollSpyObserver.disconnect();
        ext.scrollSpyObserver = null;
      }
      if (ext.scrollSpyRafId) {
        (typeof cancelAnimationFrame !== 'undefined' ? cancelAnimationFrame : clearTimeout)(ext.scrollSpyRafId);
        ext.scrollSpyRafId = null;
      }
      if (ext.referenceTooltip) ext.referenceTooltip.hide(true);
      if (ext.definitionTooltip) ext.definitionTooltip.hide(true);
      if (ext.citationTooltip) ext.citationTooltip.hide(true);
      return;
    }
    
    const wasFastRenderEnabled = document.body.classList.contains('egov-fastrender-enabled');
    const shouldFastRender = !!ext.settings.fastrender;

    if (wasFastRenderEnabled !== shouldFastRender) {
      // 1. 現在ビューポートの上部に見えている最適な要素を探し、その位置を記録
      let anchorEl = null;
      let originalTop = 0;
      
      // 法令本文コンテナを取得
      const container = ext.getLawContainer();

      // 憲法の前文や章タイトルなど、あらゆる法令構造のアンカーに対応するためスキャン対象のセレクタを拡充
      const selectors = [
        '.Article', '._div_Article',
        '.Paragraph', '._div_Paragraph',
        '.ParagraphSentence', '._div_ParagraphSentence',
        '.ChapterTitle', '._div_ChapterTitle',
        '.SectionTitle', '._div_SectionTitle',
        '.Preamble', '._div_Preamble',
        '.PreambleSentence',
        '.Item', '._div_Item',
        '.ItemSentence', '._div_ItemSentence',
        'div.sentence', 'p.sentence',
        '.AppdxTable', '._div_AppdxTable'
      ].join(', ');

      let candidateBlocks = Array.from(container.querySelectorAll(selectors));
      
      // 特殊なマークアップ等で1件も取得できなかった場合のフォールバックとして、コンテナ直下の子要素を取得
      if (candidateBlocks.length === 0) {
        candidateBlocks = Array.from(container.children);
      }

      let minDiff = Infinity;
      const headerOffset = 100; // e-Govヘッダー等の上部要素を避けるためのオフセット

      for (let i = 0; i < candidateBlocks.length; i++) {
        const el = candidateBlocks[i];
        const rect = el.getBoundingClientRect();
        // 画面上部を越えていない（または上部付近にある）要素
        if (rect.bottom > headerOffset) {
          const diff = Math.abs(rect.top - headerOffset);
          if (diff < minDiff) {
            minDiff = diff;
            anchorEl = el;
            originalTop = rect.top;
          }
        }
      }

      // 2. 高速レンダリングのトグル
      if (shouldFastRender) {
        document.body.classList.add('egov-fastrender-enabled');
      } else {
        document.body.classList.remove('egov-fastrender-enabled');
      }

      // 3. 強制リフローして高さを計算
      document.body.offsetHeight;

      // 4. スクロール位置の復元
      if (anchorEl) {
        anchorEl.scrollIntoView({ behavior: 'auto', block: 'start' });
        const newTop = anchorEl.getBoundingClientRect().top;
        window.scrollBy(0, newTop - originalTop);
      }
    }

    if (ext.settings.newtab) enableNewTabLinks();
    
    // 監視が停止している場合は再開する
    if (!ext.globalDOMObserver) {
      observeDOMChanges();
    }
    
    // 画面の構造に依存する処理（薄字化など）を呼び出す
    handleDynamicContent(true);
  }

  /**
   * コミット中のDOM更新によるMutationObserverの無限ループを防ぐため、
   * 一時的切断後に以前の監視対象ルートをすべて再接続する関数
   */
  ext.reconnectDOMObserver = function() {
    if (!ext.globalDOMObserver) return;
    observedRootsSet.forEach(root => {
      if (root.isConnected) {
        try {
          ext.globalDOMObserver.observe(root, { childList: true, subtree: true, characterData: true });
        } catch (e) {
          observedRootsSet.delete(root);
        }
      } else {
        observedRootsSet.delete(root);
      }
    });
  };

  /**
   * ページ内（Shadow DOM を含む）のすべての Shadow Root を再帰的に走査し、
   * globalDOMObserverの監視対象に登録する関数（高速クエリ版）
   * @param {Node} root - 探索開始ノード
   */
  function findAndObserveShadows(root) {
    if (!root) return;

    const isShadowRoot = (typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot) ||
                         (root.nodeType === Node.DOCUMENT_FRAGMENT_NODE && root.host);
    if (root === document.body || isShadowRoot) {
      if (!observedRootsSet.has(root)) {
        observedRootsSet.add(root);
        try {
          ext.globalDOMObserver.observe(root, { childList: true, subtree: true, characterData: true });
        } catch (e) {
          console.error("egov-ext: Failed to observe root:", e);
          observedRootsSet.delete(root);
        }
      }
    }

    if (root.shadowRoot) {
      ext.hasShadowRoots = true;
      findAndObserveShadows(root.shadowRoot);
    }

    // 配下の全要素から Shadow Root を持つものを探す。
    // querySelectorAll('*') は巨大な配列を確保してしまうため、TreeWalker で逐次走査する。
    if (root.nodeType === Node.ELEMENT_NODE || root.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      try {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        while (walker.nextNode()) {
          const el = walker.currentNode;
          if (el.shadowRoot) {
            ext.hasShadowRoots = true;
            findAndObserveShadows(el.shadowRoot);
          }
        }
      } catch (e) {
        console.error("egov-ext: TreeWalker failed in findAndObserveShadows:", e);
      }
    }
  }

  /**
   * 追加ノードに対する Shadow Root 探索。
   * ページ全体を初回に走査した結果 Shadow Root が1つも無かった場合、
   * e-Gov は途中から Shadow DOM を生やさないため以降の再走査を丸ごと省略する。
   * （この分岐が無いと、拡張自身のDOM書き換えが発火させるミューテーションのたびに
   *   全要素走査が走り、巨大な法令ページで著しく重くなる）
   * @param {Node} node - 追加されたノード
   */
  function scanAddedNodeForShadows(node) {
    if (ext.shadowScanCompleted && !ext.hasShadowRoots) return;
    findAndObserveShadows(node);
  }

  /**
   * 拡張機能自身が挿入・装飾したUI要素かどうかを判定する。
   * 自作UIの追加や変更をMutationObserverで再帰走査しないようにするための重要ガード。
   * @param {Node} node
   * @returns {boolean}
   */
  function isSelfGeneratedElement(node) {
    if (!node) return false;
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!el) return false;

    const className = el.className || '';
    if (typeof className === 'string' && (className.includes('egov-ext-') || className.includes('egov-definition-'))) {
      return true;
    }

    if (el.closest && el.closest('.egov-ext-tip, .egov-ext-header-container, #egov-ext-jump-container, #egov-ext-status-badge, .egov-ext-citation-btn')) {
      return true;
    }

    return false;
  }

  /**
   * 画面の要素が変化したことを検知する「MutationObserver」を初期化・接続する関数
   */
  function observeDOMChanges() {
    if (ext.globalDOMObserver) {
      ext.globalDOMObserver.disconnect();
    }
    observedRootsSet.clear();
    ext.hasShadowRoots = false;

    ext.globalDOMObserver = new MutationObserver((mutations) => {
      const now = Date.now();

      // 1バッチ内で同じノードの子孫数を二度数えないためのメモ
      const descendantCountCache = new Map();
      /**
       * ノードの子孫要素数を SYNC_PROCESS_LIMIT を上限に数える（結果はバッチ内でキャッシュ）
       * @param {HTMLElement} node
       * @returns {number}
       */
      const countDescendants = (node) => {
        let cached = descendantCountCache.get(node);
        if (cached === undefined) {
          cached = ext.countDescendantsUpTo(node, SYNC_PROCESS_LIMIT);
          descendantCountCache.set(node, cached);
        }
        return cached;
      };

      // 新たに追加された DOM 要素のみを走査して Shadow Root 監視登録を拡張（自作要素は無視）
      for (let i = 0; i < mutations.length; i++) {
        const addedNodes = mutations[i].addedNodes;
        for (let j = 0; j < addedNodes.length; j++) {
          const node = addedNodes[j];
          if (node.nodeType === Node.ELEMENT_NODE && !isSelfGeneratedElement(node)) {
            scanAddedNodeForShadows(node);
          }
        }
      }

      // チラつき防止：新しく追加された要素や変更されたテキストノードに対して、同期的（即座）に変換を適用する
      let addedElementsToProcess = [];
      for (let i = 0; i < mutations.length; i++) {
        const mutation = mutations[i];
        if (mutation.type === 'childList') {
          const addedNodes = mutation.addedNodes;
          for (let j = 0; j < addedNodes.length; j++) {
            const node = addedNodes[j];
            if (node.nodeType === Node.ELEMENT_NODE && !isSelfGeneratedElement(node) && node.closest &&
                node.closest(ext.LAW_CONTAINER_SELECTOR)) {
              addedElementsToProcess.push(node);
            }
          }
        } else if (mutation.type === 'characterData') {
          const parent = mutation.target.parentNode; // テキストノードの親要素
          if (parent && !isSelfGeneratedElement(parent) && parent.closest && parent.closest(ext.LAW_CONTAINER_SELECTOR)) {
            addedElementsToProcess.push(parent);
          }
        }
      }

      if (addedElementsToProcess.length > 0) {
        // 一時的に監視を解除して、自らのDOM変更による無限ループを防ぐ
        if (ext.globalDOMObserver) {
          ext.globalDOMObserver.disconnect();
        }

        addedElementsToProcess.forEach(node => {
          // ノード配下の要素数が多すぎないかチェック（大がかりなDOM入れ替えの場合は非同期に任せる）
          if (countDescendants(node) < SYNC_PROCESS_LIMIT) {
            // 横書き表記変換 (同期的)
            if (ext.settings.global && ext.settings.horizontal && ext.applyHorizontalConversion) {
              try {
                ext.applyHorizontalConversion(node);
              } catch (e) {
                console.error("egov-ext: Error applying sync horizontal conversion:", e);
              }
            }
            // 括弧書きの薄字化・虹色カッコ (同期的)
            if (ext.settings.global && ext.settings.dim && ext.enableDimParentheses) {
              try {
                ext.enableDimParentheses(node);
              } catch (e) {
                console.error("egov-ext: Error enabling sync dim parentheses:", e);
              }
            }
            // 接続詞の色分け (同期的)
            if (ext.settings.global && ext.settings.conjunction && ext.enableConjunctionHighlight) {
              try {
                ext.enableConjunctionHighlight(node);
              } catch (e) {
                console.error("egov-ext: Error enabling sync conjunction highlight:", e);
              }
            }
            // 定義語ホバー辞書＆ハイライト (同期的)
            if (ext.settings.global && ext.settings.definition && ext.enableDefinitionHighlighting) {
              try {
                ext.enableDefinitionHighlighting(node);
              } catch (e) {
                console.error("egov-ext: Error enabling sync definition highlighting:", e);
              }
            }
          }
        });

        // 監視を再開
        ext.reconnectDOMObserver();
      }
      
      // 法令本文コンテナに関連する変更のみを適用対象にする (サイドバーやツールチップ等の変更による再レンダリングやチラつきを防止)
      let shouldUpdate = false;
      for (let i = 0; i < mutations.length; i++) {
        const mutation = mutations[i];

        // サイドバーや目次の開閉などの変更、および拡張機能の自作UI変更は無視する (チラつき・負荷防止)
        const target = mutation.target;
        if (isSelfGeneratedElement(target)) {
          continue;
        }
        if (target.closest && (target.closest(ext.SIDEBAR_SELECTOR) || target.closest('.egov-ext-tip'))) {
          continue;
        }

        // 追加ノードのうち、SYNC_PROCESS_LIMIT 未満のものは上で同期処理済みなので、非同期の全体適用は不要
        const addedNodes = mutation.addedNodes;
        let hasUnprocessedAddition = false;
        for (let j = 0; j < addedNodes.length; j++) {
          const node = addedNodes[j];
          if (node.nodeType === Node.ELEMENT_NODE && !isSelfGeneratedElement(node) && node.closest &&
              node.closest(ext.LAW_CONTAINER_SELECTOR) &&
              countDescendants(node) >= SYNC_PROCESS_LIMIT) {
            hasUnprocessedAddition = true;
            break;
          }
        }

        if (hasUnprocessedAddition) {
          shouldUpdate = true;
          break;
        }

        // 本文コンテナ内でノードの削除があった場合も、全体を再スキャンして辻褄を合わせる
        if (mutation.removedNodes && mutation.removedNodes.length > 0 &&
            target.closest && target.closest(ext.LAW_CONTAINER_SELECTOR)) {
          for (let j = 0; j < mutation.removedNodes.length; j++) {
            const rNode = mutation.removedNodes[j];
            if (rNode.nodeType === Node.ELEMENT_NODE && !isSelfGeneratedElement(rNode)) {
              shouldUpdate = true;
              break;
            }
          }
          if (shouldUpdate) break;
        }
      }

      if (!shouldUpdate) return;

      if (domUpdateTimer) clearTimeout(domUpdateTimer);
      
      // 前回の実行からすでにMAX_DELAY以上経過している場合は即時実行（スターベーション回避）
      if (now - lastExecutionTime >= MAX_DELAY) {
        lastExecutionTime = now;
        handleDynamicContent(false); // 動的DOM更新時は forceReset = false
      } else {
        domUpdateTimer = setTimeout(() => {
          lastExecutionTime = Date.now();
          handleDynamicContent(false); // 動的DOM更新時は forceReset = false
        }, DEBOUNCE_DELAY);
      }
    });

    // 初期状態で document.body 配下の Shadow DOM をすべて監視対象にする。
    // ここで Shadow Root が1つも見つからなければ、以降の再走査はスキップできる。
    findAndObserveShadows(document.body);
    ext.shadowScanCompleted = true;
    ext.log('shadow scan completed. hasShadowRoots:', ext.hasShadowRoots);
  }

  /**
   * 画面が書き換わった後に、各機能を再度適用し直すためのオーケストレーション関数
   * @param {boolean} [forceReset=false] - 既存の適用を一度クリアしてリセット適用するかどうか
   * @returns {Promise<void>}
   */
  async function handleDynamicContent(forceReset = false) {
    if (!ext.settings.global) return;

    // 進行中のDOM書き換えチャンク処理タスクをキャンセル（読み取り専用の定義語抽出は継続）
    ext.cancelAllTasks(['definitionExtract']);

    // 自分がDOMを書き換える間、一時的にObserverを止めて無限ループを防ぐ
    if (ext.globalDOMObserver) {
      ext.globalDOMObserver.disconnect();
    }

    const isLawPage = ext.checkIfLawPage();
    const currentUrl = window.location.href;
    const urlChanged = currentUrl !== lastObservedUrl;
    if (urlChanged) {
      lastObservedUrl = currentUrl;
    }

    const currentLawId = ext.getLawIdFromUrl(currentUrl);
    const lawIdChanged = currentLawId !== lastObservedLawId;
    if (lawIdChanged) {
      lastObservedLawId = currentLawId;
      if (ext.cancelTask) ext.cancelTask('definitionExtract');
      ext.definitionExtractionCompleted = false;
      ext.definitionExtractionPromise = null;
    }

    ext.log("handleDynamicContent called. forceReset:", forceReset, "urlChanged:", urlChanged, "isLawPage:", isLawPage);

    // 設定変更などで強制リセットが必要な場合のみ、元の状態に一度戻す
    if (forceReset) {
      try {
        if (ext.disableDefinitionHighlighting) ext.disableDefinitionHighlighting();
      } catch (e) {
        console.error("egov-ext: Error disabling definition highlighting:", e);
      }

      try {
        if (ext.disableConjunctionHighlight) ext.disableConjunctionHighlight();
      } catch (e) {
        console.error("egov-ext: Error disabling conjunction highlight:", e);
      }

      try {
        if (ext.disableDimParentheses) ext.disableDimParentheses();
      } catch (e) {
        console.error("egov-ext: Error disabling dim parentheses:", e);
      }

      try {
        if (ext.removeHorizontalConversion) ext.removeHorizontalConversion();
      } catch (e) {
        console.error("egov-ext: Error removing horizontal conversion:", e);
      }

      try {
        if (ext.disableCitations) ext.disableCitations();
      } catch (e) {
        console.error("egov-ext: Error disabling citations:", e);
      }

      // 各 disable は状態リセットのみを行う。DOM の巻き戻しはここで一度だけ実施する
      // （以前は3つの disable がそれぞれ全体復元を呼んでおり、同じ処理が3回走っていた）
      try {
        ext.restoreAllOriginalHTML();
      } catch (e) {
        console.error("egov-ext: Error restoring original HTML:", e);
      }
    }

    // 横書き表記変換 (全角算用数字＆半角かっこ号見出し)
    if (ext.settings.horizontal && isLawPage && ext.applyHorizontalConversion) {
      try {
        ext.applyHorizontalConversion();
      } catch (e) {
        console.error("egov-ext: Error applying horizontal conversion:", e);
      }
    }

    // 括弧書きの薄字化・虹色カッコ
    if (ext.settings.dim && isLawPage && ext.enableDimParentheses) {
      try {
        ext.enableDimParentheses();
      } catch (e) {
        console.error("egov-ext: Error enabling dim parentheses:", e);
      }
    }

    // 接続詞の色分け（又は・若しくは・並びに・及び）
    if (ext.settings.conjunction && isLawPage && ext.enableConjunctionHighlight) {
      try {
        ext.enableConjunctionHighlight();
      } catch (e) {
        console.error("egov-ext: Error enabling conjunction highlight:", e);
      }
    }
    
    // 定義語ホバー辞書＆ハイライト
    if (ext.settings.definition && isLawPage && ext.extractDefinitionsAsync && ext.enableDefinitionHighlighting) {
      try {
        const shouldExtract = forceReset || lawIdChanged || !ext.definitionExtractionCompleted || ext.definitionMap.size === 0;
        if (shouldExtract) {
          await ext.extractDefinitionsAsync();
        }
        ext.enableDefinitionHighlighting();
      } catch (e) {
        console.error("egov-ext: Error enabling definition highlighting:", e);
      }
    }
    
    // 別タブで開く機能
    if (ext.settings.newtab) {
      try {
        enableNewTabLinks();
      } catch (e) {
        console.error("egov-ext: Error enabling new tab links:", e);
      }
    }

    // ScrollSpy（目次ハイライト）
    if (ext.settings.scrollspy && isLawPage && ext.setupScrollSpy) {
      try {
        ext.setupScrollSpy();
      } catch (e) {
        console.error("egov-ext: Error setting up ScrollSpy:", e);
      }
    } else {
      if (ext.scrollSpyObserver) {
        ext.scrollSpyObserver.disconnect();
        ext.scrollSpyObserver = null;
      }
      if (ext.scrollSpyRafId) {
        (typeof cancelAnimationFrame !== 'undefined' ? cancelAnimationFrame : clearTimeout)(ext.scrollSpyRafId);
        ext.scrollSpyRafId = null;
      }
    }

    // 参照ポップアップ
    if (ext.settings.popup && ext.enablePopup) {
      try {
        ext.enablePopup();
      } catch (e) {
        console.error("egov-ext: Error enabling popup:", e);
      }
    }

    // 被引用（引用元）表示機能
    if (ext.settings.citation && isLawPage && ext.enableCitations) {
      try {
        ext.enableCitations();
      } catch (e) {
        console.error("egov-ext: Error enabling citations:", e);
      }
    } else {
      if (ext.disableCitations) ext.disableCitations();
    }

    // 条文ジャンプ検索
    if (ext.settings.jump && isLawPage && ext.setupJumpSearch) {
      try {
        ext.setupJumpSearch();
      } catch (e) {
        console.error("egov-ext: Error setting up jump search:", e);
      }
    } else {
      if (ext.removeJumpSearch) ext.removeJumpSearch();
    }

    // 同期的・即座にObserverを再開して、e-Gov公式による非同期なDOM更新を検知可能にする
    if (ext.globalDOMObserver) {
      ext.reconnectDOMObserver();
    }
  }

  /**
   * 別タブで開く機能のクリックイベントハンドラ
   * @param {MouseEvent} e - マウスクリックイベント
   */
  function handleNewTabClick(e) {
    if (!ext.settings.global || !ext.settings.newtab) return;
    
    const link = ext.getComposedTarget(e, 'a');
    if (!link || !link.hasAttribute('href')) return;
    
    if (ext.deepClosest(link, '.Article, .provisiontext, .lawdetailcontent, .dialog')) {
      return;
    }
    
    try {
      const href = link.getAttribute('href');
      if (href.includes('/law/') && link.pathname !== window.location.pathname) {
        e.preventDefault();
        e.stopPropagation();
        window.open(link.href, '_blank', 'noopener,noreferrer');
      }
    } catch (err) {}
  }

  /**
   * 別タブでのリンクオープン監視イベントを登録する関数
   */
  function enableNewTabLinks() {
    if (!newTabListenerAdded) {
      document.addEventListener('click', handleNewTabClick, true);
      newTabListenerAdded = true;
    }
  }

  // メッセージ監視 (通信の受け口)
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'SETTINGS_CHANGED') {
      ext.settings = request.settings;
      applySettings();
    }
  });

  // 実行開始のトリガー
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // テスト用内部オブジェクトの公開
  ext._testContent = {
    isSelfGeneratedElement
  };

})(window.egovExt);


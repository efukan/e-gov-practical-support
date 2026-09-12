/**
 * dim.js
 * 
 * 括弧書きの薄字化・虹色カッコのロジックを管理するモジュール。
 */

window.egovExt = window.egovExt || {};

(function(ext) {
  // カッコ判定用正規表現を定数化
  const PAREN_CHECK_REGEX = /[（()）]/;

  /**
   * 括弧書きの薄字化・虹色カッコをDOMに適用する関数
   * @param {HTMLElement|null} [targetContainer=null] - 適用対象のDOMコンテナ
   */
  ext.enableDimParentheses = function(targetContainer = null) {
    if (!targetContainer) {
      ext.cancelTask('dim');
    }
    document.body.classList.add('egov-ext-dim-active');
    
    const container = targetContainer || ext.getLawContainer();

    // 変換対象の末端ブロックを収集する。
    // サイドバー・タイトルバー・見出し等の除外も collectLeafBlocks が行う。
    const blocks = ext.collectLeafBlocks(container, targetContainer);

    // 残ったブロック内の「テキストそのもの」を解析していく
    const processDim = (block) => {
      // 高速化パス: 括弧が含まれないブロックは走査をスキップする
      if (!PAREN_CHECK_REGEX.test(block.textContent)) {
        return;
      }

      // 冪等性ガード: 既にこのブロックが薄字化処理済みの場合は二重処理をスキップ（カウント狂いや重複スパンを防止）
      if (block.querySelector && block.querySelector('.egov-ext-bracket')) {
        return;
      }

      if (ext.saveOriginalHTML) {
        ext.saveOriginalHTML(block);
      }
      
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null, false);
      const nodes = [];
      while(walker.nextNode()) {
        nodes.push(walker.currentNode);
      }

      // カッコの入れ子の深さを記録する状態オブジェクト
      let state = { parenDepth: 0 };
      
      nodes.forEach(node => {
        // 既に過去の処理で色分け用（spanタグ）に囲まれているテキストならスキップ
        if (node.parentNode && node.parentNode.classList && 
           (node.parentNode.classList.contains('egov-ext-dimmed-text') || node.parentNode.classList.contains('egov-ext-bracket'))) {
          return;
        }
        
        // テキストノードの親要素が対象外クラス（ItemTitleなど）または自作UIに含まれている場合はスキップ
        if (node.parentNode && node.parentNode.closest && 
           (node.parentNode.closest(ext.EXCLUDED_SELECTORS) || node.parentNode.closest(ext.SELF_UI_SELECTOR))) {
          return;
        }
        
        const text = node.nodeValue;
        if (!text) return;

        // フラグメント（仮想のDOMコンテナ）を作成
        const frag = document.createDocumentFragment();
        let currentStr = '';
        
        // テキストをspanタグで包んでフラグメントに押し込む関数
        const flush = (isDimmed) => {
          if (!currentStr) return;
          if (isDimmed) {
            const span = document.createElement('span');
            span.className = 'egov-ext-dimmed-text';
            span.textContent = currentStr;
            frag.appendChild(span);
          } else {
            frag.appendChild(document.createTextNode(currentStr));
          }
          currentStr = '';
        };
        
        // 1文字ずつ順番に読み取りながら、カッコの始まりと終わりを見つける
        for (let i = 0; i < text.length; i++) {
          const char = text[i];
          
          if (char === '（' || char === '(') {
            flush(state.parenDepth > 0);
            state.parenDepth++; // 入れ子レベルを +1 深くする
            const span = document.createElement('span');
            span.className = `egov-ext-bracket egov-ext-bracket-level-${state.parenDepth}`;
            span.textContent = char;
            frag.appendChild(span);
          } else if (char === '）' || char === ')') {
            if (state.parenDepth > 0) {
              flush(true);
              const span = document.createElement('span');
              span.className = `egov-ext-bracket egov-ext-bracket-level-${state.parenDepth}`;
              span.textContent = char;
              frag.appendChild(span);
              state.parenDepth--; // 括弧が閉じたので、入れ子レベルを -1 浅くする
            } else {
              currentStr += char;
            }
          } else {
            currentStr += char;
          }
        }
        
        flush(state.parenDepth > 0);
        
        // テキストが分割されて加工された場合のみ、元のテキストを書き換える
        if (frag.childNodes.length > 1 || (frag.childNodes.length === 1 && frag.firstChild.nodeType !== Node.TEXT_NODE)) {
          if (node.parentNode) {
            node.parentNode.replaceChild(frag, node);
          }
        }
      });
    };

    if (targetContainer) {
      blocks.forEach(processDim);
    } else {
      ext.runTaskInChunks('dim', blocks, processDim, 150);
    }
  };

  /**
   * 薄字化・虹色カッコを無効化する。
   * 進行中タスクの停止とクラス除去のみを行い、DOM の巻き戻しは行わない。
   * 巻き戻しは content.js が3機能ぶんをまとめて1回だけ実行する
   * （ext.restoreAllOriginalHTML は機能別ではなく全体を復元するため）。
   */
  ext.disableDimParentheses = function() {
    ext.cancelTask('dim');
    document.body.classList.remove('egov-ext-dim-active');
  };

})(window.egovExt);

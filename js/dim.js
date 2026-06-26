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
    
    const container = targetContainer || 
                      ext.deepQuerySelectorAll(document.body, '.main-content')[0] || 
                      ext.deepQuerySelectorAll(document.body, '.provisiontext')[0] || 
                      document.body;
    // 目次などのサイドバー、およびページ上部のタイトルバー部分は対象から外すための要素を取得
    const sidebar = document.querySelector('.sidebar, #sidebar, .toc') || ext.deepQuerySelectorAll(document.body, '.sidebar, #sidebar, .toc')[0];
    const titlebar = document.getElementById('titlebar');
    
    const allBlocks = [];
    if (targetContainer && targetContainer.matches && targetContainer.matches('div, p, h1, h2, h3, h4, h5, h6, li, td, th')) {
      allBlocks.push(targetContainer);
    }
    const queryBlocks = ext.deepQuerySelectorAll(container, 'div, p, h1, h2, h3, h4, h5, h6, li, td, th');
    allBlocks.push(...Array.from(queryBlocks));
    
    // 一番末端（それ以上内側にdiv等のブロック要素を持たない）ブロックだけを抽出
    const leafBlocks = Array.from(allBlocks).filter(el => {
      // もしその要素がサイドバーかタイトルバーの中にあったら無視する
      if (!targetContainer && ext.deepClosest(el, '.sidebar, #sidebar, .toc')) return false;
      if (titlebar && (titlebar === el || titlebar.contains(el))) return false;
      return ext.deepQuerySelectorAll(el, 'div, p, h1, h2, h3, h4, h5, h6, li, td, th').length === 0;
    });
    
    // 見出し部分の括弧や目次、タイムバーなどは対象外にする
    const excludedSelectors = [
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

    const blocks = leafBlocks.filter(block => {
      // block自体、または親要素のいずれかが上記のクラスを持っていれば除外する
      return !ext.deepClosest(block, excludedSelectors);
    });
    
    // 残ったブロック内の「テキストそのもの」を解析していく
    const processDim = (block) => {
      // 高速化パス: 括弧が含まれないブロックは走査をスキップする
      if (!PAREN_CHECK_REGEX.test(block.textContent)) {
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
        
        // テキストノードの親要素が対象外クラス（ItemTitleなど）に含まれている場合はスキップ
        if (node.parentNode && node.parentNode.closest && node.parentNode.closest(excludedSelectors)) {
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

  ext.disableDimParentheses = function() {
    ext.cancelTask('dim');
    document.body.classList.remove('egov-ext-dim-active');
    if (ext.restoreAllOriginalHTML) {
      ext.restoreAllOriginalHTML();
    }
  };

})(window.egovExt);

/**
 * dim.js
 * 
 * 括弧書きの薄字化・虹色カッコのロジックを管理するモジュール。
 */

window.egovExt = window.egovExt || {};

(function(ext) {
  // カッコ判定用正規表現を定数化
  const PAREN_CHECK_REGEX = /[（()）]/;

  // 法令番号の括弧判定用正規表現
  // 日本の法令番号（元号＋年＋種別＋号、枝番号、人事院規則等の特殊様式）に合致するパターン
  const LAW_NUMBER_REGEX = /^(?:明治|大正|昭和|平成|令和)[^）\n]+(?:法律|政令|府令|省令|庁令|規則|条約|勅令|告示|太政官布告|太政官達|閣令|院令|訓令|達)(?:第?[0-9０-９一二三四五六七八九十百千万]+号(?:の[0-9０-９一二三四五六七八九十百千万]+)?|[0-9０-９一二三四五六七八九十百千万]+(?:―[0-9０-９一二三四五六七八九十百千万]+)+)$/;
  ext.LAW_NUMBER_REGEX = LAW_NUMBER_REGEX;

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
        const node = walker.currentNode;
        // 既に過去の処理で色分け用（spanタグ）に囲まれているテキストならスキップ
        if (node.parentNode && node.parentNode.classList && 
           (node.parentNode.classList.contains('egov-ext-dimmed-text') || node.parentNode.classList.contains('egov-ext-bracket'))) {
          continue;
        }
        
        // テキストノードの親要素が対象外クラス（ItemTitleなど）または自作UIに含まれている場合はスキップ
        if (node.parentNode && node.parentNode.closest && 
           (node.parentNode.closest(ext.EXCLUDED_SELECTORS) || node.parentNode.closest(ext.SELF_UI_SELECTOR))) {
          continue;
        }
        nodes.push(node);
      }

      if (nodes.length === 0) return;

      // ブロック全体のテキストノードを連結し、各テキストノードの全体インデックス範囲をマッピング
      let fullText = '';
      const nodeRanges = [];
      nodes.forEach(node => {
        const start = fullText.length;
        fullText += node.nodeValue;
        const end = fullText.length;
        nodeRanges.push({ node, start, end });
      });

      // 括弧ペアを解析し、法令番号の括弧（元号〜号、末尾に「。」がないもの）を特定
      const stack = [];
      const lawNumberRanges = [];

      for (let i = 0; i < fullText.length; i++) {
        const char = fullText[i];
        if (char === '（' || char === '(') {
          stack.push({ openIdx: i });
        } else if (char === '）' || char === ')') {
          if (stack.length > 0) {
            const item = stack.pop();
            const openIdx = item.openIdx;
            const closeIdx = i;
            const inner = fullText.slice(openIdx + 1, closeIdx);
            const endsWithPeriod = /[。\.]$/.test(inner.trim());
            // 末尾に「。」がなく、かつ法令番号パターンに合致する括弧は法令番号として除外
            const isLawNum = !endsWithPeriod && LAW_NUMBER_REGEX.test(inner.trim());
            if (isLawNum) {
              lawNumberRanges.push({ start: openIdx, end: closeIdx + 1 });
            }
          }
        }
      }

      // 法令番号範囲内か判定するヘルパー（昇順インデックスによるO(1)ポインタ追従）
      let rangeIdx = 0;
      const isLawNumberIndex = (globalIdx) => {
        while (rangeIdx < lawNumberRanges.length && lawNumberRanges[rangeIdx].end <= globalIdx) {
          rangeIdx++;
        }
        if (rangeIdx < lawNumberRanges.length) {
          const r = lawNumberRanges[rangeIdx];
          return globalIdx >= r.start && globalIdx < r.end;
        }
        return false;
      };

      // カッコの入れ子の深さを記録する状態
      let parenDepth = 0;
      
      nodeRanges.forEach(({ node, start }) => {
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
          const globalIdx = start + i;
          const char = text[i];

          // 法令番号の括弧内（カッコ文字および内容）は薄字化・虹色カッコの対象外とし、通常のテキストとして保持
          if (isLawNumberIndex(globalIdx)) {
            currentStr += char;
            continue;
          }
          
          if (char === '（' || char === '(') {
            flush(parenDepth > 0);
            parenDepth++; // 入れ子レベルを +1 深くする
            const span = document.createElement('span');
            span.className = `egov-ext-bracket egov-ext-bracket-level-${parenDepth}`;
            span.textContent = char;
            frag.appendChild(span);
          } else if (char === '）' || char === ')') {
            if (parenDepth > 0) {
              flush(true);
              const span = document.createElement('span');
              span.className = `egov-ext-bracket egov-ext-bracket-level-${parenDepth}`;
              span.textContent = char;
              frag.appendChild(span);
              parenDepth--; // 括弧が閉じたので、入れ子レベルを -1 浅くする
            } else {
              currentStr += char;
            }
          } else {
            currentStr += char;
          }
        }
        
        flush(parenDepth > 0);
        
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

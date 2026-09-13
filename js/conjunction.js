/**
 * conjunction.js
 * 
 * 法令の接続詞（「並びに」「及び」「又は」「若しくは」）を検知し、
 * その階層関係（大グループ・小グループ）に合わせて色・太字・下線で色分けハイライトするモジュール。
 * 
 * 【並列】（青系）
 *   大：並びに ── 太字 ＋ 濃い青 ＋ 太下線
 *   小：及び   ── 通常 ＋ 青色     ＋ 細下線
 * 
 * 【選択】（赤系）
 *   大：又は   ── 太字 ＋ 濃い赤 ＋ 太下線
 *   小：若しくは ─ 通常 ＋ 赤色     ＋ 細下線
 */

window.egovExt = window.egovExt || {};

(function(ext) {
  // 接続詞判定用の高速チェック正規表現
  const CONJUNCTION_CHECK_REGEX = /(?:並びに|若しくは|及び|又は)/;

  // 抽出・分割用の正規表現（キャプチャ付き）
  const CONJUNCTION_SPLIT_REGEX = /(並びに|若しくは|及び|又は)/g;

  /**
   * 接続詞に対応するクラス名マッピング
   */
  const CONJUNCTION_CLASS_MAP = {
    '並びに': 'egov-conjunction egov-conjunction-and-major',
    '及び': 'egov-conjunction egov-conjunction-and-minor',
    '又は': 'egov-conjunction egov-conjunction-or-major',
    '若しくは': 'egov-conjunction egov-conjunction-or-minor'
  };

  /**
   * 接続詞の色分けハイライトをDOMに適用する関数
   * @param {HTMLElement|null} [targetContainer=null] - 適用対象のDOMコンテナ
   */
  ext.enableConjunctionHighlight = function(targetContainer = null) {
    if (!targetContainer) {
      ext.cancelTask('conjunction');
    }
    document.body.classList.add('egov-ext-conjunction-active');

    const container = targetContainer || ext.getLawContainer();
    if (!container) return;

    // 変換対象の末端ブロックを収集する（サイドバー・見出し等の除外もここで行われる）
    const blocks = ext.collectLeafBlocks(container, targetContainer);

    const processConjunction = (block) => {
      // 高速化パス: 接続詞が含まれないブロックは走査をスキップ
      if (!CONJUNCTION_CHECK_REGEX.test(block.textContent)) {
        return;
      }

      // 冪等性ガード: 既にこのブロックが接続詞ハイライト済みの場合は二重処理をスキップ
      if (block.querySelector && block.querySelector('.egov-conjunction')) {
        return;
      }

      if (ext.saveOriginalHTML) {
        ext.saveOriginalHTML(block);
      }

      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null, false);
      const nodes = [];
      while (walker.nextNode()) {
        nodes.push(walker.currentNode);
      }

      nodes.forEach(node => {
        if (!node.parentNode) return;

        // 既に接続詞で囲まれている場合、または自作UI・スクリプト等の場合はスキップ
        if (node.parentNode.closest && (
          node.parentNode.closest('.egov-conjunction') ||
          node.parentNode.closest(ext.SELF_UI_SELECTOR) ||
          node.parentNode.closest(ext.EXCLUDED_SELECTORS)
        )) {
          return;
        }

        const parentTagName = (node.parentNode.tagName || '').toLowerCase();
        if (parentTagName === 'script' || parentTagName === 'style' || parentTagName === 'textarea') {
          return;
        }

        const text = node.nodeValue;
        if (!text || !CONJUNCTION_CHECK_REGEX.test(text)) {
          return;
        }

        CONJUNCTION_SPLIT_REGEX.lastIndex = 0;
        const frag = document.createDocumentFragment();
        let lastIdx = 0;
        let match;

        while ((match = CONJUNCTION_SPLIT_REGEX.exec(text)) !== null) {
          const matchIndex = match.index;
          const matchedWord = match[1];

          // マッチ前の通常テキスト
          if (matchIndex > lastIdx) {
            frag.appendChild(document.createTextNode(text.substring(lastIdx, matchIndex)));
          }

          // 接続詞ハイライト用 span
          const span = document.createElement('span');
          span.className = CONJUNCTION_CLASS_MAP[matchedWord] || 'egov-conjunction';
          span.textContent = matchedWord;
          frag.appendChild(span);

          lastIdx = matchIndex + matchedWord.length;
        }

        // 残りの通常テキスト
        if (lastIdx < text.length) {
          frag.appendChild(document.createTextNode(text.substring(lastIdx)));
        }

        node.parentNode.replaceChild(frag, node);
      });
    };

    // targetContainer 指定時（同期処理）か全体処理（非同期チャンク分割）かで分岐
    if (targetContainer) {
      for (let i = 0; i < blocks.length; i++) {
        processConjunction(blocks[i]);
      }
    } else {
      ext.runTaskInChunks('conjunction', blocks, processConjunction, 150);
    }
  };

  /**
   * 接続詞の色分けハイライトを無効化する関数
   */
  ext.disableConjunctionHighlight = function() {
    ext.cancelTask('conjunction');
    document.body.classList.remove('egov-ext-conjunction-active');
  };

})(window.egovExt);

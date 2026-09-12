/**
 * horizontal.js
 * 
 * 横書き表記変換（漢数字→アラビア数字）のロジックを管理するモジュール。
 */

window.egovExt = window.egovExt || {};

(function(ext) {
  // 正規表現を定数化
  const HAS_NUM_REGEX = /[一二三四五六七八九十百千万億兆〇0-9０-９]/;
  const ERA_LAW_NUM_REGEX = /((?:昭和|平成|令和|明治|大正)[一二三四五六七八九十百千万億兆〇]+年)?(法律|政令|閣令|省令|府令|命令|規則|告示)第([一二三四五六七八九十百千万億兆〇]+)号/g;
  const REFER_CLAUSE_REGEX = /第([一二三四五六七八九十百千万億兆〇]+)(条|條|項|号|章|節|款|目|編|表|別表)/g;
  const REFER_CLAUSE_HALF_NUM_REGEX = /第([0-9]+)(条|條|項|号|章|節|款|目|編|表|別表)/g;
  const SPECIAL_TABLE_STYLE_REGEX = /((?:別表|様式)第)([一二三四五六七八九十百千万億兆〇]+)/g;
  const SUB_BRANCH_NUM_KANJI_REGEX = /([条條項号章節款目編表別表様式０-９])の([一二三四五六七八九十百千万億兆〇]+)/g;
  const SUB_BRANCH_NUM_HALF_REGEX = /([条條項号章節款目編表別表様式０-９])の([0-9]+)/g;
  const ITEM_TITLE_PATTERN = /^[一二三四五六七八九十百]+(の[一二三四五六七八九十百]+)*$/;
  const ITEM_TITLE_ARABIC_PATTERN = /^\([0-9]+\)/;

  /**
   * 法令本文のテキスト内の引用条文や法令番号を全角算用数字に変換する関数
   * @param {string} text - 変換元のテキスト
   * @returns {string} 変換後のテキスト
   */
  function convertLawTextToHorizontal(text) {
    if (!text) return '';

    // 1. 法令番号 (年号 + 法律等種類 + 第何号) の変換 (例: 令和五年法律第百二号 ➔ 令和５年法律第１０２号)
    text = text.replace(ERA_LAW_NUM_REGEX, function(match, yearPart, typePart, numPart) {
      let result = '';
      if (yearPart) {
        const yearKanji = yearPart.replace(/^(昭和|平成|令和|明治|大正)/, '').replace(/年$/, '');
        const yearArabic = ext.kanjiToFullWidthArabic(yearKanji);
        const era = yearPart.match(/^(昭和|平成|令和|明治|大正)/)[1];
        result += era + yearArabic + '年';
      }
      result += typePart + '第' + ext.kanjiToFullWidthArabic(numPart) + '号';
      return result;
    });

    // 2. 引用条項 (第何条、第何項、第何号、第何章、第何節、第何款、第何目、第何編、第何表) の変換
    text = text.replace(REFER_CLAUSE_REGEX, function(match, kanji, suffix) {
      return '第' + ext.kanjiToFullWidthArabic(kanji) + suffix;
    });

    // 2b. 引用条項の半角数字を全角数字に変換 (例: 第1章 ➔ 第１章)
    text = text.replace(REFER_CLAUSE_HALF_NUM_REGEX, function(match, numStr, suffix) {
      return '第' + ext.toFullWidthArabic(numStr) + suffix;
    });

    // 2c. 「前〇条」「前〇項」「前〇号」および「次〇条」「次〇項」「次〇号」の変換 (例: 前二条 ➔ 前２条、次三条 ➔ 次３条)
    text = text.replace(/([前次])([一二三四五六七八九十百]+)(条|條|項|号)/g, function(match, prefix, kanji, suffix) {
      return prefix + ext.kanjiToFullWidthArabic(kanji) + suffix;
    });

    // 3. 別表第〇、様式第〇 の変換 (例: 別表第一 ➔ 別表第１)
    text = text.replace(SPECIAL_TABLE_STYLE_REGEX, function(match, prefix, kanji) {
      return prefix + ext.kanjiToFullWidthArabic(kanji);
    });

    // 4. 枝番の変換 (例: 条の二, 項の三, ２の四, ７７条の３５の七 ➔ 条の２, 項の三, ２の四, ７７条の３５の７)
    let prevText;
    do {
      prevText = text;
      text = text.replace(SUB_BRANCH_NUM_KANJI_REGEX, function(match, prefix, kanji) {
        return prefix + 'の' + ext.kanjiToFullWidthArabic(kanji);
      });
      text = text.replace(SUB_BRANCH_NUM_HALF_REGEX, function(match, prefix, numStr) {
        return prefix + 'の' + ext.toFullWidthArabic(numStr);
      });
    } while (text !== prevText);

    return text;
  }

  /**
   * 号（リスト項目見出し）の漢数字を半角カッコ書き (1) の形式に変換する関数
   * 例: "一" -> "(1)　", "一の二" -> "(1)の2　"
   * @param {string} originalText - 変換元となる号番号文字列
   * @returns {string} 置換後の号番号
   */
  function convertItemTitleToHorizontal(originalText) {
    if (!originalText) return '';
    const trimmed = originalText.trim();
    
    // 既に変換済みのカッコ書き（例: "(1)" や "(1)の2"）の場合は二重カッコを防ぐためスキップ
    if (/^\([0-9]+\)(の[0-9]+)*$/.test(trimmed)) {
      return originalText;
    }
    
    // 枝番の処理 (パターンA: (1)の2, パターンB: (1)の2の3)
    if (trimmed.includes('の')) {
      const parts = trimmed.split('の');
      const convertedParts = parts.map(part => ext.kanjiToArabic(part.trim()));
      if (convertedParts.every(part => part !== '' && !isNaN(part))) {
        const main = convertedParts[0];
        const branches = convertedParts.slice(1).join('の');
        return `(${main})の${branches}　`;
      }
    }

    const arabic = ext.kanjiToArabic(trimmed);
    if (arabic) {
      return `(${arabic})　`;
    }

    return originalText;
  }

  /**
   * 項の見出しの漢数字を全角算用数字に変換する関数
   * 例: "二" -> "２"
   * @param {string} originalText - 変換元の項番号文字列
   * @returns {string} 変換後の項番号
   */
  function convertParagraphNumToHorizontal(originalText) {
    if (!originalText) return '';
    const trimmed = originalText.trim();
    const arabic = ext.kanjiToArabic(trimmed);
    if (arabic && !isNaN(arabic)) {
      const fullWidth = ext.toFullWidthArabic(arabic);
      const hasSpace = originalText.endsWith(' ') || originalText.endsWith('　');
      return fullWidth + (hasSpace ? '　' : '');
    }
    return originalText;
  }

  /**
   * 横書き表記変換（全角算用数字＆半角かっこ号見出し）をDOMに適用する関数（非同期チャンク分割版）
   * @param {HTMLElement|null} [targetContainer=null] - 適用対象のDOMコンテナ
   */
  ext.applyHorizontalConversion = function(targetContainer = null) {
    // 呼び出し側でも設定を確認しているが、ここでも一度だけ判定して以降の分岐をなくす
    if (!ext.settings.global || !ext.settings.horizontal) return;

    if (!targetContainer) {
      ext.cancelTask('horizontal_leaf');
      ext.cancelTask('horizontal_item');
      ext.cancelTask('horizontal_para');
    }

    const containers = [];
    if (targetContainer) {
      containers.push(targetContainer);
    } else {
      const mainContainer = ext.getLawContainer();
      if (mainContainer) {
        containers.push(mainContainer);
      }
      const sidebar = ext.deepQuerySelectorAll(document.body, ext.SIDEBAR_SELECTOR)[0];
      if (sidebar) {
        containers.push(sidebar);
      }
      if (containers.length === 0) {
        containers.push(document.body);
      }
    }

    // 0. 古い法令（民法など）向けの事前処理：ItemTitle クラスの動的付与
    containers.forEach(c => {
      let itemSentences = Array.from(ext.deepQuerySelectorAll(c, '._div_ItemSentence, .ItemSentence'));
      const el = c.nodeType === Node.TEXT_NODE ? c.parentElement : c;
      if (el && el.matches && el.matches('._div_ItemSentence, .ItemSentence')) {
        itemSentences.push(el);
      } else if (el && el.closest && el.closest('._div_ItemSentence, .ItemSentence')) {
        itemSentences.push(el.closest('._div_ItemSentence, .ItemSentence'));
      }
      
      // 重複を排除
      itemSentences = [...new Set(itemSentences)];

      itemSentences.forEach(sentence => {
        const firstChild = sentence.firstElementChild;
        if (firstChild && firstChild.tagName && firstChild.tagName.toLowerCase() === 'span') {
          const trimmedText = firstChild.textContent.trim();
          if (ITEM_TITLE_PATTERN.test(trimmedText) || ITEM_TITLE_ARABIC_PATTERN.test(trimmedText)) {
            firstChild.classList.add('ItemTitle');
          }
        }
      });
    });

    // 1. 本文内テキストノードの変換
    let allBlocks = [];
    containers.forEach(c => {
      if (targetContainer && targetContainer.matches && targetContainer.matches('div, p, h1, h2, h3, h4, h5, h6, li, td, th, span, a')) {
        allBlocks.push(targetContainer);
      }
      const blocks = ext.deepQuerySelectorAll(c, 'div, p, h1, h2, h3, h4, h5, h6, li, td, th, span, a');
      allBlocks = allBlocks.concat(Array.from(blocks));
    });

    const titlebar = document.getElementById('titlebar');
    
    const leafBlocks = Array.from(allBlocks).filter(el => {
      if (titlebar && (titlebar === el || titlebar.contains(el))) return false;
      if (el.closest && el.closest(ext.SELF_UI_SELECTOR)) return false;
      
      // Prevent processLeaf from conflicting with processItem and processPara
      const closestTitle = el.closest ? el.closest('.ItemTitle, ._div_ItemTitle, .itemtitle, .ParagraphNum, ._div_ParagraphNum, .paragraphtitle') : null;
      if (closestTitle) {
        if (closestTitle.classList.contains('paragraphtitle') && closestTitle.textContent.includes('条')) {
          // 例外としてスキップしない
        } else {
          return false;
        }
      }
      // querySelector は最初の1件で打ち切られるため querySelectorAll(...).length === 0 より速い
      return !el.querySelector(ext.BLOCK_SELECTOR);
    });

    const processLeaf = (block) => {
      // 数字を含まないブロックは変換対象が無いのでテキストノード走査ごとスキップする
      if (!HAS_NUM_REGEX.test(block.textContent)) {
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
        if (node.parentNode && node.parentNode.closest) {
          const selfUI = node.parentNode.closest(ext.SELF_UI_SELECTOR);
          if (selfUI) {
            // ツールチップ内の個別変換が明示的に指定された場合のみ例外として許可
            if (targetContainer && (targetContainer === selfUI || targetContainer.contains(selfUI))) {
              // 許可
            } else {
              return;
            }
          }

          const closestTitle = node.parentNode.closest('.ItemTitle, ._div_ItemTitle, .itemtitle, .ParagraphNum, ._div_ParagraphNum, .paragraphtitle');
          if (closestTitle) {
            if (closestTitle.classList.contains('paragraphtitle') && closestTitle.textContent.includes('条')) {
              // 例外としてスキップしない
            } else {
              return;
            }
          }
        }

        // 目次（サイドバー）のテキストノードは、イベントリスナ破壊防止のためinnerHTMLではなくテキストのインプレース書き戻しで復元する
        const isInsideSidebar = node.parentNode && node.parentNode.closest && node.parentNode.closest(ext.SIDEBAR_SELECTOR);
        if (isInsideSidebar && node._originalText === undefined) {
          node._originalText = node.textContent;
        }

        const newVal = convertLawTextToHorizontal(node.textContent);
        if (node.textContent !== newVal) {
          node.textContent = newVal;
        }
      });
    };

    if (targetContainer) {
      leafBlocks.forEach(processLeaf);
    } else {
      ext.runTaskInChunks('horizontal_leaf', leafBlocks, processLeaf, 100);
    }

    // 2. 号の見出しの変換
    let itemTitles = [];
    containers.forEach(c => {
      if (targetContainer && targetContainer.matches && targetContainer.matches('.ItemTitle, ._div_ItemTitle, .itemtitle')) {
        itemTitles.push(targetContainer);
      }
      const titles = Array.from(ext.deepQuerySelectorAll(c, '.ItemTitle, ._div_ItemTitle, .itemtitle'));
      itemTitles = itemTitles.concat(titles);
    });

    const processItem = (el) => {
      if (ext.saveOriginalHTML) {
        ext.saveOriginalHTML(el);
      }

      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
      const nodes = [];
      while (walker.nextNode()) {
        nodes.push(walker.currentNode);
      }
      nodes.forEach(node => {
        const newVal = convertItemTitleToHorizontal(node.textContent);
        if (node.textContent !== newVal) {
          node.textContent = newVal;
        }
      });
    };

    if (targetContainer) {
      itemTitles.forEach(processItem);
    } else {
      ext.runTaskInChunks('horizontal_item', itemTitles, processItem, 100);
    }

    // 3. 古い法令などの項番号見出しの変換
    let paragraphNums = [];
    containers.forEach(c => {
      if (targetContainer && targetContainer.matches && targetContainer.matches('.ParagraphNum, ._div_ParagraphNum, .paragraphtitle')) {
        if (!targetContainer.textContent.includes('条')) {
          paragraphNums.push(targetContainer);
        }
      }
      const nums = ext.deepQuerySelectorAll(c, '.ParagraphNum, ._div_ParagraphNum, .paragraphtitle');
      const filteredNums = Array.from(nums).filter(el => !el.textContent.includes('条'));
      paragraphNums = paragraphNums.concat(filteredNums);
    });

    const processPara = (el) => {
      if (ext.saveOriginalHTML) {
        ext.saveOriginalHTML(el);
      }

      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
      const nodes = [];
      while (walker.nextNode()) {
        nodes.push(walker.currentNode);
      }
      nodes.forEach(node => {
        const newVal = convertParagraphNumToHorizontal(node.textContent);
        if (node.textContent !== newVal) {
          node.textContent = newVal;
        }
      });
    };

    if (targetContainer) {
      paragraphNums.forEach(processPara);
    } else {
      ext.runTaskInChunks('horizontal_para', paragraphNums, processPara, 100);
    }
  };

  /**
   * 横書き表記変換を解除する関数。
   * 進行中タスクの停止と、サイドバーのテキストのインプレース復元のみを行う。
   * 本文側の DOM の巻き戻しは content.js が3機能ぶんをまとめて1回だけ実行する。
   */
  ext.removeHorizontalConversion = function() {
    ext.cancelTask('horizontal_leaf');
    ext.cancelTask('horizontal_item');
    ext.cancelTask('horizontal_para');

    // 目次（サイドバー）のテキストノードをインプレースで元の表記に戻す（イベントリスナや目のアイコンの状態破壊を防ぐ）
    const sidebar = ext.deepQuerySelectorAll(document.body, ext.SIDEBAR_SELECTOR)[0];
    if (sidebar) {
      const walker = document.createTreeWalker(sidebar, NodeFilter.SHOW_TEXT, null, false);
      const nodes = [];
      while (walker.nextNode()) {
        nodes.push(walker.currentNode);
      }
      nodes.forEach(node => {
        if (node._originalText !== undefined) {
          node.textContent = node._originalText;
          node._originalText = undefined;
        }
      });
    }
  };

})(window.egovExt);

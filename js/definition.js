/**
 * definition.js
 * 
 * 定義語ホバー辞書、定義語抽出、および定義語ハイライトのロジックを管理するモジュール。
 */

window.egovExt = window.egovExt || {};

(function(ext) {
  // 定義語ポップアップ表示用の要素と登録状態フラグを保持
  /**
   * 定義語ホバー辞書のツールチップインスタンス（js/tooltip.js の createTooltip の戻り値）
   * @type {Object|null}
   */
  ext.definitionTooltip = null;

  // 定義語抽出パターン用の正規表現を定数化（スコープ定数）
  const INLINE_DEFINITION_REGEX = /（[^）]*?以下[^）]*?「([^」]+)」と(?:いう|総称する)[^）]*?）/g;
  const CLAUSE_DEFINITION_REGEX = /「([^」]+)」とは、(?:[^。]|（(?:[^（）]|（[^（）]*?）)*?）|\((?:[^()]|\([^()]*?\))*?\))*?をい(?:う|い)/g;
  const CLAUSE_DEFINITION_NO_QUOTES_REGEX = /(?:^|[、　\s])([^　\s（「”、。]+)とは、(?:[^。]|（(?:[^（）]|（[^（）]*?）)*?）|\((?:[^()]|\([^()]*?\))*?\))*?をい(?:う|い)/g;
  const ITEM_LIST_DEFINITION_REGEX = /^(?:[一二三四五六七八九十百]+|イ|ロ|ハ|ニ|ホ|ヘ|ト|チ|リ|ヌ|ル|ヲ|[0-9]+|\([0-9]+\))[　\s]+([^　\s（「]+)[　\s]+[\s\S]+?をい(?:う。|い、[\s\S]*)$/;

  // 定義語として登録しない一文字のメタ文字や数字など
  const INVALID_DEFINITION_WORDS = new Set([
    '一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
    '条', '項', '号', '章', '節', '款', '目', '前', '同', '法', '令',
    'イ', 'ロ', 'ハ', 'ニ', 'ホ', 'ヘ', 'ト', 'チ', 'リ', 'ヌ', 'ル', 'ヲ'
  ]);

  // 号・項番号やその枝番などのインデックス表現を除外するための正規表現
  const ITEM_MARKER_REGEX = /^[()（）0-9\uff10-\uff19a-zA-Z\uff41-\uff5a\uff21-\uff3a\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u767e\u30a4\u30ed\u30cf\u30cb\u30db\u30d8\u30c8\u30c1\u30ea\u30cc\u30eb\u30f2の]+$/;

  // --- 誤検出フィルタ用の定数 ---
  // いずれもマッチごとに評価されるホットパスのため、モジュールスコープで1度だけ生成する。

  /** 漢字（Han）1文字にマッチ */
  const KANJI_REGEX = /\p{Script=Han}/u;
  /** カタカナ（長音符含む）1文字にマッチ */
  const KATAKANA_REGEX = /[\p{Script=Katakana}ー]/u;
  /** 定義語の直前にあってもよい接頭辞（「当該○○」「同○○」など） */
  const ALLOWED_PREFIX_REGEX = /(当該|同|本|各|前|新|旧|元|全|現|同一|同等|同種|共同|連帯|根|第三|代表|社外|他)$/;
  /** 定義語の直後にあってもよい接尾辞 */
  const ALLOWED_SUFFIX_REGEX = /^(等|及び|若しくは|又は|並びに|対策|対応|活用|管理|整備|設計|設置|関係|行政|支援|推進)/;
  /** 上記のうち「名詞系」の接尾辞（さらに漢字が続く場合は複合名詞とみなす判定に使う） */
  const NOUN_SUFFIX_REGEX = /^(対策|対応|活用|管理|整備|設計|設置|関係|行政|支援|推進)/;
  /** 正規表現のメタ文字をエスケープするためのパターン */
  const REGEX_ESCAPE_REGEX = /[-\/\\^$*+?.()|[\]{}]/g;

  /**
   * 文字が漢字かどうか
   * @param {string|undefined} char
   * @returns {boolean}
   */
  const isKanji = (char) => !!char && KANJI_REGEX.test(char);

  /**
   * 文字がカタカナ（長音符含む）かどうか
   * @param {string|undefined} char
   * @returns {boolean}
   */
  const isKatakana = (char) => !!char && KATAKANA_REGEX.test(char);

  /**
   * 対象要素が属する条・項・号の名称を組み立てるヘルパー関数
   * @param {HTMLElement} element - 探索対象のDOM要素
   * @returns {string} 出典を示す条・項・号のテキスト
   */
  function getSourceClauseNumber(element) {
    let id = element.id || '';
    if (!id) {
      const parentWithId = ext.deepClosest(element, '[id]');
      if (parentWithId) {
        id = parentWithId.id;
      }
    }
    
    const article = ext.deepClosest(element, '.Article, ._div_Article, ._section_Article, section.Article, .article');
    
    let heading = '';
    if (article) {
      const headingEl = article.querySelector('.ArticleCaption, ._div_ArticleCaption, .articleheading, em.articleheading');
      if (headingEl) {
        heading = headingEl.textContent.trim();
      }
    }

    const clauseParts = [];

    let articleTitle = '';
    if (article) {
      const titleEl = article.querySelector('.ArticleTitle, ._div_ArticleTitle');
      if (titleEl) {
        const text = titleEl.textContent.trim();
        const match = text.match(/^(第[一二三四五六七八九十百千万]+条)/);
        articleTitle = match ? match[1] : text.split(/\s|　/)[0];
      } else {
        const pTitles = article.querySelectorAll('.paragraphtitle');
        for (let i = 0; i < pTitles.length; i++) {
          const text = pTitles[i].textContent.trim();
          if (text.includes('条')) {
            const match = text.match(/^(第[一二三四五六七八九十百千万]+条)/);
            articleTitle = match ? match[1] : text.split(/\s|　/)[0];
            break;
          }
        }
      }
    }
    if (articleTitle) {
      clauseParts.push(articleTitle);
    }
    
    let paragraphNum = '';
    const prMatch = id.match(/-Pr_(\d+)/);
    if (prMatch) {
      const num = parseInt(prMatch[1], 10);
      const hasItem = id.includes('-It_');
      if (num > 1 || (num === 1 && hasItem)) {
        paragraphNum = String(num);
      }
    } else {
      const paragraph = ext.deepClosest(element, '._div_ParagraphSentence, .ParagraphSentence, ._div_Paragraph, .Paragraph, ._div_ArticleTitle, .ArticleTitle, .paragraph');
      if (paragraph) {
        const numEl = paragraph.querySelector('.ParagraphNum, ._div_ParagraphNum, .paragraphtitle');
        if (numEl && numEl.textContent.trim()) {
          paragraphNum = numEl.textContent.trim();
        }
      }
    }
    if (paragraphNum && paragraphNum !== articleTitle) {
      const fullWidthNum = paragraphNum.replace(/[0-9]/g, s => String.fromCharCode(s.charCodeAt(0) + 0xFEE0));
      clauseParts.push('第' + fullWidthNum + '項');
    }
    
    let itemTitle = '';
    const itMatch = id.match(/-It_(\d+)/);
    if (itMatch) {
      const item = ext.deepClosest(element, '._div_ItemSentence, .ItemSentence, ._div_Item, .Item, .item');
      if (item) {
        const titleEl = item.querySelector('.ItemTitle, ._div_ItemTitle, .itemtitle');
        if (titleEl && titleEl.textContent.trim()) {
          itemTitle = titleEl.textContent.trim();
        } else {
          const boldEl = item.querySelector('span[style*="font-weight: bold"], b, strong');
          if (boldEl && boldEl.textContent.trim() && /^[一二三四五六七八九十百]+$/.test(boldEl.textContent.trim())) {
            itemTitle = boldEl.textContent.trim();
          } else {
            const match = item.textContent.trim().match(/^([一二三四五六七八九十百]+)/);
            if (match) {
              itemTitle = match[1];
            }
          }
        }
      }
      
      if (!itemTitle) {
        const kanjiNums = ['','一','二','三','四','五','六','七','八','九','十','十一','十二','十三','十四','十五','十六','十七','十八','十九','二十'];
        const num = parseInt(itMatch[1], 10);
        if (num < kanjiNums.length) {
          itemTitle = kanjiNums[num];
        } else {
          itemTitle = String(num);
        }
      }
    }
    if (itemTitle) {
      clauseParts.push('第' + itemTitle + '号');
    }
    
    const clausePath = clauseParts.join('');
    return heading ? heading + clausePath : clausePath;
  }

  /**
   * e-Govの法令本文から定義語および定義文・出典番号を抽出し、メモリ上に保持する関数（非同期チャンク分割版）
   * @returns {Promise<void>}
   */
  ext.extractDefinitionsAsync = async function() {
    ext.definitionMap.clear();

    const addDefinition = (word, data) => {
      if (!word) return;
      if (word.length === 1 && (INVALID_DEFINITION_WORDS.has(word) || /^[0-9\uff10-\uff19a-zA-Z\uff41-\uff5a\uff21-\uff3a]$/.test(word))) {
        return;
      }
      if (ITEM_MARKER_REGEX.test(word)) {
        return;
      }
      // 同じ語が複数箇所で定義されている場合、最初（文書順で最も早い）の定義だけを保持する。
      // 抽出は文書順に進むため、最初に登録されたものが最も早い出現になる。
      if (!ext.definitionMap.has(word)) {
        ext.definitionMap.set(word, data);
      }
    };

    const container = ext.getLawContainer();
    ext.log('definition container:', container.tagName, 'class:', container.className, 'id:', container.id);

    // パターン1：インライン略称型
    const inlineElements = ext.deepQuerySelectorAll(container, '._div_ParagraphSentence, .ParagraphSentence, ._div_ArticleTitle, .ArticleTitle, ._div_ItemSentence, .ItemSentence, ._div_Paragraph, .Paragraph, ._div_Item, .Item, p.sentence');
    ext.log('found inline elements for Pattern 1:', inlineElements.length);
    
    const state1 = await ext.runTaskInChunksPromise('definitionExtract', inlineElements, (el) => {
      const text = el.textContent;
      if (!text) return;
      
      INLINE_DEFINITION_REGEX.lastIndex = 0;
      let match;
      while ((match = INLINE_DEFINITION_REGEX.exec(text)) !== null) {
        const definedWord = match[1].replace(/[\s　]+/g, '');
        if (definedWord) {
          const contextEl = ext.deepClosest(el, '._div_Paragraph, .Paragraph, ._div_Item, .Item, .paragraph, .item') || el;
          addDefinition(definedWord, {
            source: getSourceClauseNumber(contextEl),
            element: contextEl,
            pattern: 1
          });
        }
      }
    }, 200);

    if (state1 && state1.cancelled) return;

    // パターン2：項による明示定義型
    const sentenceElements = ext.deepQuerySelectorAll(container, '._div_ParagraphSentence, .ParagraphSentence, ._div_Sentence, .Sentence, ._div_ArticleTitle, .ArticleTitle, p.sentence');
    ext.log("Found sentence elements for Pattern 2:", sentenceElements.length);
    
    const state2 = await ext.runTaskInChunksPromise('definitionExtract', sentenceElements, (el) => {
      const parentParagraph = ext.deepClosest(el, '._div_ParagraphSentence, .ParagraphSentence, ._div_Paragraph, .Paragraph, ._div_ArticleTitle, .ArticleTitle, .paragraph') || el;
      if (!parentParagraph) return;

      const text = el.textContent;
      if (!text) return;

      CLAUSE_DEFINITION_REGEX.lastIndex = 0;
      let match;
      while ((match = CLAUSE_DEFINITION_REGEX.exec(text)) !== null) {
        const definedWord = match[1].replace(/[\s　]+/g, '');
        if (definedWord) {
          addDefinition(definedWord, {
            source: getSourceClauseNumber(parentParagraph),
            element: parentParagraph,
            pattern: 2
          });
        }
      }

      CLAUSE_DEFINITION_NO_QUOTES_REGEX.lastIndex = 0;
      while ((match = CLAUSE_DEFINITION_NO_QUOTES_REGEX.exec(text)) !== null) {
        const definedWord = match[1].replace(/[\s　]+/g, '');
        if (definedWord) {
          addDefinition(definedWord, {
            source: getSourceClauseNumber(parentParagraph),
            element: parentParagraph,
            pattern: 2
          });
        }
      }
    }, 200);

    if (state2 && state2.cancelled) return;

    // パターン3：号による列挙定義型
    const itemElements = ext.deepQuerySelectorAll(container, '._div_ItemSentence, .ItemSentence, .item p.sentence');
    ext.log("Found item elements for Pattern 3:", itemElements.length);
    
    const state3 = await ext.runTaskInChunksPromise('definitionExtract', itemElements, (el) => {
      const text = el.textContent.trim();
      if (!text) return;

      const match = ITEM_LIST_DEFINITION_REGEX.exec(text);
      if (match) {
        const definedWord = match[1].replace(/[\s　]+/g, '');
        if (definedWord) {
          const parentItem = ext.deepClosest(el, '._div_Item, .Item, .item') || el;
          addDefinition(definedWord, {
            source: getSourceClauseNumber(parentItem),
            element: parentItem,
            pattern: 3
          });
        }
      }
    }, 200);

    if (state3 && state3.cancelled) return;

    // パターン4：e-Gov特有のカラム分割型
    const itemSentences = ext.deepQuerySelectorAll(container, '._div_ItemSentence, .ItemSentence, .item, .item p.sentence');
    ext.log("Found item sentences for Pattern 4:", itemSentences.length);
    
    await ext.runTaskInChunksPromise('definitionExtract', itemSentences, (is) => {
      const col1 = is.querySelector(':scope > .Column[Num="1"], :scope > ._div_Column[Num="1"], :scope > .Column[num="1"], :scope > ._div_Column[num="1"], :scope > .column[num="1"], :scope > .column[Num="1"]');
      const col2 = is.querySelector(':scope > .Column[Num="2"], :scope > ._div_Column[Num="2"], :scope > .Column[num="2"], :scope > ._div_Column[num="2"], :scope > .column[num="2"], :scope > .column[Num="2"]');
      
      let targetCol1 = col1;
      let targetCol2 = col2;
      if (!targetCol1 || !targetCol2) {
        const cols = is.querySelectorAll(':scope > .column, :scope > .Column, :scope > ._div_Column');
        if (cols.length >= 2) {
          targetCol1 = targetCol1 || cols[0];
          targetCol2 = targetCol2 || cols[1];
        }
      }

      if (targetCol1 && targetCol2) {
        const definedWord = targetCol1.textContent.replace(/[\s　]+/g, '');
        const parentItem = ext.deepClosest(is, '._div_ItemSentence, .ItemSentence, ._div_Item, .Item, .item') || is;
        if (definedWord && parentItem) {
          addDefinition(definedWord, {
            source: getSourceClauseNumber(parentItem),
            element: parentItem,
            pattern: 4
          });
        }
      }
    }, 200);

    ext.log("Extraction complete (async). Total terms extracted:", ext.definitionMap.size, Array.from(ext.definitionMap.keys()));
  };

  /**
   * 抽出された定義語を安全にハイライト処理する関数（非同期チャンク分割版）
   * @param {HTMLElement|null} [targetContainer=null] - 適用対象のDOMコンテナ
   */
  ext.enableDefinitionHighlighting = function(targetContainer = null) {
    if (!targetContainer) {
      ext.cancelTask('definitionHighlight');
    }
    ext.updateStatusBadge(ext.definitionMap.size);
    if (ext.definitionMap.size === 0) {
      ext.log('no defined terms extracted. Skipping highlighting.');
      return;
    }

    const escapeForRegex = (term) => term.replace(REGEX_ESCAPE_REGEX, '\\$&');

    const allTerms = Array.from(ext.definitionMap.keys());
    const globalTermsEscaped = allTerms
      .sort((a, b) => b.length - a.length)
      .map(escapeForRegex);
    const globalRegex = new RegExp(`(${globalTermsEscaped.join('|')})`);

    const container = targetContainer || ext.getLawContainer();

    // 変換対象の末端ブロックを収集する（サイドバー・見出し等の除外もここで行われる）
    const blocks = ext.collectLeafBlocks(container, targetContainer);

    // ブロックごとの有効語判定で Map を毎回走査しないよう、必要な情報を配列に落としておく。
    // pattern === 1（インライン略称型）の語は、その定義箇所より後ろでしか有効にならない。
    const definitionEntries = [];
    ext.definitionMap.forEach((def, term) => {
      definitionEntries.push({
        term,
        // 定義位置より後ろでのみ有効な語だけ anchor を持つ。null なら常に有効。
        anchor: (def.pattern === 1 && def.element) ? def.element : null
      });
    });

    let highlightedCount = 0;

    // 直前のブロックと有効語の集合が同じなら正規表現を作り直さないためのキャッシュ。
    // blocks は文書順で、pattern 1 の語は文書順に増えていくだけなので、
    // 「有効語の数が同じ ⇒ 有効語の集合も同じ」が成り立つ。
    let cachedTermCount = -1;
    let cachedRegex = null;

    const processHighlight = (block) => {
      if (!globalRegex.test(block.textContent)) {
        return;
      }

      if (ext.saveOriginalHTML) {
        ext.saveOriginalHTML(block);
      }

      const activeTerms = [];
      for (let i = 0; i < definitionEntries.length; i++) {
        const entry = definitionEntries[i];
        if (!entry.anchor) {
          activeTerms.push(entry.term);
          continue;
        }
        const anchor = entry.anchor;
        const isAtOrAfter = anchor === block ||
          (anchor.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING);
        if (isAtOrAfter) activeTerms.push(entry.term);
      }

      if (activeTerms.length === 0) return;

      let regex;
      if (activeTerms.length === cachedTermCount && cachedRegex) {
        regex = cachedRegex;
      } else {
        const escapedTerms = activeTerms
          .sort((a, b) => b.length - a.length)
          .map(escapeForRegex);
        regex = new RegExp(`(${escapedTerms.join('|')})`, 'g');
        cachedTermCount = activeTerms.length;
        cachedRegex = regex;
      }

      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null, false);
      const nodes = [];
      while (walker.nextNode()) {
        nodes.push(walker.currentNode);
      }

      nodes.forEach(node => {
        if (!node.parentNode) return;
        
        // 既に定義語ハイライト済み、または祖先に定義語・自作UIがある場合は二重ラップ防止のためスキップ
        if (node.parentNode.closest && (node.parentNode.closest('.egov-definition-word') || node.parentNode.closest(ext.SELF_UI_SELECTOR))) {
          return;
        }
        
        const parentTagName = (node.parentNode.tagName || '').toLowerCase();
        if (parentTagName === 'script' || parentTagName === 'style' || parentTagName === 'textarea') {
          return;
        }

        const text = node.nodeValue;
        if (!text) return;

        regex.lastIndex = 0;
        if (!regex.test(text)) return;

        regex.lastIndex = 0;
        const frag = document.createDocumentFragment();
        let lastIndex = 0;
        let match;
        let hasRealHighlight = false;

        while ((match = regex.exec(text)) !== null) {
          const matchIndex = match.index;
          const matchedText = match[1];

          const prevChar = text[matchIndex - 1];
          const textBefore = text.substring(0, matchIndex);

          // matchIndex + matchedText.length の安全な参照
          const nextChar = text[matchIndex + matchedText.length];
          const textAfter = text.substring(matchIndex + matchedText.length);

          // 許可された接尾辞（名詞系）の後ろに漢字がさらに2文字以上続くかチェック
          let isFollowedByLongKanji = false;
          if (isKanji(nextChar)) {
            const suffixMatch = textAfter.match(ALLOWED_SUFFIX_REGEX);
            if (suffixMatch) {
              const matchedSuffix = suffixMatch[0];
              // 接尾辞が名詞系の場合のみ、その後の漢字連続数をカウント
              if (NOUN_SUFFIX_REGEX.test(matchedSuffix)) {
                const remainingText = textAfter.substring(matchedSuffix.length);
                let kanjiCount = 0;
                for (let i = 0; i < remainingText.length; i++) {
                  if (isKanji(remainingText[i])) {
                    kanjiCount++;
                  } else {
                    break;
                  }
                }
                // 漢字がさらに2文字以上続く場合は、より大きな複合名詞の一部とみなして除外
                if (kanjiCount >= 2) {
                  isFollowedByLongKanji = true;
                }
              }
            }
          }

          const isFalsePositive =
            isFollowedByLongKanji ||
            (isKatakana(nextChar) || isKatakana(prevChar)) ||
            (isKanji(prevChar) && !ALLOWED_PREFIX_REGEX.test(textBefore)) ||
            (isKanji(nextChar) && !ALLOWED_SUFFIX_REGEX.test(textAfter));

          if (isFalsePositive) {
            frag.appendChild(document.createTextNode(text.substring(lastIndex, regex.lastIndex)));
          } else {
            if (matchIndex > lastIndex) {
              frag.appendChild(document.createTextNode(text.substring(lastIndex, matchIndex)));
            }

            const span = document.createElement('span');
            span.className = 'egov-definition-word';
            span.textContent = matchedText;
            span.dataset.word = matchedText;
            // キーボードのみの利用者も Tab で辿って定義を読めるようにする
            span.tabIndex = 0;
            frag.appendChild(span);
            highlightedCount++;
            hasRealHighlight = true;
          }

          lastIndex = regex.lastIndex;
        }

        if (hasRealHighlight) {
          if (lastIndex < text.length) {
            frag.appendChild(document.createTextNode(text.substring(lastIndex)));
          }
          node.parentNode.replaceChild(frag, node);
        }
      });
    };

    if (targetContainer) {
      blocks.forEach(processHighlight);
      setupDefinitionTooltipEvents();
    } else {
      ext.runTaskInChunks('definitionHighlight', blocks, processHighlight, 100, (state) => {
        if (state.cancelled) return;
        ext.log('highlighting complete. Highlighted occurrences (async):', highlightedCount);
        setupDefinitionTooltipEvents();
      });
    }
  };

  /**
   * 定義語ハイライトを無効化する。
   * 進行中タスクの停止・ツールチップの非表示・バッジのリセットのみを行い、
   * DOM の巻き戻しは content.js が3機能ぶんをまとめて1回だけ実行する。
   */
  ext.disableDefinitionHighlighting = function() {
    ext.cancelTask('definitionHighlight');
    if (ext.definitionTooltip) {
      ext.definitionTooltip.hide(true);
    }
    ext.updateStatusBadge(0);
  };

  /**
   * 定義語ホバー辞書のイベントを登録する。
   * ツールチップの生成・配置・表示制御は js/tooltip.js の共通基盤が担当し、
   * ここでは「定義語からポップアップの中身を作る」部分だけを受け持つ。
   */
  function setupDefinitionTooltipEvents() {
    if (!ext.settings.global || !ext.settings.definition) return;
    if (ext.definitionTooltip) return;

    ext.definitionTooltip = ext.createTooltip({ variant: 'definition' });

    ext.bindHoverTooltip({
      selector: '.egov-definition-word',
      tooltip: ext.definitionTooltip,
      isEnabled: () => !!(ext.settings.global && ext.settings.definition),
      resolveContent: (target) => {
        const def = ext.definitionMap.get(target.dataset.word);
        if (!def || !def.element) return null;

        const frag = document.createDocumentFragment();

        const header = document.createElement('div');
        header.className = 'egov-ext-tip-header';
        header.textContent = def.source || '定義語';
        frag.appendChild(header);

        const body = document.createElement('div');
        body.className = 'egov-ext-tip-body';

        const clone = def.element.cloneNode(true);
        // クローンから引用ボタンなどの自作UI要素を除去
        clone.querySelectorAll('.egov-ext-citation-btn, [class*="citation-btn"]').forEach(btn => btn.remove());
        // 共通成形関数で定義ポップアップDOMをインライン化・クリーンアップ
        ext.formatInlinePreview(clone);
        body.appendChild(clone);


        frag.appendChild(body);
        return frag;
      }
    });
  }

})(window.egovExt);

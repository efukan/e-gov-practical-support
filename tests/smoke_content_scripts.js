/**
 * jsdom で content script 一式を読み込み、主要な動線が例外なく通ることを確認するスモークテスト。
 */
process.env.NODE_ENV = 'test';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const scripts = manifest.content_scripts[0].js;

const HTML = `<!DOCTYPE html><html><body>
<div id="titlebar">タイトルバー</div>
<div class="sidebar"><div class="tocitem"><a href="#Mp-At_2">第二条</a></div></div>
<div class="main-content"><div class="LawBody">
  <div class="_div_Article" id="Mp-At_1">
    <div class="_div_ArticleTitle"><span>第一条</span></div>
    <div class="_div_Paragraph" id="Mp-At_1-Pr_1">
      <div class="_div_ParagraphSentence">この法律において「個人情報取扱事業者」とは、個人情報データベース等を事業の用に供している者をいう。</div>
    </div>
  </div>
  <div class="_div_Article" id="Mp-At_2">
    <div class="_div_ArticleTitle"><span>第二条</span></div>
    <div class="_div_Paragraph" id="Mp-At_2-Pr_1">
      <div class="_div_ParagraphSentence">個人情報取扱事業者は、第三条第二項の規定により、当該情報（第五号に掲げるもの）を保護しなければならない。</div>
    </div>
  </div>
</div></div>
</body></html>`;

const dom = new JSDOM(HTML, { url: 'https://laws.e-gov.go.jp/law/415AC0000000057', pretendToBeVisual: true });
const { window } = dom;

// chrome 拡張API の最小スタブ
const storage = {};
window.chrome = {
  storage: {
    sync: {
      get: async () => ({ ...storage }),
      set: async (o) => Object.assign(storage, o)
    },
    onChanged: { addListener() {} }
  },
  runtime: { onMessage: { addListener() {} }, openOptionsPage() {} },
  tabs: { query: async () => [], sendMessage: async () => {} }
};

// jsdom 未実装APIの補完
window.HTMLElement.prototype.scrollIntoView = function() {};
if (!window.IntersectionObserver) {
  window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
}
if (!window.MutationObserver) {
  window.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
}
global.window = window;
global.document = window.document;
global.chrome = window.chrome;
global.Node = window.Node;
global.NodeFilter = window.NodeFilter;
global.MutationObserver = window.MutationObserver;
global.IntersectionObserver = window.IntersectionObserver;

const errors = [];
window.addEventListener('error', (e) => errors.push(e.message));

for (const src of scripts) {
  const code = fs.readFileSync(path.join(ROOT, src), 'utf8');
  try {
    window.eval(code);
  } catch (e) {
    console.error(`✗ ${src} の読み込みで例外:`, e.message);
    process.exit(1);
  }
  console.log(`✓ loaded ${src}`);
}

const ext = window.egovExt;
let failures = 0;
function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(resolved => {
        if (resolved === false) throw new Error('assertion returned false');
        console.log(`✓ ${name}${resolved && resolved !== true ? ` → ${resolved}` : ''}`);
      }).catch(e => {
        failures++;
        console.error(`✗ ${name}: ${e.message}`);
      });
    }
    if (r === false) throw new Error('assertion returned false');
    console.log(`✓ ${name}${r && r !== true ? ` → ${r}` : ''}`);
  } catch (e) {
    failures++;
    console.error(`✗ ${name}: ${e.message}`);
  }
}

console.log('\n--- ユーティリティ ---');
check('DEFAULT_SETTINGS に10キー', () => Object.keys(ext.DEFAULT_SETTINGS).length === 10);
check('getLawIdFromUrl (パス形式)', () => ext.getLawIdFromUrl('https://laws.e-gov.go.jp/law/415AC0000000057') === '415AC0000000057');
check('getLawIdFromUrl (小文字クエリ)', () => ext.getLawIdFromUrl('https://laws.e-gov.go.jp/document?lawid=321constitution') === '321CONSTITUTION');
check('getLawIdFromUrl (大文字クエリ)', () => ext.getLawIdFromUrl('https://laws.e-gov.go.jp/document?lawId=321CONSTITUTION') === '321CONSTITUTION');
check('getLawContainer は .LawBody を優先', () => ext.getLawContainer().classList.contains('LawBody'));
check('kanjiToArabic', () => ext.kanjiToArabic('百二十三') === '123');
check('toFullWidthArabic', () => ext.toFullWidthArabic('123') === '１２３');
check('toHalfWidthArabic', () => ext.toHalfWidthArabic('１２３') === '123');
check('countDescendantsUpTo は上限で打ち切る', () => ext.countDescendantsUpTo(document.body, 3) === 3);
check('collectLeafBlocks が末端のみ返す', () => {
  const blocks = ext.collectLeafBlocks(ext.getLawContainer());
  if (blocks.length === 0) throw new Error('0件');
  const nested = blocks.filter(b => b.querySelector(ext.BLOCK_SELECTOR));
  if (nested.length) throw new Error(`末端でない要素が${nested.length}件混入`);
  return `${blocks.length}件`;
});
check('collectLeafBlocks はサイドバーを除外', () =>
  ext.collectLeafBlocks(document.body).every(b => !b.closest('.sidebar')));
check('collectLeafBlocks は titlebar を除外', () =>
  ext.collectLeafBlocks(document.body).every(b => b.id !== 'titlebar'));
check('EXCLUDED_SELECTORS は dim/definition の和集合', () =>
  ['ItemTitle', 'itemtitle', 'ParagraphNum', 'paragraphtitle', 'ArticleCaption', 'LawTitle']
    .every(k => ext.EXCLUDED_SELECTORS.includes(k)));

console.log('\n--- 横書き変換 ---');
check('applyHorizontalConversion で第三条→第３条', () => {
  ext.applyHorizontalConversion();
  const t = document.getElementById('Mp-At_2-Pr_1').textContent;
  if (!t.includes('第３条第２項')) throw new Error(`変換されず: ${t}`);
  return t.slice(0, 30);
});
check('horizontal OFF なら何もしない', () => {
  ext.settings.horizontal = false;
  const before = document.getElementById('Mp-At_2-Pr_1').textContent;
  ext.applyHorizontalConversion();
  ext.settings.horizontal = true;
  return document.getElementById('Mp-At_2-Pr_1').textContent === before;
});

console.log('\n--- 薄字化 ---');
check('enableDimParentheses が括弧を包む', () => {
  ext.enableDimParentheses();
  const n = document.querySelectorAll('.egov-ext-dimmed-text').length;
  if (n === 0) throw new Error('薄字化spanが0件');
  return `${n}件`;
});

console.log('\n--- 定義語 ---');
check('定義語の抽出とハイライト', async () => true);

(async () => {
  await ext.extractDefinitionsAsync();
  check('definitionMap に「個人情報取扱事業者」', () => {
    if (!ext.definitionMap.has('個人情報取扱事業者')) {
      throw new Error(`抽出結果: ${JSON.stringify([...ext.definitionMap.keys()])}`);
    }
    return `${ext.definitionMap.size}語`;
  });
  check('def は element を持ち elements を持たない', () => {
    const d = ext.definitionMap.get('個人情報取扱事業者');
    return !!d.element && d.elements === undefined;
  });

  ext.enableDefinitionHighlighting();
  await new Promise(r => setTimeout(r, 300));
  check('定義語がハイライトされる', () => {
    const n = document.querySelectorAll('.egov-definition-word').length;
    if (n === 0) throw new Error('ハイライト0件');
    return `${n}件`;
  });

  console.log('\n--- ツールチップ基盤 ---');
  check('definitionTooltip が生成される', () => !!ext.definitionTooltip);
  check('role="tooltip" が付く', () => ext.definitionTooltip.el.getAttribute('role') === 'tooltip');

  check('mouseover で表示され aria-describedby が付く', async () => true);
  const word = document.querySelector('.egov-definition-word');
  word.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  await new Promise(r => setTimeout(r, 250));
  check('ホバーでツールチップが visible', () => {
    if (!ext.definitionTooltip.el.classList.contains('visible')) {
      throw new Error('visible クラスが付かない');
    }
    return ext.definitionTooltip.el.textContent.slice(0, 40);
  });
  check('アンカーに aria-describedby', () =>
    word.getAttribute('aria-describedby') === ext.definitionTooltip.el.id);

  // Escape で閉じる
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('Escape で閉じる', () => !ext.definitionTooltip.el.classList.contains('visible'));
  check('閉じたら aria-describedby が外れる', () => !word.hasAttribute('aria-describedby'));

  console.log('\n--- 復元 ---');
  check('restoreAllOriginalHTML で元に戻る', () => {
    ext.disableDefinitionHighlighting();
    ext.disableDimParentheses();
    ext.removeHorizontalConversion();
    ext.restoreAllOriginalHTML();
    // 本文側のみを見る（ツールチップ内はクローンなので対象外）
    const body = ext.getLawContainer();
    const dimmed = body.querySelectorAll('.egov-ext-dimmed-text').length;
    const words = body.querySelectorAll('.egov-definition-word').length;
    if (dimmed || words) throw new Error(`残存: dim=${dimmed} def=${words}`);
    return '本文から全て除去';
  });

  console.log('\n--- 被引用条文プレビュー ---');
  check('extractHighlightTerms で「第２条」から漢数字・算用数字を網羅', () => {
    const terms = ext._testCitation.extractHighlightTerms('第２条');
    if (!terms.includes('第二条') || !terms.includes('第２条') || !terms.includes('第2条')) {
      throw new Error(`抽出不備: ${JSON.stringify(terms)}`);
    }
    return JSON.stringify(terms);
  });

  check('extractHighlightTerms で枝番付き「第２条の３」を網羅', () => {
    const terms = ext._testCitation.extractHighlightTerms('第２条の３');
    if (!terms.includes('第二条の三') || !terms.includes('第２条の３') || !terms.includes('第2条の3')) {
      throw new Error(`抽出不備: ${JSON.stringify(terms)}`);
    }
    return JSON.stringify(terms);
  });

  check('extractHighlightTerms で千番台「第１０４４条」を網羅', () => {
    const terms = ext._testCitation.extractHighlightTerms('第１０４４条');
    if (!terms.includes('第1044条') || !terms.includes('第１０４４条') || (!terms.includes('第一千四十四条') && !terms.includes('第千四十四条'))) {
      throw new Error(`千番台抽出不備: ${JSON.stringify(terms)}`);
    }
    return JSON.stringify(terms);
  });

  check('renderArticlePreview が条文構造とハイライトを正常に生成', () => {
    const dummyContent = {
      ArticleCaption: '（定義）',
      ArticleTitle: '第七条',
      Paragraph: [
        {
          ParagraphNum: '',
          ParagraphSentence: {
            Sentence: [
              {
                '#childs': [
                  { '#text': 'この規則において、<a href="/law/xxx#Mp-At_2">介護保険法第二条</a>に規定する事業とする。' }
                ]
              }
            ]
          },
          Item: [
            {
              ItemTitle: '一',
              ItemSentence: {
                Sentence: [{ '#text': '要介護状態の予防に関する事業' }]
              }
            }
          ]
        }
      ]
    };
    const domEl = ext._testCitation.renderArticlePreview(dummyContent, ['第二条', '第２条'], '介護保険法施行規則', '第七条');
    if (!domEl.querySelector('.egov-ext-preview-lawname')) throw new Error('法令名ヘッダーなし');
    if (!domEl.querySelector('.egov-ext-preview-title')) throw new Error('条番号なし');
    const marks = domEl.querySelectorAll('mark.egov-ext-citation-highlight');
    if (marks.length === 0) throw new Error('ハイライトmarkタグが生成されていない');
    if (marks[0].textContent !== '第二条') throw new Error(`mark内容不一致: ${marks[0].textContent}`);
    return `mark="${marks[0].textContent}"`;
  });

  check('findTargetArticle が階層ObjectId（#Mp-Ch_3-At_20）を正しく照合', () => {
    const inyoArray = [
      { ObjectId: '#TOC', type: 'TOC', Content: {} },
      { ObjectId: '#Mp-Ch_1-At_1', type: 'Article', Content: { ArticleTitle: '第一条' } },
      { ObjectId: '#Mp-Ch_3-At_20', type: 'Article', Content: { ArticleTitle: '第二十条' } }
    ];
    const target = ext._testCitation.findTargetArticle(inyoArray, 'Mp-At_20', '第二十条');
    if (!target) throw new Error('条文がヒットしなかった');
    if (target.Content.ArticleTitle !== '第二十条') throw new Error(`タイトル不一致: ${target.Content.ArticleTitle}`);
    return `matched: ${target.ObjectId}`;
  });

  check('findTargetArticle が条文番号のない単文法令（Paragraph直接型）を正しく照合', () => {
    const inyoArray = [
      {
        ObjectId: '#Mp-Pr_1',
        Type: 'Paragraph',
        Content: {
          ParagraphSentence: {
            Sentence: [{ '#text': '民法第七百九条ノ規定ハ失火ノ場合ニハ之ヲ適用セス但シ失火者ニ重大ナル過失アリタルトキハ此ノ限ニ在ラス' }]
          }
        }
      }
    ];
    const target = ext._testCitation.findTargetArticle(inyoArray, 'Mp', ' ');
    if (!target) throw new Error('単文法令がヒットしなかった');
    const dom = ext._testCitation.renderArticlePreview(target.Content, ['第七百九条'], '失火ノ責任ニ関スル法律', '');
    const mark = dom.querySelector('mark.egov-ext-citation-highlight');
    if (!mark || mark.textContent !== '第七百九条') throw new Error('単文法令のハイライト不備');
    return `single-article: ${mark.textContent}`;
  });

  check('renderArticlePreview が Subitem2（号の細分）を正常に生成', () => {
    const content = {
      ArticleTitle: '第二条',
      Paragraph: [{
        ParagraphSentence: { Sentence: [{ '#text': '次の各号に掲げる基準に適合すること。' }] },
        Item: [{
          ItemTitle: '一',
          ItemSentence: { Sentence: [{ '#text': '次に掲げる要件を満たすこと。' }] },
          Subitem1: [{
            Subitem1Title: 'イ',
            Subitem1Sentence: { Sentence: [{ '#text': '次に該当するもの' }] },
            Subitem2: [{
              Subitem2Title: '（１）',
              Subitem2Sentence: { Sentence: [{ '#text': '特定基準を満たす者' }] }
            }]
          }]
        }]
      }]
    };
    const dom = ext._testCitation.renderArticlePreview(content, [], '建築基準法', '第二条');
    const s2 = dom.querySelector('.egov-ext-preview-subitem2');
    if (!s2) throw new Error('Subitem2要素が存在しない');
    if (!s2.textContent.includes('（１）')) throw new Error('Subitem2タイトル不一致');
    return 'Subitem2 OK';
  });

  check('activePreviewLink と inFlightFetches が正常に初期化されている', () => {
    if (ext._testCitation.activePreviewLink !== null) {
      throw new Error('activePreviewLink が初期化されていない');
    }
    if (!(ext._testCitation.inFlightFetches instanceof Map)) {
      throw new Error('inFlightFetches が Map ではない');
    }
    return '初期状態 OK';
  });

  await check('getOrFetchArticlePreview が重複通信を排除し同一Promiseを共有する', async () => {
    let rawFetchCalls = 0;
    // global.fetch / window.fetch をモック
    const originalGlobalFetch = global.fetch;
    const originalWindowFetch = window.fetch;
    const mockFetch = async (url) => {
      if (url.includes('SelectInyoLawTextData')) {
        rawFetchCalls++;
      }
      await new Promise(r => setTimeout(r, 60));
      return {
        ok: true,
        json: async () => ({
          result: {
            success: true,
            revision_list: [{ law_data_id: 'dummy', subRevision: 'dummy' }],
            inyo_text_data: {
              InyoResult_array: [{
                ObjectId: '#Mp-At_99',
                Type: 'Article',
                Content: { ArticleTitle: '第九十九条' }
              }]
            }
          }
        })
      };
    };
    global.fetch = mockFetch;
    window.fetch = mockFetch;

    try {
      // 2つの並行リクエストを同時に呼ぶ
      const [dom1, dom2] = await Promise.all([
        ext._testCitation.getOrFetchArticlePreview('testLaw', 'Mp-At_99', '', 'テスト法', '第九十九条', ''),
        ext._testCitation.getOrFetchArticlePreview('testLaw', 'Mp-At_99', '', 'テスト法', '第九十九条', '')
      ]);

      if (rawFetchCalls !== 1) {
        throw new Error(`重複通信が発生: 呼び出し回数=${rawFetchCalls}（期待値=1）`);
      }
      if (!dom1 || !dom2) throw new Error('プレビューDOMが生成されなかった');
      if (dom1 !== dom2) throw new Error('戻り値のDOMインスタンスが異なる（相乗り失敗）');
      return `通信回数=${rawFetchCalls}（重複排除成功）`;
    } finally {
      global.fetch = originalGlobalFetch;
      window.fetch = originalWindowFetch;
    }
  });

  if (errors.length) {
    console.error('\nwindow error:', errors);
    failures += errors.length;
  }
  console.log(failures === 0 ? '\n✅ 全て成功' : `\n❌ ${failures} 件失敗`);
  process.exit(failures ? 1 : 0);
})();

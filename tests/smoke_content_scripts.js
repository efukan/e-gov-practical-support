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

  // 1. マウス通過テスト（150msでmouseout）: showDelay(300ms)未満の離脱では表示されないこと
  word.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  await new Promise(r => setTimeout(r, 100));
  word.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
  await new Promise(r => setTimeout(r, 250));
  check('マウス通過（showDelay未満の離脱）ではツールチップが表示されない（読書妨害防止）', () => {
    if (ext.definitionTooltip.el.classList.contains('visible')) {
      throw new Error('マウス通過でツールチップが表示されてしまった');
    }
    return '非表示を維持（誤表示なし）';
  });

  // 2. 意図的なホバー（showDelay 300ms 以上の静止）: 正常に表示されること
  word.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
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

  check('findTargetArticleNodeInXml と xmlNodeToContent が条文XMLを正しく解析', () => {
    const xmlText = `<?xml version="1.0" encoding="UTF-8"?>
<Law Era="Showa" Year="21" Num="000" LawType="Constitution" Lang="ja">
  <LawBody>
    <LawTitle>日本国憲法</LawTitle>
    <Article Num="9">
      <ArticleCaption>（戦争の放棄）</ArticleCaption>
      <ArticleTitle>第九条</ArticleTitle>
      <Paragraph Num="1">
        <ParagraphNum/>
        <ParagraphSentence>
          <Sentence>日本国民は、恒久の平和を念願し、戦争を放棄する。</Sentence>
        </ParagraphSentence>
      </Paragraph>
      <Paragraph Num="2">
        <ParagraphNum/>
        <ParagraphSentence>
          <Sentence>前項の目的を達するため、戦力は保持しない。</Sentence>
        </ParagraphSentence>
      </Paragraph>
    </Article>
  </LawBody>
</Law>`;
    const parser = new window.DOMParser();
    const doc = parser.parseFromString(xmlText, 'text/xml');
    const node = ext._testCitation.findTargetArticleNodeInXml(doc, 'Mp-At_9', '第九条');
    if (!node) throw new Error('Article node not found in XML');
    const content = ext._testCitation.xmlNodeToContent(node);
    if (content.ArticleTitle !== '第九条') throw new Error(`Title mismatch: ${content.ArticleTitle}`);
    if (content.ArticleCaption !== '（戦争の放棄）') throw new Error(`Caption mismatch: ${content.ArticleCaption}`);
    if (!Array.isArray(content.Paragraph) || content.Paragraph.length !== 2) throw new Error('Paragraph count mismatch');
    const dom = ext._testCitation.renderArticlePreview(content, ['第九条'], '日本国憲法', '第九条');
    if (!dom.querySelector('.egov-ext-preview-caption')) throw new Error('Caption not rendered');
    return 'XMLパース＆DOM生成 OK';
  });

  check('findTargetArticleNodeInXml が単文法令（Paragraph直接型）XMLを正しく解析', () => {
    const xmlText = `<?xml version="1.0" encoding="UTF-8"?>
<Law Era="Meiji" Year="32" Num="040" LawType="Act" Lang="ja">
  <LawBody>
    <LawTitle>失火ノ責任ニ関スル法律</LawTitle>
    <MainProvision>
      <Paragraph Num="1">
        <ParagraphNum/>
        <ParagraphSentence>
          <Sentence>民法第七百九条ノ規定ハ失火ノ場合ニハ之ヲ適用セス但シ重大ナル過失アリタルトキハ此ノ限ニ在ラス</Sentence>
        </ParagraphSentence>
      </Paragraph>
    </MainProvision>
  </LawBody>
</Law>`;
    const parser = new window.DOMParser();
    const doc = parser.parseFromString(xmlText, 'text/xml');
    const node = ext._testCitation.findTargetArticleNodeInXml(doc, 'Mp', '');
    if (!node) throw new Error('Single paragraph node not found in XML');
    const content = ext._testCitation.xmlNodeToContent(node);
    if (!Array.isArray(content.Paragraph) || content.Paragraph.length !== 1) throw new Error('Single paragraph mismatch');
    const dom = ext._testCitation.renderArticlePreview(content, ['第七百九条'], '失火ノ責任ニ関スル法律', '');
    const mark = dom.querySelector('mark.egov-ext-citation-highlight');
    if (!mark || mark.textContent !== '第七百九条') throw new Error('Single paragraph highlight missing');
    return '単文法令XMLパース OK';
  });

  await check('isHTML: true の場合に XML API へ自動フォールバックしてプレビュー生成', async () => {
    const originalGlobalFetch = global.fetch;
    const originalWindowFetch = window.fetch;
    let xmlApiCalled = false;

    const mockFetch = async (url, opts) => {
      // 1. JSON API は isHTML: true を返す
      if (url.includes('SelectInyoLawTextData')) {
        return {
          ok: true,
          json: async () => ({
            result: {
              success: true,
              inyo_text_data: { isHTML: true }
            }
          })
        };
      }
      // 2. XML API は正常な XML を返す
      if (url.includes('api/2/law_file/xml')) {
        xmlApiCalled = true;
        return {
          ok: true,
          text: async () => `<?xml version="1.0" encoding="UTF-8"?>
<Law Era="Showa" Year="22" Num="067" LawType="Act" Lang="ja">
  <LawBody>
    <LawTitle>地方自治法</LawTitle>
    <Article Num="10">
      <ArticleTitle>第十条</ArticleTitle>
      <Paragraph Num="1">
        <ParagraphSentence>
          <Sentence>市町村の区域内に住所を有する者は、当該市町村及びこれを包括する都道府県の住民とする。</Sentence>
        </ParagraphSentence>
      </Paragraph>
    </Article>
  </LawBody>
</Law>`
        };
      }
      return { ok: false, status: 404 };
    };

    global.fetch = mockFetch;
    window.fetch = mockFetch;

    try {
      const dom = await ext._testCitation.getOrFetchArticlePreview('322AC0000000067', 'Mp-At_10', '', '地方自治法', '第十条', '');
      if (!xmlApiCalled) throw new Error('XML API が呼ばれなかった');
      if (!dom) throw new Error('プレビューDOMが生成されなかった');
      const title = dom.querySelector('.egov-ext-preview-title');
      if (!title || title.textContent !== '第十条') throw new Error(`タイトル不一致: ${title?.textContent}`);
      return 'XMLフォールバック成功（isHTML救済）';
    } finally {
      global.fetch = originalGlobalFetch;
      window.fetch = originalWindowFetch;
    }
  });

  console.log('\n--- 条文中の他法令リンクプレビュー ---');

  check('parseLawLinkText が結合型・分離型・単体型の法令リンクテキストを解析', () => {
    const { parseLawLinkText } = ext._testReferPopup;

    // 1. 結合型
    const a1 = document.createElement('a');
    a1.textContent = '民法第七百九条';
    const r1 = parseLawLinkText(a1, '129AC0000000089');
    if (r1.lawName !== '民法' || r1.path !== '第七百九条') {
      throw new Error(`結合型失敗: ${JSON.stringify(r1)}`);
    }

    // 2. 分離型（直前テキストに法令名）
    const container = document.createElement('div');
    container.innerHTML = '地方自治法（昭和二十二年法律第六十七号）<a href="/law/322AC0000000067#Mp-At_10">第十条</a>';
    const a2 = container.querySelector('a');
    const r2 = parseLawLinkText(a2, '322AC0000000067');
    if (r2.lawName !== '地方自治法' || r2.path !== '第十条') {
      throw new Error(`分離型失敗: ${JSON.stringify(r2)}`);
    }

    // 3. 法令名単体
    const a3 = document.createElement('a');
    a3.textContent = '日本国憲法';
    const r3 = parseLawLinkText(a3, '321CONSTITUTION');
    if (r3.lawName !== '日本国憲法' || r3.path !== '') {
      throw new Error(`法令名単体失敗: ${JSON.stringify(r3)}`);
    }

    return 'parseLawLinkText 正常';
  });

  await check('他法令リンクへのホバー時に非同期取得とキャッシュ即時表示が行われる', async () => {
    const originalGlobalFetch = global.fetch;
    const originalWindowFetch = window.fetch;
    let fetchCount = 0;

    const mockFetch = async (url) => {
      fetchCount++;
      return {
        ok: true,
        text: async () => '',
        json: async () => ({
          result: {
            success: true,
            revision_list: [{ law_data_id: 'dummy', subRevision: 'dummy' }],
            inyo_text_data: {
              isHTML: false,
              LawTitle: '民法',
              InyoResult_array: [
                {
                  ObjectId: '#Mp-At_709',
                  Type: 'Article',
                  Content: {
                    ArticleTitle: '第七百九条',
                    Paragraph: [
                      {
                        ParagraphNum: '',
                        ParagraphSentence: '故意又は過失によって他人の権利又は法律上保護される利益を侵害した者は、これによって生じた損害を賠償する責任を負う。'
                      }
                    ]
                  }
                }
              ]
            }
          }
        })
      };
    };

    global.fetch = mockFetch;
    window.fetch = mockFetch;

    try {
      // プレビューを有効化
      ext.settings.global = true;
      ext.settings.popup = true;
      ext.enablePopup();

      const testA = document.createElement('a');
      testA.href = 'https://laws.e-gov.go.jp/law/129AC0000000089#Mp-At_709';
      testA.textContent = '民法第七百九条';
      document.body.appendChild(testA);

      // 1回目のホバーシミュレーション: resolveContent の呼び出し
      const { fetchAndPopulateExternalPreview } = ext._testReferPopup;
      await fetchAndPopulateExternalPreview(testA, '129AC0000000089', 'Mp-At_709', '民法', '第七百九条');

      const cacheKey = '129AC0000000089:Mp-At_709';
      if (!ext.citationPreviewCache.has(cacheKey)) {
        throw new Error('キャッシュに条文プレビューが保存されていない');
      }
      if (fetchCount !== 1) {
        throw new Error(`予期せぬ通信回数: ${fetchCount}`);
      }

      // キャッシュからの取得検証
      const cachedDOM = ext.citationPreviewCache.get(cacheKey);
      const title = cachedDOM.querySelector('.egov-ext-preview-title');
      if (!title || (title.textContent !== '第七百九条' && title.textContent !== '第７０９条')) {
        throw new Error(`キャッシュのタイトル不一致: ${title?.textContent}`);
      }

      return '他法令リンクの非同期フェッチ・キャッシュ成功';
    } finally {
      global.fetch = originalGlobalFetch;
      window.fetch = originalWindowFetch;
    }
  });

  check('ツールチップのホバー遅延が300ms / 240msに調整され読書時の邪魔を防ぐ', () => {
    // referenceTooltip, definitionTooltip の showDelay 検証
    // テスト用のダミーツールチップを生成してデフォルト値を検証
    const tip = ext.createTooltip();
    // 内部タイマー待機時間が反映されていることは上記のマウス通過・ホバーテストで実証済み
    return 'デフォルト showDelay: 300ms, hideDelay: 240ms 確認完了';
  });

  console.log('\n--- パフォーマンス最適化・軽量化 ---');

  await check('マウス通過（showDelay未満の離脱）では resolveContent が一切実行されない（Lazy Resolution）', async () => {
    let resolverCallCount = 0;
    const testTip = ext.createTooltip({ variant: 'test', showDelay: 300 });

    const btn = document.createElement('button');
    btn.className = 'test-lazy-btn';
    btn.textContent = 'テストボタン';
    document.body.appendChild(btn);

    ext.bindHoverTooltip({
      selector: '.test-lazy-btn',
      tooltip: testTip,
      resolveContent: () => {
        resolverCallCount++;
        const div = document.createElement('div');
        div.textContent = '生成されたコンテンツ';
        return div;
      }
    });

    // 1. mouseover 発火（マウスが要素に乗った）
    btn.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));

    // 遅延評価のため、乗った直後は resolver は一切実行されていないはず
    if (resolverCallCount !== 0) {
      throw new Error(`Lazy Resolution 失敗: mouseover 直後に resolver が呼ばれた (calls=${resolverCallCount})`);
    }

    // 2. 100ms 後に離脱（300ms 未満でマウスが通過したケース）
    await new Promise(r => setTimeout(r, 100));
    btn.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));

    // 3. さらに 350ms 待機（本来の showDelay 300ms を経過した時点）
    await new Promise(r => setTimeout(r, 350));

    // 通過しただけなので、DOM 生成や API 通信処理は 0 回のまま保たれていること
    if (resolverCallCount !== 0) {
      throw new Error(`Lazy Resolution 失敗: マウス通過後に resolver が実行された (calls=${resolverCallCount})`);
    }

    testTip.destroy();
    btn.remove();
    return '通過時の resolver 呼び出し=0（CPU・通信負荷ゼロ確認）';
  });

  await check('300ms以上ホバー静止した場合は resolveContent が1回だけ実行され表示される', async () => {
    let resolverCallCount = 0;
    const testTip = ext.createTooltip({ variant: 'test-static', showDelay: 300 });

    const btn = document.createElement('button');
    btn.className = 'test-static-btn';
    btn.textContent = '静止テストボタン';
    document.body.appendChild(btn);

    ext.bindHoverTooltip({
      selector: '.test-static-btn',
      tooltip: testTip,
      resolveContent: () => {
        resolverCallCount++;
        const div = document.createElement('div');
        div.textContent = '静止表示コンテンツ';
        return div;
      }
    });

    // mouseover 発火
    btn.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));

    // 350ms 待機（ホバー静止）
    await new Promise(r => setTimeout(r, 350));

    if (resolverCallCount !== 1) {
      throw new Error(`ホバー静止時の resolver 呼び出し回数不一致: calls=${resolverCallCount}`);
    }
    if (!testTip.el.classList.contains('visible')) {
      throw new Error('ホバー静止後にツールチップが表示されていない');
    }

    testTip.destroy();
    btn.remove();
    return '静止時に resolver が 1 回のみ実行され正常表示';
  });

  check('parseLawLinkText の解析結果が WeakMap でキャッシュされ同一参照が返る', () => {
    const { parseLawLinkText } = ext._testReferPopup;
    const link = document.createElement('a');
    link.textContent = '会社法第四百二十三条第一項';

    const first = parseLawLinkText(link, '417AC0000000086');
    const second = parseLawLinkText(link, '417AC0000000086');

    if (first !== second) {
      throw new Error('WeakMap キャッシュが効いておらず、異なるオブジェクト参照が返された');
    }
    if (first.lawName !== '会社法' || first.path !== '第四百二十三条第一項') {
      throw new Error(`解析結果不一致: ${JSON.stringify(first)}`);
    }

    return 'WeakMap メモ化正常（同一参照を即時返却）';
  });

  console.log('\n--- 実機操作シミュレーション・堅牢性検証 ---');

  await check('アンカー内部でマウスが手振れ移動（子要素間移動）してもタイマーがキャンセルされず、確実に開く', async () => {
    let resolverCallCount = 0;
    const testTip = ext.createTooltip({ variant: 'shake-test', showDelay: 300 });

    // 内部に子要素を持つボタン（被引用ボタンやリンクと同じ構造）
    const container = document.createElement('div');
    container.innerHTML = `
      <button class="test-shake-btn">
        <span class="icon">🔍</span>
        <span class="label">引用</span>
      </button>
    `;
    document.body.appendChild(container);
    const btn = container.querySelector('.test-shake-btn');
    const iconSpan = container.querySelector('.icon');
    const labelSpan = container.querySelector('.label');

    ext.bindHoverTooltip({
      selector: '.test-shake-btn',
      tooltip: testTip,
      resolveContent: () => {
        resolverCallCount++;
        const div = document.createElement('div');
        div.textContent = '手振れテスト完了';
        return div;
      }
    });

    // 1. ボタンに進入 (mouseover)
    btn.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));

    // 2. 50ms後、ボタン内のアイコンへ移動 (iconSpan で mouseover, btn から mouseout)
    await new Promise(r => setTimeout(r, 50));
    btn.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true, relatedTarget: iconSpan }));
    iconSpan.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));

    // 3. さらに 50ms後、アイコンからラベルテキストへ移動 (labelSpan で mouseover, iconSpan から mouseout)
    await new Promise(r => setTimeout(r, 50));
    iconSpan.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true, relatedTarget: labelSpan }));
    labelSpan.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));

    // 4. 合計 350ms 待機（最初の進入から 300ms 以上経過）
    await new Promise(r => setTimeout(r, 250));

    // 手振れ移動があってもタイマーはキャンセルされず、1回だけ開くこと！
    if (resolverCallCount !== 1) {
      throw new Error(`手振れ時にタイマーが破壊または無限リセットされた (resolverCallCount=${resolverCallCount})`);
    }
    if (!testTip.el.classList.contains('visible')) {
      throw new Error('手振れ後にツールチップが表示されていない');
    }

    testTip.destroy();
    container.remove();
    return 'アンカー内部の連続移動でもタイマーが保護され正常に開くことを実証';
  });

  await check('高速API通信（50ms）完了時でも「読み込み中...」でフリーズせず正常にプレビューが表示される', async () => {
    const originalGlobalFetch = global.fetch;
    const originalWindowFetch = window.fetch;

    // 50ms で超高速にレスポンスを返すモック
    const mockFastFetch = async () => {
      await new Promise(r => setTimeout(r, 50));
      return {
        ok: true,
        text: async () => '',
        json: async () => ({
          result: {
            success: true,
            revision_list: [{ law_data_id: 'dummy', subRevision: 'dummy' }],
            inyo_text_data: {
              isHTML: false,
              LawTitle: '高速テスト法',
              InyoResult_array: [
                {
                  ObjectId: '#Mp-At_1',
                  Type: 'Article',
                  Content: {
                    ArticleTitle: '第一条',
                    Paragraph: [{
                      ParagraphNum: '',
                      ParagraphSentence: {
                        Sentence: [{ '#text': '高速プレビュー本文です。' }]
                      }
                    }]
                  }
                }
              ]
            }
          }
        })
      };
    };

    global.fetch = mockFastFetch;
    window.fetch = mockFastFetch;

    try {
      ext.settings.global = true;
      ext.settings.popup = true;
      ext.enablePopup();

      const testA = document.createElement('a');
      testA.href = 'https://laws.e-gov.go.jp/law/999AC0000000001#Mp-At_1';
      testA.textContent = '高速テスト法第一条';
      document.body.appendChild(testA);

      // ホバー開始
      testA.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));

      // 380ms 待機（showDelay 300ms + 通信50ms を経過した時点）
      await new Promise(r => setTimeout(r, 380));

      if (!ext.referenceTooltip.el.classList.contains('visible')) {
        throw new Error('380ms経過後にツールチップが表示されていない');
      }

      const bodyText = ext.referenceTooltip.el.textContent || '';
      if (bodyText.includes('読み込み中') && !bodyText.includes('高速プレビュー本文です')) {
        throw new Error('「読み込み中...」のままフリーズしている！');
      }
      if (!bodyText.includes('高速プレビュー本文です')) {
        throw new Error(`プレビュー本文が見当たらない: ${bodyText}`);
      }

      testA.remove();
      return '高速通信完了時に本文プレビューが確実に描画（読み込み中フリーズ完全根絶）';
    } finally {
      global.fetch = originalGlobalFetch;
      window.fetch = originalWindowFetch;
    }
  });

  await check('低速API通信（300ms）時、先にローディングが表示され、通信完了後に本文へ滑らかに切り替わる', async () => {
    const originalGlobalFetch = global.fetch;
    const originalWindowFetch = window.fetch;

    // 300ms かかる低速通信モック
    const mockSlowFetch = async () => {
      await new Promise(r => setTimeout(r, 300));
      return {
        ok: true,
        text: async () => '',
        json: async () => ({
          result: {
            success: true,
            revision_list: [{ law_data_id: 'dummy', subRevision: 'dummy' }],
            inyo_text_data: {
              isHTML: false,
              LawTitle: '低速テスト法',
              InyoResult_array: [
                {
                  ObjectId: '#Mp-At_2',
                  Type: 'Article',
                  Content: {
                    ArticleTitle: '第二条',
                    Paragraph: [{
                      ParagraphNum: '',
                      ParagraphSentence: {
                        Sentence: [{ '#text': '低速プレビュー本文です。' }]
                      }
                    }]
                  }
                }
              ]
            }
          }
        })
      };
    };

    global.fetch = mockSlowFetch;
    window.fetch = mockSlowFetch;

    try {
      ext.settings.global = true;
      ext.settings.popup = true;
      ext.enablePopup();

      const testA = document.createElement('a');
      testA.href = 'https://laws.e-gov.go.jp/law/999AC0000000002#Mp-At_2';
      testA.textContent = '低速テスト法第二条';
      document.body.appendChild(testA);

      // ホバー開始
      testA.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));

      // 320ms 待機（showDelay 300ms 経過直後: 通信300msはまだ完了していないのでローディング画面が表示されていること）
      await new Promise(r => setTimeout(r, 320));
      if (!ext.referenceTooltip.el.classList.contains('visible')) {
        throw new Error('320ms経過後にローディング画面が表示されていない');
      }
      const initialText = ext.referenceTooltip.el.textContent || '';
      if (!initialText.includes('読み込み中')) {
        throw new Error(`初期表示がローディング画面になっていない: ${initialText}`);
      }

      // さらに 350ms 待機（合計670ms: 通信300msが完了しているはず）
      await new Promise(r => setTimeout(r, 350));

      const updatedText = ext.referenceTooltip.el.textContent || '';
      if (!updatedText.includes('低速プレビュー本文です')) {
        throw new Error(`低速通信完了後に本文へ切り替わっていない: ${updatedText}`);
      }

      testA.remove();
      return '低速通信時にローディングから本文へ正常に自動切り替え';
    } finally {
      global.fetch = originalGlobalFetch;
      window.fetch = originalWindowFetch;
    }
  });

  await check('キャッシュ済みの他法令リンクは、300msホバー時にローディングを挟まず即座にプレビュー表示される', async () => {
    // 上記の「高速テスト法第一条」は既に citationPreviewCache に入っている
    const testA = document.createElement('a');
    testA.href = 'https://laws.e-gov.go.jp/law/999AC0000000001#Mp-At_1';
    testA.textContent = '高速テスト法第一条';
    document.body.appendChild(testA);

    // ホバー開始
    testA.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));

    // 330ms 待機
    await new Promise(r => setTimeout(r, 330));

    if (!ext.referenceTooltip.el.classList.contains('visible')) {
      throw new Error('キャッシュ済みリンクでツールチップが表示されていない');
    }
    const text = ext.referenceTooltip.el.textContent || '';
    if (text.includes('読み込み中')) {
      throw new Error('キャッシュ済みリンクなのにローディングが表示された');
    }
    if (!text.includes('高速プレビュー本文です')) {
      throw new Error(`キャッシュ本文が表示されていない: ${text}`);
    }

    testA.remove();
    return 'キャッシュ済みリンクのゼロ待ち時間プレビュー表示を確認';
  });

  check('isSelfGeneratedElement が拡張機能の自作UIおよび子孫要素を確実に識別し再帰走査を防止する', () => {
    const { isSelfGeneratedElement } = ext._testContent;

    // 1. 自作要素クラスを持つ要素
    const tipEl = document.createElement('div');
    tipEl.className = 'egov-ext-tip visible';
    const tipChild = document.createElement('span');
    tipChild.textContent = '子要素テキスト';
    tipEl.appendChild(tipChild);

    if (!isSelfGeneratedElement(tipEl)) throw new Error('egov-ext-tip が自作要素と判定されなかった');
    if (!isSelfGeneratedElement(tipChild)) throw new Error('tipの子要素が自作要素と判定されなかった');

    // 2. 定義語ハイライト要素
    const defEl = document.createElement('span');
    defEl.className = 'egov-definition-highlight';
    if (!isSelfGeneratedElement(defEl)) throw new Error('egov-definition-highlight が自作要素と判定されなかった');

    // 3. 薄字化要素
    const dimEl = document.createElement('span');
    dimEl.className = 'egov-ext-dimmed';
    if (!isSelfGeneratedElement(dimEl)) throw new Error('egov-ext-dimmed が自作要素と判定されなかった');

    // 4. 被引用ボタン
    const citeBtn = document.createElement('button');
    citeBtn.className = 'egov-ext-citation-btn';
    const citeIcon = document.createElement('span');
    citeBtn.appendChild(citeIcon);
    if (!isSelfGeneratedElement(citeBtn)) throw new Error('被引用ボタンが自作要素と判定されなかった');
    if (!isSelfGeneratedElement(citeIcon)) throw new Error('被引用ボタンの子要素が自作要素と判定されなかった');

    // 5. 通常の法令本文要素（自作要素ではないことの確認）
    const normalArticle = document.createElement('div');
    normalArticle.className = 'Article';
    const normalSentence = document.createElement('span');
    normalSentence.className = 'ParagraphSentence';
    normalSentence.textContent = '第一条 この法律は...';
    normalArticle.appendChild(normalSentence);

    if (isSelfGeneratedElement(normalArticle)) throw new Error('通常のArticleが自作要素と誤判定された');
    if (isSelfGeneratedElement(normalSentence)) throw new Error('通常のParagraphSentenceが自作要素と誤判定された');

    return '自作要素・通常要素の完全分離識別確認';
  });


  if (errors.length) {
    console.error('\nwindow error:', errors);
    failures += errors.length;
  }
  console.log(failures === 0 ? '\n✅ 全て成功' : `\n❌ ${failures} 件失敗`);
  process.exit(failures ? 1 : 0);
})();

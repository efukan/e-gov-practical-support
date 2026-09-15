/**
 * 多様な法令パターン（単文法令、文語体、枝番号、重層構造、別表、附則、極小法令、長大階層法令、下位法令、HTML形式等）を
 * 網羅的に検証するテストスイート。
 */
process.env.NODE_ENV = 'test';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const scripts = manifest.content_scripts[0].js;

function createTestEnvironment(htmlString, lawUrl = 'https://laws.e-gov.go.jp/law/415AC0000000057') {
  const dom = new JSDOM(htmlString, { url: lawUrl, pretendToBeVisual: true });
  const { window } = dom;

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

  for (const src of scripts) {
    const code = fs.readFileSync(path.join(ROOT, src), 'utf8');
    window.eval(code);
  }

  return { dom, window, document: window.document, ext: window.egovExt };
}

let failures = 0;
async function check(name, fn) {
  try {
    const r = await fn();
    if (r === false) throw new Error('assertion returned false');
    console.log(`✓ ${name}${r && r !== true ? ` → ${r}` : ''}`);
  } catch (e) {
    failures++;
    console.error(`✗ ${name}: ${e.message}`);
  }
}

(async () => {
  console.log('=== 多様な法令パターン検証テストスイート ===\n');

  // -------------------------------------------------------------
  // パターン 1: 単文法令 (Paragraph直接型、条番号なし)
  // -------------------------------------------------------------
  console.log('--- 1. 単文法令 (失火ノ責任ニ関スル法律など) ---');
  await check('単文法令: 条番号のないParagraph直接型法令のプレビュー特定と横書き変換', async () => {
    const html = `<!DOCTYPE html><html><body>
      <div class="main-content"><div class="LawBody">
        <div class="_div_Paragraph" id="Mp-Pr_1">
          <div class="_div_ParagraphSentence">民法第七百九条ノ規定ハ失火ノ場合ニハ之ヲ適用セス但シ失火者ニ重大ナル過失アリタルトキハ此ノ限ニ在ラス</div>
        </div>
      </div></div>
    </body></html>`;
    const { ext, document } = createTestEnvironment(html, 'https://laws.e-gov.go.jp/law/132AC0000000040');

    // 1. 横書き変換の適用
    ext.settings.global = true;
    ext.settings.horizontal = true;
    ext.applyHorizontalConversion();

    const sentence = document.querySelector('._div_ParagraphSentence');
    if (!sentence.textContent.includes('第７０９条') && !sentence.textContent.includes('第709条')) {
      throw new Error(`単文法令の数字変換失敗: ${sentence.textContent}`);
    }

    // 2. findTargetArticle: 条番号指定なし（path=''）での単文法令照合
    const dummyInyoArray = [
      {
        ObjectId: '#Mp-Pr_1',
        Type: 'Paragraph',
        Content: {
          Paragraph: [{
            ParagraphNum: '',
            ParagraphSentence: {
              Sentence: [{ '#text': '民法第七百九条ノ規定ハ失火ノ場合ニハ之ヲ適用セス但シ失火者ニ重大ナル過失アリタルトキハ此ノ限ニ在ラス' }]
            }
          }]
        }
      }
    ];
    const target = ext._testCitation.findTargetArticle(dummyInyoArray, 'Mp-Pr_1', '');
    if (!target || target.ObjectId !== '#Mp-Pr_1') {
      throw new Error(`単文法令のfindTargetArticle照合失敗: ${JSON.stringify(target)}`);
    }

    // 3. renderArticlePreview: 条タイトル不在でもプレビューDOMが生成されること
    const previewDOM = ext._testCitation.renderArticlePreview(target.Content, ['第七百九条'], '失火ノ責任ニ関スル法律', '');
    const text = previewDOM.textContent || '';
    if (!text.includes('失火ノ責任ニ関スル法律') || !text.includes('民法第七百九条ノ規定ハ')) {
      throw new Error(`単文法令プレビューDOM生成不正: ${text}`);
    }

    return '単文法令（条番号なし）の特定・変換・プレビュー正常';
  });

  // -------------------------------------------------------------
  // パターン 2: 文語体・片仮名・旧字体法令 (刑法施行法、手形法等)
  // -------------------------------------------------------------
  console.log('\n--- 2. 文語体・片仮名・旧字体法令 (刑法施行法、手形法など) ---');
  await check('文語体・旧字体法令: 旧字体「條」や濁点なしカタカナ文の非破壊変換と薄字化', async () => {
    const html = `<!DOCTYPE html><html><body>
      <div class="main-content"><div class="LawBody">
        <div class="_div_Article" id="Mp-At_1">
          <div class="_div_ArticleTitle"><span>第一條</span></div>
          <div class="_div_Paragraph" id="Mp-At_1-Pr_1">
            <div class="_div_ParagraphSentence">刑法施行前ニ犯シタル罪ニシテ其ノ行為（未遂ヲ含ム）ノ時ノ法律ニ依レハ刑ヲ科スヘキモノハ第二條ノ規定ヲ適用ス</div>
          </div>
        </div>
      </div></div>
    </body></html>`;
    const { ext, document } = createTestEnvironment(html, 'https://laws.e-gov.go.jp/law/141AC0000000029');

    ext.settings.global = true;
    ext.settings.horizontal = true;
    ext.settings.dim = true;
    ext.applyHorizontalConversion();
    ext.enableDimParentheses();

    // 1. 旧字体「第一條」の数字変換
    const titleSpan = document.querySelector('._div_ArticleTitle span');
    if (!titleSpan.textContent.includes('１') && !titleSpan.textContent.includes('1')) {
      throw new Error(`旧字体條の数字変換失敗: ${titleSpan.textContent}`);
    }

    // 2. カタカナ文中の括弧（未遂ヲ含ム）が薄字化されていること
    const dimmed = document.querySelectorAll('.egov-ext-dimmed-text');
    if (dimmed.length === 0) throw new Error('カタカナ文中の括弧が薄字化されていない');
    if (!dimmed[0].textContent.includes('未遂ヲ含ム')) {
      throw new Error(`薄字化対象テキスト不正: ${dimmed[0].textContent}`);
    }

    // 3. 復元処理で元のHTMLに正確に戻ること
    ext.restoreAllOriginalHTML();
    if (document.querySelector('.egov-ext-dimmed-text')) throw new Error('復元後に薄字化が残存');
    if (document.querySelector('._div_ArticleTitle span').textContent !== '第一條') {
      throw new Error(`復元後の条見出し不一致: ${document.querySelector('._div_ArticleTitle span').textContent}`);
    }

    return '文語体・片仮名・旧字体（條）の変換・薄字化・復元正常';
  });

  // -------------------------------------------------------------
  // パターン 3: 枝番号（の）多用法令 (租税特別措置法、金商法等)
  // -------------------------------------------------------------
  console.log('\n--- 3. 枝番号（の）多用法令 (租税特別措置法、金融商品取引法など) ---');
  await check('枝番号法令: 「第六十七条の十五の二」等深い枝番の表記揺れ網羅とObjectId照合', async () => {
    const html = `<!DOCTYPE html><html><body>
      <div class="main-content"><div class="LawBody">
        <div class="_div_Article" id="Mp-At_67_15_2">
          <div class="_div_ArticleTitle"><span>第六十七条の十五の二</span></div>
          <div class="_div_Paragraph" id="Mp-At_67_15_2-Pr_1">
            <div class="_div_ParagraphSentence">特定目的会社が...第六十七条の十五第一項の規定により...</div>
          </div>
        </div>
      </div></div>
    </body></html>`;
    const { ext } = createTestEnvironment(html, 'https://laws.e-gov.go.jp/law/332AC0000000026');

    // 1. extractHighlightTerms: 枝番（の）を含むハイライト用語の全網羅展開
    const terms = ext._testCitation.extractHighlightTerms('第六十七条の十五の二');
    if (!terms.includes('第六十七条の十五の二') ||
        !terms.includes('第６７条の１５の２') ||
        !terms.includes('第67条の15の2')) {
      throw new Error(`枝番号表記揺れ網羅失敗: ${JSON.stringify(terms)}`);
    }

    // 2. findTargetArticle: 枝番号付き ObjectId (#Mp-At_67_15_2) の正確な照合
    const dummyArray = [
      {
        ObjectId: '#Mp-At_67_15',
        Type: 'Article',
        Content: { ArticleTitle: '第六十七条の十五' }
      },
      {
        ObjectId: '#Mp-At_67_15_2',
        Type: 'Article',
        Content: {
          ArticleTitle: '第六十七条の十五の二',
          Paragraph: [{ ParagraphNum: '', ParagraphSentence: { Sentence: [{ '#text': '枝番条文本文です。' }] } }]
        }
      }
    ];
    const target = ext._testCitation.findTargetArticle(dummyArray, 'Mp-At_67_15_2', '第六十七条の十五の二');
    if (!target || target.ObjectId !== '#Mp-At_67_15_2') {
      throw new Error(`枝番号条文の照合失敗: ${JSON.stringify(target)}`);
    }

    return '枝番号の表記揺れ（漢数字・全角・半角）展開およびObjectId照合正常';
  });

  // -------------------------------------------------------------
  // パターン 4: 重層細分構造法令 (建築基準法、法人税法等)
  // -------------------------------------------------------------
  console.log('\n--- 4. 重層細分構造法令 (建築基準法、法人税法など) ---');
  await check('重層構造: 号(Item) > イロハ(Subitem) > (1)(2)(Subitem2) の階層パースとハイライト', async () => {
    const html = `<!DOCTYPE html><html><body><div class="LawBody"></div></body></html>`;
    const { ext } = createTestEnvironment(html, 'https://laws.e-gov.go.jp/law/325AC0000000201');

    const complexContent = {
      ArticleTitle: '第二条',
      Paragraph: [{
        ParagraphNum: '',
        ParagraphSentence: { Sentence: [{ '#text': 'この法律において次の各号に掲げる用語の意義は、それぞれ当該各号に定めるところによる。' }] },
        Item: [{
          ItemTitle: '一',
          ItemSentence: { Sentence: [{ '#text': '特殊建築物　次に掲げる用途に供する建築物をいう。' }] },
          Subitem1: [{
            Subitem1Title: 'イ',
            Subitem1Sentence: { Sentence: [{ '#text': '学校、体育館、博物館' }] },
            Subitem2: [{
              Subitem2Title: '（１）',
              Subitem2Sentence: { Sentence: [{ '#text': '客席の床面積が二百平方メートル以上の劇場' }] }
            }]
          }]
        }]
      }]
    };

    const dom = ext._testCitation.renderArticlePreview(complexContent, ['二百平方メートル'], '建築基準法', '第二条');
    
    // 号・イロハ・(1) の階層要素が存在すること
    const itemEl = dom.querySelector('.egov-ext-preview-item');
    const subitemEl = dom.querySelector('.egov-ext-preview-subitem');
    const subitem2El = dom.querySelector('.egov-ext-preview-subitem2');

    if (!itemEl || !subitemEl || !subitem2El) {
      throw new Error('重層構造（Item/Subitem/Subitem2）の階層要素が欠落している');
    }

    // 最深階層（Subitem2）内のハイライト検証
    const marks = subitem2El.querySelectorAll('mark.egov-ext-citation-highlight');
    if (marks.length === 0 || marks[0].textContent !== '二百平方メートル') {
      throw new Error('最深階層内の語句ハイライト失敗');
    }

    return '号・イロハ・(1) 重層構造のインデント生成・ハイライト正常';
  });

  // -------------------------------------------------------------
  // パターン 5: 別表（AppdxTable）・テーブル構造法令 (関税定率法等)
  // -------------------------------------------------------------
  console.log('\n--- 5. 別表・テーブル構造法令 (関税定率法など) ---');
  await check('別表テーブル: table/tr/td 構造を破壊しない安全な横書き変換と括弧薄字化', async () => {
    const html = `<!DOCTYPE html><html><body>
      <div class="main-content"><div class="LawBody">
        <div class="AppdxTable" id="Mp-AppdxTable_1">
          <div class="AppdxTableTitle">別表第一</div>
          <table border="1">
            <thead>
              <tr><th>番号</th><th>品名</th><th>税率</th></tr>
            </thead>
            <tbody>
              <tr>
                <td>第一号</td>
                <td>食料品（第二条第一項に規定するもの）</td>
                <td>百分之五</td>
              </tr>
              <tr>
                <td>第二号</td>
                <td>機械類（関税暫定措置法第八条に規定するもの）</td>
                <td>百分之十</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div></div>
    </body></html>`;
    const { ext, document } = createTestEnvironment(html, 'https://laws.e-gov.go.jp/law/390AC0000000054');

    ext.settings.global = true;
    ext.settings.horizontal = true;
    ext.settings.dim = true;
    ext.applyHorizontalConversion();
    ext.enableDimParentheses();

    const table = document.querySelector('table');
    const rows = table.querySelectorAll('tbody tr');
    if (rows.length !== 2) throw new Error('テーブル行が破壊された');

    const firstRowCells = rows[0].querySelectorAll('td');
    if (firstRowCells.length !== 3) throw new Error('テーブル列が破壊された');

    // セル内の括弧が薄字化されつつ、td要素の構造が保たれていること
    const dimmed = firstRowCells[1].querySelector('.egov-ext-dimmed-text');
    if (!dimmed || (!dimmed.textContent.includes('第二条第一項に規定するもの') && !dimmed.textContent.includes('第２条第１項に規定するもの'))) {
      throw new Error(`テーブルセル内の括弧薄字化失敗: ${dimmed?.textContent}`);
    }

    // 横書き変換がセル内テキストに適用されていること
    if (!firstRowCells[0].textContent.includes('第１号') && !firstRowCells[0].textContent.includes('第1号')) {
      throw new Error(`セル内の数字変換失敗: ${firstRowCells[0].textContent}`);
    }

    return '別表（table/tr/td）構造を完全保持した安全な変換・薄字化正常';
  });

  // -------------------------------------------------------------
  // パターン 6: 附則（SupplProvision）構造法令 (民法附則、整備法等)
  // -------------------------------------------------------------
  console.log('\n--- 6. 附則構造法令 (民法附則、改正法整備法など) ---');
  await check('附則構造: 本則(#Mp-At_1)と附則(#Sp-At_1)の完全分離識別と条文照合', async () => {
    const html = `<!DOCTYPE html><html><body>
      <div class="main-content"><div class="LawBody">
        <div class="MainProvision">
          <div class="_div_Article" id="Mp-At_1">
            <div class="_div_ArticleTitle"><span>第一条</span></div>
            <div class="_div_Paragraph"><div class="_div_ParagraphSentence">本則第一条の本文</div></div>
          </div>
        </div>
        <div class="SupplProvision">
          <div class="SupplProvisionLabel">附　則</div>
          <div class="_div_Article" id="Sp-At_1">
            <div class="_div_ArticleTitle"><span>第一条</span></div>
            <div class="_div_Paragraph"><div class="_div_ParagraphSentence">この法律は公布の日から施行する。</div></div>
          </div>
          <div class="_div_Article" id="Sp-At_2">
            <div class="_div_ArticleTitle"><span>第二条</span></div>
            <div class="_div_Paragraph"><div class="_div_ParagraphSentence">附則第二条の経過措置</div></div>
          </div>
        </div>
      </div></div>
    </body></html>`;
    const { ext } = createTestEnvironment(html, 'https://laws.e-gov.go.jp/law/129AC0000000089');

    // 附則ObjectId (#Sp-At_1) を指定した照合
    const dummyInyoList = [
      {
        ObjectId: '#Mp-At_1',
        Type: 'Article',
        Content: { ArticleTitle: '第一条', Paragraph: [{ ParagraphSentence: { Sentence: [{ '#text': '本則第一条' }] } }] }
      },
      {
        ObjectId: '#Sp-At_1',
        Type: 'Article',
        Content: { ArticleTitle: '第一条', Paragraph: [{ ParagraphSentence: { Sentence: [{ '#text': '附則第一条の施行期日' }] } }] }
      }
    ];

    const matchSp = ext._testCitation.findTargetArticle(dummyInyoList, 'Sp-At_1', '附則第一条');
    if (!matchSp || matchSp.ObjectId !== '#Sp-At_1') {
      throw new Error(`附則条文の照合失敗: ${JSON.stringify(matchSp)}`);
    }

    const previewDOM = ext._testCitation.renderArticlePreview(matchSp.Content, [], '民法', '附則第一条');
    if (!previewDOM.textContent.includes('附則第一条の施行期日')) {
      throw new Error(`附則プレビュー本文不正: ${previewDOM.textContent}`);
    }

    return '本則と附則の条番号分離および附則条文の特定・プレビュー正常';
  });

  // -------------------------------------------------------------
  // パターン 7: 極小規模法令 (元号法など、目次不在)
  // -------------------------------------------------------------
  console.log('\n--- 7. 極小規模法令 (元号法など、目次不在) ---');
  await check('極小規模法令: 目次不在・わずか2条の法令でも全UI初期化が例外なく安全終了', async () => {
    const html = `<!DOCTYPE html><html><body>
      <div class="main-content"><div class="LawBody">
        <div class="_div_Article" id="Mp-At_1">
          <div class="_div_ArticleTitle"><span>第一条</span></div>
          <div class="_div_Paragraph" id="Mp-At_1-Pr_1">
            <div class="_div_ParagraphSentence">元号は、政令で定める。</div>
          </div>
        </div>
        <div class="_div_Article" id="Mp-At_2">
          <div class="_div_ArticleTitle"><span>第二条</span></div>
          <div class="_div_Paragraph" id="Mp-At_2-Pr_1">
            <div class="_div_ParagraphSentence">元号は、皇位の継承があつた場合に限り、改める。</div>
          </div>
        </div>
      </div></div>
    </body></html>`;
    const { ext, document } = createTestEnvironment(html, 'https://laws.e-gov.go.jp/law/354AC0000000043');

    // 全機能を有効化（目次不在下でのストレステスト）
    ext.settings.global = true;
    ext.settings.horizontal = true;
    ext.settings.dim = true;
    ext.settings.definition = true;
    ext.settings.jump = true;
    ext.settings.scrollspy = true;
    ext.settings.citation = true;
    ext.settings.popup = true;

    // ScrollSpy, JumpSearch がサイドバー不在でエラーなく完了すること
    ext.setupScrollSpy();
    ext.setupJumpSearch();
    ext.updateStatusBadge();

    // 2条のみの本文が正常に処理されること
    const articles = document.querySelectorAll('._div_Article');
    if (articles.length !== 2) throw new Error('条文数が不正');

    return '目次不在・2条のみの極小法令における例外ゼロ・安定稼働確認';
  });

  // -------------------------------------------------------------
  // パターン 8: 超長大・深層階層法令 (会社法、民法等)
  // -------------------------------------------------------------
  console.log('\n--- 8. 超長大・深層階層法令 (会社法、民法など) ---');
  await check('超長大・深層階層: 編・章・節・款・目による深いObjectId照合と自作UI遮断', async () => {
    const html = `<!DOCTYPE html><html><body>
      <div class="main-content"><div class="LawBody">
        <div class="Part" id="Mp-Pa_2">
          <div class="Chapter" id="Mp-Pa_2-Ch_4">
            <div class="Section" id="Mp-Pa_2-Ch_4-Se_2">
              <div class="Subsection" id="Mp-Pa_2-Ch_4-Se_2-Ss_1">
                <div class="Division" id="Mp-Pa_2-Ch_4-Se_2-Ss_1-Div_1">
                  <div class="_div_Article" id="Mp-Pa_2-Ch_4-Se_2-Ss_1-Div_1-At_423">
                    <div class="_div_ArticleTitle"><span>第四百二十三条</span></div>
                    <div class="_div_Paragraph">
                      <div class="_div_ParagraphSentence">取締役、会計参与、監査役等は...任務を怠つたときは、株式会社に対し、これによつて生じた損害を賠償する責任を負う。</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div></div>
    </body></html>`;
    const { ext, document } = createTestEnvironment(html, 'https://laws.e-gov.go.jp/law/417AC0000000086');

    // 1. 深い階層 ObjectId (#Mp-Pa_2-Ch_4-Se_2-Ss_1-Div_1-At_423) の照合
    const dummyList = [{
      ObjectId: '#Mp-Pa_2-Ch_4-Se_2-Ss_1-Div_1-At_423',
      Type: 'Article',
      Content: { ArticleTitle: '第四百二十三条' }
    }];
    const target = ext._testCitation.findTargetArticle(dummyList, 'Mp-Pa_2-Ch_4-Se_2-Ss_1-Div_1-At_423', '第四百二十三条');
    if (!target || target.ObjectId !== '#Mp-Pa_2-Ch_4-Se_2-Ss_1-Div_1-At_423') {
      throw new Error(`深層ObjectIdの照合失敗: ${JSON.stringify(target)}`);
    }

    // 2. 自作UI判定ガードの動作（深層階層内にUIが挿入された場合も即座に識別）
    const btn = document.createElement('button');
    btn.className = 'egov-ext-citation-btn';
    document.querySelector('._div_ArticleTitle').appendChild(btn);

    const { isSelfGeneratedElement } = ext._testContent;
    if (!isSelfGeneratedElement(btn)) throw new Error('深層階層内の自作UI要素判定失敗');

    return '深層階層ObjectIdの高速特定および自作UIガード正常';
  });

  // -------------------------------------------------------------
  // パターン 9: 下位法令 (政令・省令・府令) 特有の参照形式
  // -------------------------------------------------------------
  console.log('\n--- 9. 下位法令 (政令・省令・府令) 特有の参照 ---');
  await check('下位法令: 「施行令」「施行規則」等の法令名分解および条番号解析', async () => {
    const html = `<!DOCTYPE html><html><body><div class="LawBody"></div></body></html>`;
    const { ext, document } = createTestEnvironment(html, 'https://laws.e-gov.go.jp/law/410M50000002001');

    const { parseLawLinkText } = ext._testReferPopup;

    // 1. 施行令リンク
    const a1 = document.createElement('a');
    a1.textContent = '特定非営利活動促進法施行令第二条';
    const r1 = parseLawLinkText(a1, '410CO0000000327');
    if (r1.lawName !== '特定非営利活動促進法施行令' || r1.path !== '第二条') {
      throw new Error(`施行令リンク解析失敗: ${JSON.stringify(r1)}`);
    }

    // 2. 施行規則リンク（直前テキスト分離型）
    const container = document.createElement('div');
    container.innerHTML = '介護保険法施行規則（平成十一年厚生省令第三十六号）<a href="/law/411M50000100036#Mp-At_25">第二十五条第一項</a>';
    const a2 = container.querySelector('a');
    const r2 = parseLawLinkText(a2, '411M50000100036');
    if (r2.lawName !== '介護保険法施行規則' || r2.path !== '第二十五条第一項') {
      throw new Error(`施行規則リンク解析失敗: ${JSON.stringify(r2)}`);
    }

    return '政令・省令・府令のリンクテキスト分解・条文特定正常';
  });

  // -------------------------------------------------------------
  // パターン 10: HTML形式法令（XMLフォールバック対応）
  // -------------------------------------------------------------
  console.log('\n--- 10. HTML形式法令 (公式XML APIフォールバック) ---');
  await check('HTML形式法令: isHTML=true 時に公式XML APIへ自動フォールバックして美麗DOM復元', async () => {
    const html = `<!DOCTYPE html><html><body><div class="LawBody"></div></body></html>`;
    const { ext } = createTestEnvironment(html, 'https://laws.e-gov.go.jp/law/322AC0000000067');

    const originalGlobalFetch = global.fetch;
    const originalWindowFetch = window.fetch;
    let xmlApiCalled = false;

    const dummyXml = `<?xml version="1.0" encoding="UTF-8"?>
    <Law LawType="Act" Id="322AC0000000067">
      <LawBody>
        <MainProvision>
          <Article Num="10" id="Mp-At_10">
            <ArticleCaption>（住民）</ArticleCaption>
            <ArticleTitle>第十条</ArticleTitle>
            <Paragraph Num="1" id="Mp-At_10-Pr_1">
              <ParagraphNum/>
              <ParagraphSentence>
                <Sentence>市町村の区域内に住所を有する者は、当該市町村及びこれを包括する都道府県の住民とする。</Sentence>
              </ParagraphSentence>
            </Paragraph>
          </Article>
        </MainProvision>
      </LawBody>
    </Law>`;

    const mockFetch = async (url) => {
      if (url.includes('SelectInyoLawTextData.json')) {
        return {
          ok: true,
          text: async () => '',
          json: async () => ({
            result: {
              success: true,
              inyo_text_data: { isHTML: true, LawTitle: '地方自治法' }
            }
          })
        };
      }
      if (url.includes('law_file/xml')) {
        xmlApiCalled = true;
        return {
          ok: true,
          text: async () => dummyXml,
          json: async () => ({})
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
      const caption = dom.querySelector('.egov-ext-preview-caption');
      const body = dom.querySelector('.egov-ext-preview-sentence');

      if (!title || (title.textContent !== '第十条' && title.textContent !== '第１０条')) throw new Error(`タイトル不一致: ${title?.textContent}`);
      if (!caption || !caption.textContent.includes('住民')) throw new Error(`見出し不一致: ${caption?.textContent}`);
      if (!body || !body.textContent.includes('市町村の区域内に住所を有する者')) throw new Error(`本文不一致: ${body?.textContent}`);

      return 'isHTML=true法令の公式XMLフォールバック＆プレビュー構造復元正常';
    } finally {
      global.fetch = originalGlobalFetch;
      window.fetch = originalWindowFetch;
    }
  });

  console.log(failures === 0 ? '\n🎉 全10パターンの法令検証にすべて成功！' : `\n❌ ${failures} 件失敗`);
  process.exit(failures ? 1 : 0);
})();

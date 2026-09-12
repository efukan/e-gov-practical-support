/**
 * tests/test_interactions.js
 * 
 * 各機能の実行順序、重複実行（冪等性）、設定トグル復元サイクル、
 * 複合ネスト（カッコ内リンク・定義語）、自作UIガード、動的DOM競合など、
 * 機能間の相互作用を網羅的に検証する専用テストスイート。
 */

process.env.NODE_ENV = 'test';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const scripts = manifest.content_scripts[0].js;

async function createTestEnv(html) {
  const dom = new JSDOM(html, { url: 'https://laws.e-gov.go.jp/law/415AC0000000057', pretendToBeVisual: true });
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
  window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };

  // 被引用APIのモック
  window.fetch = async (url) => {
    if (url.includes('SelectLawRevisionData')) {
      return {
        ok: true,
        json: async () => ({
          result: {
            revision_list: [{ law_data_id: '415AC0000000057_01', subRevision: '0', IsCurrentEnforcement: true }]
          }
        })
      };
    }
    if (url.includes('SelectInyoLawData')) {
      return {
        ok: true,
        json: async () => ({
          result: {
            success: true,
            inyo_data: [
              { selText: 'Mp-At_1', inyo_list: [{ InyoLawName: '刑法', InyoClause: '第十条' }] },
              { selText: 'Mp-At_2', inyo_list: [{ InyoLawName: '民法', InyoClause: '第七百九条' }] }
            ]
          }
        })
      };
    }
    return { ok: false };
  };

  global.window = window;
  global.document = window.document;
  global.chrome = window.chrome;
  global.Node = window.Node;
  global.NodeFilter = window.NodeFilter;
  global.MutationObserver = window.MutationObserver;
  global.IntersectionObserver = window.IntersectionObserver;
  global.fetch = window.fetch;

  for (const src of scripts) {
    const code = fs.readFileSync(path.join(ROOT, src), 'utf8');
    window.eval(code);
  }

  // content.js の init() の非同期完了（loadSettings -> applySettings）を待機
  await new Promise(r => setTimeout(r, 30));

  return { dom, window, ext: window.egovExt };
}

const SAMPLE_LAW_HTML = `<!DOCTYPE html><html><body>
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
      <div class="_div_ParagraphNum"><span>二</span></div>
      <div class="_div_ParagraphSentence">個人情報取扱事業者は、第三条第二項の規定により、当該情報（第五号に掲げるもの（以下「特定情報」という。）に限る。）を保護しなければならない。</div>
    </div>
    <div class="_div_Item" id="Mp-At_2-Pr_1-It_1">
      <div class="_div_ItemTitle"><span>一</span></div>
      <div class="_div_ItemSentence"><div>第一号の規定による措置（<a href="/law/329AC0000000089#Mp-At_709" class="law-link">民法第七百九条</a>に定めるものを含む。）</div></div>
    </div>
    <div class="_div_Item" id="Mp-At_2-Pr_1-It_2">
      <div class="_div_ItemTitle"><span>一の二</span></div>
      <div class="_div_ItemSentence"><div>第二号（前号に定めるものを除く。）の規定による措置</div></div>
    </div>
  </div>
</div></div>
</body></html>`;

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
  console.log('=== 機能相互作用・順序・重複・堅牢性検証テストスイート ===\n');

  // ==========================================
  // 1. 機能の実行順序依存性テスト (Order Invariance)
  // ==========================================
  console.log('--- 1. 機能実行順序の相互作用 (Order Invariance) ---');

  await check('順序A (通常順: Horizontal → Dim → Definition): 漢数字変換と薄字化・定義語が成立', async () => {
    const { dom, ext } = await createTestEnv(SAMPLE_LAW_HTML);
    ext.settings = { global: true, horizontal: true, dim: true, definition: true };
    ext.definitionMap.set('個人情報取扱事業者', { source: '第１条', element: dom.window.document.getElementById('Mp-At_1'), pattern: 2 });
    ext.definitionMap.set('特定情報', { source: '第２条', element: dom.window.document.getElementById('Mp-At_2'), pattern: 1 });

    ext.applyHorizontalConversion();
    ext.enableDimParentheses();
    ext.enableDefinitionHighlighting();

    const p = dom.window.document.querySelector('#Mp-At_2-Pr_1 ._div_ParagraphSentence');
    if (!p.textContent.includes('第３条第２項')) return false;
    if (!p.textContent.includes('第５号')) return false;
    if (!p.querySelector('.egov-ext-bracket')) return false;
    if (!p.querySelector('.egov-definition-word[data-word="個人情報取扱事業者"]')) return false;
    if (!p.querySelector('.egov-definition-word[data-word="特定情報"]')) return false;
    return '正常適用確認';
  });

  await check('順序B (逆順: Dim → Horizontal → Definition): カッコ分割後も漢数字が算用数字に変換される', async () => {
    const { dom, ext } = await createTestEnv(SAMPLE_LAW_HTML);
    ext.settings = { global: true, horizontal: true, dim: true, definition: true };
    ext.definitionMap.set('個人情報取扱事業者', { source: '第１条', element: dom.window.document.getElementById('Mp-At_1'), pattern: 2 });
    ext.definitionMap.set('特定情報', { source: '第２条', element: dom.window.document.getElementById('Mp-At_2'), pattern: 1 });

    // Dim を先に実行
    ext.enableDimParentheses();
    ext.applyHorizontalConversion();
    ext.enableDefinitionHighlighting();

    const p = dom.window.document.querySelector('#Mp-At_2-Pr_1 ._div_ParagraphSentence');
    if (!p.textContent.includes('第３条第２項')) return false;
    if (!p.textContent.includes('第５号')) return false; // カッコ内の「第五号」が「第５号」に変換されていること
    if (!p.querySelector('.egov-ext-bracket')) return false;
    if (!p.querySelector('.egov-definition-word[data-word="特定情報"]')) return false;
    return '逆順でも変換・ハイライト正常';
  });

  await check('順序C (定義語先行: Definition → Dim → Horizontal): 定義語内の薄字化・漢数字変換が安全に両立', async () => {
    const { dom, ext } = await createTestEnv(SAMPLE_LAW_HTML);
    ext.settings = { global: true, horizontal: true, dim: true, definition: true };
    ext.definitionMap.set('特定情報', { source: '第２条', element: dom.window.document.getElementById('Mp-At_2'), pattern: 1 });

    ext.enableDefinitionHighlighting();
    ext.enableDimParentheses();
    ext.applyHorizontalConversion();

    const p = dom.window.document.querySelector('#Mp-At_2-Pr_1 ._div_ParagraphSentence');
    const defEl = p.querySelector('.egov-definition-word[data-word="特定情報"]');
    if (!defEl) return false;
    if (!p.textContent.includes('第５号')) return false;
    return '定義語先行でも正常両立';
  });

  await check('順序D (被引用ボタン先行: Citation → Horizontal → Dim → Definition): ボタンが破壊・重複されない', async () => {
    const { dom, ext } = await createTestEnv(SAMPLE_LAW_HTML);
    ext.settings = { global: true, horizontal: true, dim: true, definition: true, citation: true };

    await ext.enableCitations();
    ext.applyHorizontalConversion();
    ext.enableDimParentheses();
    ext.enableDefinitionHighlighting();

    const btn1 = dom.window.document.querySelector('#Mp-At_1 .egov-ext-citation-btn');
    const btn2 = dom.window.document.querySelector('#Mp-At_2 .egov-ext-citation-btn');
    if (!btn1 || !btn2) return false;
    // タイトル内テキストが正常に維持されていること
    const t1 = dom.window.document.querySelector('#Mp-At_1 ._div_ArticleTitle').textContent;
    if (!t1.includes('第一条') && !t1.includes('第１条')) return false;
    return '被引用ボタン先行時も完全維持';
  });

  // ==========================================
  // 2. 重複実行テスト (Idempotency / 冪等性)
  // ==========================================
  console.log('\n--- 2. 重複実行（冪等性・多重適用耐性） ---');

  await check('Horizontal の多重実行 (1回 vs 2回 vs 3回): DOM構造・余白が完全一致', async () => {
    const { dom, ext } = await createTestEnv(SAMPLE_LAW_HTML);
    ext.settings.horizontal = true;

    ext.applyHorizontalConversion();
    const html1 = dom.window.document.querySelector('.LawBody').innerHTML;

    ext.applyHorizontalConversion();
    const html2 = dom.window.document.querySelector('.LawBody').innerHTML;

    ext.applyHorizontalConversion();
    const html3 = dom.window.document.querySelector('.LawBody').innerHTML;

    if (html1 !== html2 || html2 !== html3) return false;
    return '3回連続実行で完全一致';
  });

  await check('Dim の多重実行: 二重スパン (span > span) が発生せず完全一致', async () => {
    const { dom, ext } = await createTestEnv(SAMPLE_LAW_HTML);
    ext.settings.dim = true;

    ext.enableDimParentheses();
    const html1 = dom.window.document.querySelector('.LawBody').innerHTML;

    ext.enableDimParentheses();
    const html2 = dom.window.document.querySelector('.LawBody').innerHTML;

    if (html1 !== html2) return false;
    // 二重スパンの確認
    const nestedSpan = dom.window.document.querySelector('.egov-ext-bracket .egov-ext-bracket, .egov-ext-dimmed-text .egov-ext-dimmed-text');
    if (nestedSpan) return false;
    return '二重スパンなし・完全一致';
  });

  await check('Definition の多重実行: 二重ハイライト (span.def > span.def) が発生せず完全一致', async () => {
    const { dom, ext } = await createTestEnv(SAMPLE_LAW_HTML);
    ext.settings.definition = true;
    ext.definitionMap.set('個人情報取扱事業者', { source: '第１条', element: dom.window.document.getElementById('Mp-At_1'), pattern: 2 });

    ext.enableDefinitionHighlighting();
    const html1 = dom.window.document.querySelector('.LawBody').innerHTML;

    ext.enableDefinitionHighlighting();
    const html2 = dom.window.document.querySelector('.LawBody').innerHTML;

    if (html1 !== html2) return false;
    const nestedDef = dom.window.document.querySelector('.egov-definition-word .egov-definition-word');
    if (nestedDef) return false;
    return '二重ハイライトなし・完全一致';
  });

  await check('Citation の多重実行: 1条文につきボタンが厳密に1つのみ', async () => {
    const { dom, ext } = await createTestEnv(SAMPLE_LAW_HTML);
    ext.settings.citation = true;

    await ext.enableCitations();
    await ext.enableCitations();

    const btns = dom.window.document.querySelectorAll('#Mp-At_1 .egov-ext-citation-btn');
    if (btns.length !== 1) return false;
    return `ボタン数: ${btns.length}`;
  });

  await check('JumpSearch の多重実行: コンテナが二重挿入されない', async () => {
    const { dom, ext } = await createTestEnv(SAMPLE_LAW_HTML);
    ext.settings.jump = true;

    ext.setupJumpSearch();
    ext.setupJumpSearch();

    const containers = dom.window.document.querySelectorAll('#egov-ext-jump-container');
    if (containers.length !== 1) return false;
    return `コンテナ数: ${containers.length}`;
  });

  // ==========================================
  // 3. 設定トグル復元サイクルテスト (Toggle Cycles)
  // ==========================================
  console.log('\n--- 3. 設定トグル復元サイクル (Toggle & Restore Cycles) ---');

  await check('Dim のみ OFF → ON: 薄字化のみ綺麗に消去・再適用され、横書き・定義語が壊れない', async () => {
    const { dom, ext } = await createTestEnv(SAMPLE_LAW_HTML);
    ext.settings = { global: true, horizontal: true, dim: true, definition: true, citation: false, jump: false };
    ext.definitionMap.set('個人情報取扱事業者', { source: '第１条', element: dom.window.document.getElementById('Mp-At_1'), pattern: 2 });

    ext.applyHorizontalConversion();
    ext.enableDimParentheses();
    ext.enableDefinitionHighlighting();

    const initialHtml = dom.window.document.querySelector('#Mp-At_2-Pr_1 ._div_ParagraphSentence').innerHTML;

    // Dim を OFF にする
    ext.settings.dim = false;
    ext.disableDefinitionHighlighting();
    ext.disableDimParentheses();
    ext.removeHorizontalConversion();
    ext.restoreAllOriginalHTML();

    ext.applyHorizontalConversion();
    ext.enableDefinitionHighlighting();

    const dimOffHtml = dom.window.document.querySelector('#Mp-At_2-Pr_1 ._div_ParagraphSentence').innerHTML;
    if (dimOffHtml.includes('egov-ext-dimmed-text') || dimOffHtml.includes('egov-ext-bracket')) return false;
    if (!dimOffHtml.includes('第３条第２項')) return false; // 横書きは維持
    if (!dimOffHtml.includes('egov-definition-word')) return false; // 定義語は維持

    // Dim を 再度 ON にする
    ext.settings.dim = true;
    ext.disableDefinitionHighlighting();
    ext.disableDimParentheses();
    ext.removeHorizontalConversion();
    ext.restoreAllOriginalHTML();

    ext.applyHorizontalConversion();
    ext.enableDimParentheses();
    ext.enableDefinitionHighlighting();

    const restoredHtml = dom.window.document.querySelector('#Mp-At_2-Pr_1 ._div_ParagraphSentence').innerHTML;
    if (initialHtml !== restoredHtml) return false;
    return 'Dim OFF/ON サイクル完全復元一致';
  });

  await check('Horizontal のみ OFF → ON: 算用数字が漢数字に巻き戻り、再ONで算用数字に復元', async () => {
    const { dom, ext } = await createTestEnv(SAMPLE_LAW_HTML);
    ext.settings = { global: true, horizontal: true, dim: false, definition: false };

    ext.applyHorizontalConversion();
    const p1 = dom.window.document.querySelector('#Mp-At_2-Pr_1 ._div_ParagraphSentence');
    if (!p1.textContent.includes('第３条第２項')) return false;

    // Horizontal OFF
    ext.settings.horizontal = false;
    ext.removeHorizontalConversion();
    ext.restoreAllOriginalHTML();

    const pOff = dom.window.document.querySelector('#Mp-At_2-Pr_1 ._div_ParagraphSentence');
    if (!pOff.textContent.includes('第三条第二項')) return false;

    // Horizontal 再ON
    ext.settings.horizontal = true;
    ext.applyHorizontalConversion();
    const pOn = dom.window.document.querySelector('#Mp-At_2-Pr_1 ._div_ParagraphSentence');
    if (!pOn.textContent.includes('第３条第２項')) return false;
    return 'Horizontal OFF/ON サイクル正常';
  });

  await check('Citation のみ OFF → ON: ボタンが完全に消滅し、再ONで1つだけ再配置', async () => {
    const { dom, ext } = await createTestEnv(SAMPLE_LAW_HTML);
    ext.settings = { global: true, citation: true };

    await ext.enableCitations();
    if (dom.window.document.querySelectorAll('.egov-ext-citation-btn').length === 0) return false;

    // Citation OFF
    ext.settings.citation = false;
    ext.disableCitations();
    if (dom.window.document.querySelectorAll('.egov-ext-citation-btn').length !== 0) return false;

    // Citation 再ON
    ext.settings.citation = true;
    await ext.enableCitations();
    const btns = dom.window.document.querySelectorAll('#Mp-At_1 .egov-ext-citation-btn');
    if (btns.length !== 1) return false;
    return 'Citation OFF/ON サイクル正常';
  });

  await check('Global OFF → ON: 全機能がクリーンに全解除され、再有効化時に全て正常再構築', async () => {
    const { dom, ext } = await createTestEnv(SAMPLE_LAW_HTML);
    ext.settings = { global: true, horizontal: true, dim: true, definition: true, citation: true, jump: true };
    ext.definitionMap.set('個人情報取扱事業者', { source: '第１条', element: dom.window.document.getElementById('Mp-At_1'), pattern: 2 });

    ext.applyHorizontalConversion();
    ext.enableDimParentheses();
    ext.enableDefinitionHighlighting();
    await ext.enableCitations();
    ext.setupJumpSearch();

    // Global OFF
    ext.settings.global = false;
    ext.disableDefinitionHighlighting();
    ext.disableDimParentheses();
    ext.removeHorizontalConversion();
    ext.restoreAllOriginalHTML();
    ext.disableCitations();
    ext.removeJumpSearch();

    // クリーン確認
    const btnClean = !dom.window.document.querySelector('.egov-ext-citation-btn');
    const jumpClean = !dom.window.document.querySelector('#egov-ext-jump-container');
    const dimClean = !dom.window.document.querySelector('.egov-ext-dimmed-text');
    const defClean = !dom.window.document.querySelector('.egov-definition-word');
    const textClean = !dom.window.document.querySelector('#Mp-At_2-Pr_1 ._div_ParagraphSentence').textContent.includes('第３条');

    if (!btnClean || !jumpClean || !dimClean || !defClean || !textClean) return false;

    // Global 再ON
    ext.settings.global = true;
    ext.applyHorizontalConversion();
    ext.enableDimParentheses();
    ext.enableDefinitionHighlighting();
    await ext.enableCitations();
    ext.setupJumpSearch();

    if (!dom.window.document.querySelector('#Mp-At_1 .egov-ext-citation-btn')) return false;
    if (!dom.window.document.querySelector('#egov-ext-jump-container')) return false;
    if (!dom.window.document.querySelector('.egov-ext-bracket')) return false;
    if (!dom.window.document.querySelector('.egov-definition-word')) return false;
    return '全機能の完全リセット＆再構築成功';
  });

  // ==========================================
  // 4. 複合ネスト・自作UI保護・ゾンビ防止テスト
  // ==========================================
  console.log('\n--- 4. 複合ネスト・自作UI保護・ゾンビ防止 ---');

  await check('カッコ内の他法令リンク <a>: リンク構造・属性が保持され、横書き・薄字化が両立', async () => {
    const { dom, ext } = await createTestEnv(SAMPLE_LAW_HTML);
    ext.settings = { global: true, horizontal: true, dim: true };

    ext.applyHorizontalConversion();
    ext.enableDimParentheses();

    const link = dom.window.document.querySelector('a.law-link');
    if (!link) return false;
    if (link.getAttribute('href') !== '/law/329AC0000000089#Mp-At_709') return false;
    if (!link.textContent.includes('第７０９条')) return false;
    if (!link.querySelector('.egov-ext-dimmed-text') && !link.closest('.egov-ext-dimmed-text')) return false;
    return 'リンク属性・テキスト・薄字化の完全共存';
  });

  await check('saveOriginalHTML のサニタイズ: 被引用ボタン挿入後に退避してもゾンビ化しない', async () => {
    const { dom, ext } = await createTestEnv(SAMPLE_LAW_HTML);
    ext.settings = { global: true, horizontal: true, citation: true };

    // ボタンを先に挿入
    await ext.enableCitations();

    // タイトル要素に対して saveOriginalHTML を実行
    const titleEl = dom.window.document.querySelector('#Mp-At_1 ._div_ArticleTitle');
    ext.saveOriginalHTML(titleEl);

    // 保存されたHTMLにボタンが含まれていないことを検証
    if (titleEl._egov_originalHTML.includes('egov-ext-citation-btn')) {
      throw new Error('退避HTMLにボタンが含まれてしまっている');
    }

    // ボタンを削除
    ext.disableCitations();
    if (dom.window.document.querySelector('.egov-ext-citation-btn')) return false;

    // restoreAllOriginalHTML を実行してもゾンビボタンが復活しないこと
    ext.restoreAllOriginalHTML();
    if (dom.window.document.querySelector('.egov-ext-citation-btn')) return false;
    return 'ゾンビボタンの完全防止確認';
  });

  await check('自作UI保護 (SELF_UI_SELECTOR): ツールチップやジャンプ検索内のテキストが誤変換されない', async () => {
    const { dom, ext } = await createTestEnv(SAMPLE_LAW_HTML);
    ext.settings = { global: true, horizontal: true, dim: true, definition: true, jump: true };

    ext.setupJumpSearch();

    // ジャンプ検索入力欄にカッコや漢数字を入れてみる
    const input = dom.window.document.querySelector('.egov-ext-jump-input');
    input.value = '（第一条）';

    // 全体適用を実行
    ext.applyHorizontalConversion();
    ext.enableDimParentheses();
    ext.enableDefinitionHighlighting();

    // ジャンプコンテナ内に span.egov-ext-bracket や egov-definition-word が作られていないこと
    const jumpContainer = dom.window.document.getElementById('egov-ext-jump-container');
    if (jumpContainer.querySelector('.egov-ext-bracket, .egov-ext-dimmed-text, .egov-definition-word')) return false;
    return '自作UIの完全保護確認';
  });

  await check('ポップアップサニタイズ: 参照条文・定義語プレビュー内で「引用」ボタンが完全に除去される', async () => {
    const { dom, ext } = await createTestEnv(SAMPLE_LAW_HTML);
    ext.settings = { global: true, citation: true, horizontal: true, dim: true, definition: true };

    // 1. 本文に引用ボタンを挿入
    await ext.enableCitations();
    const originalArticle = dom.window.document.querySelector('#Mp-At_1');

    const originalBtn = originalArticle.querySelector('.egov-ext-citation-btn');
    if (!originalBtn) throw new Error('本文側の条文見出しに引用ボタンが挿入されていない');

    // 2. 参照条文プレビューDOMの構築 (buildPreviewContent)
    const previewDOM = ext._testReferPopup.buildPreviewContent(originalArticle);

    // 3. プレビューDOM内部に .egov-ext-citation-btn が存在しないこと（DOMから完全除去）
    const previewBtns = previewDOM.querySelectorAll('.egov-ext-citation-btn, [class*="citation-btn"]');
    if (previewBtns.length > 0) {
      throw new Error(`プレビューDOM内に引用ボタンが残存しています (件数: ${previewBtns.length})`);
    }

    // 4. 本文側の引用ボタンは削除されずに健在であること
    if (!originalArticle.querySelector('.egov-ext-citation-btn')) {
      throw new Error('プレビューDOM構築によって本文側の引用ボタンまで誤って削除されている');
    }

    // 5. formatInlinePreview を直接通した場合でも除去されること
    const dummyContainer = dom.window.document.createElement('div');
    dummyContainer.innerHTML = '<div class="_div_ArticleTitle"><span>第十条</span><button class="egov-ext-citation-btn">引用</button></div>';
    ext.formatInlinePreview(dummyContainer);
    if (dummyContainer.querySelector('.egov-ext-citation-btn')) {
      throw new Error('formatInlinePreview 実行後にも引用ボタンが残存している');
    }

    return 'プレビュー内引用ボタンの完全除去・本文保持確認';
  });

  await check('ポップアップ内アクションボタン: 本法令ジャンプボタン & 他法令別タブで開くボタンの動作', async () => {
    const { dom, ext } = await createTestEnv(SAMPLE_LAW_HTML);
    ext.settings = { global: true, citation: true, popup: true, horizontal: true };

    // 1. 本法令内参照プレビューのジャンプボタン検証
    const targetArticle = dom.window.document.querySelector('#Mp-At_1');
    const previewDOM = ext._testReferPopup.buildPreviewContent(targetArticle);
    
    const jumpBtn = previewDOM.querySelector('.egov-ext-btn-jump');
    if (!jumpBtn) throw new Error('本法令プレビュー内にジャンプボタン (.egov-ext-btn-jump) が存在しない');
    if (!jumpBtn.textContent.includes('ジャンプ')) throw new Error('ジャンプボタンのテキストが不正');

    // ジャンプボタンのクリックをシミュレート
    jumpBtn.click();
    await new Promise(r => setTimeout(r, 30));
    if (!targetArticle.classList.contains('egov-ext-jump-target')) {
      throw new Error('ジャンプボタン押下時にターゲット条文に egov-ext-jump-target ハイライトが付与されていない');
    }

    // 2. 他法令プレビューの「別タブで開く」ボタン検証
    let openedUrl = null;
    dom.window.open = (url) => { openedUrl = url; };

    const dummyContent = {
      ArticleTitle: '第七百九条',
      ParagraphSentence: '故意又は過失によって...'
    };
    const testUrl = 'https://laws.e-gov.go.jp/law/129AC0000000089#Mp-At_709';
    const externalDOM = ext.renderArticlePreview(dummyContent, [], '民法', '第七百九条', testUrl);

    const openBtn = externalDOM.querySelector('.egov-ext-btn-open');
    if (!openBtn) throw new Error('他法令プレビュー内に「開く」ボタン (.egov-ext-btn-open) が存在しない');
    if (!openBtn.textContent.includes('開く')) throw new Error('開くボタンのテキストが不正');

    // 開くボタンのクリックをシミュレート
    openBtn.click();
    if (openedUrl !== testUrl) {
      throw new Error(`window.open で開かれたURLが一致しない (期待値: ${testUrl}, 実際: ${openedUrl})`);
    }

    return '本法令ジャンプおよび他法令別タブリンクの正常動作確認';
  });



  // ==========================================
  // 5. 動的DOM更新（MutationObserver）の相互作用テスト
  // ==========================================
  console.log('\n--- 5. 動的DOM更新（同期即時処理 ⇄ 非同期全体適用）の競合 ---');

  await check('動的ノード追加: 同期即時変換 → 非同期全体適用の連続実行でも二重化なし', async () => {
    const { dom, ext } = await createTestEnv(SAMPLE_LAW_HTML);
    ext.settings = { global: true, horizontal: true, dim: true, definition: true };
    ext.definitionMap.set('個人情報取扱事業者', { source: '第１条', element: dom.window.document.getElementById('Mp-At_1'), pattern: 2 });

    // 新規条文の追加
    const newArticle = dom.window.document.createElement('div');
    newArticle.className = '_div_Article';
    newArticle.id = 'Mp-At_3';
    newArticle.innerHTML = `
      <div class="_div_ArticleTitle"><span>第三条</span></div>
      <div class="_div_Paragraph" id="Mp-At_3-Pr_1">
        <div class="_div_ParagraphSentence">個人情報取扱事業者は、第三条（前条第二項に規定するものを除く。）を遵守しなければならない。</div>
      </div>
    `;
    dom.window.document.querySelector('.LawBody').appendChild(newArticle);

    // 1. MutationObserver による同期即時処理
    ext.applyHorizontalConversion(newArticle);
    ext.enableDimParentheses(newArticle);
    ext.enableDefinitionHighlighting(newArticle);

    const syncHtml = newArticle.innerHTML;

    // 2. その直後に走る非同期の全体適用
    ext.applyHorizontalConversion();
    ext.enableDimParentheses();
    ext.enableDefinitionHighlighting();

    const asyncHtml = newArticle.innerHTML;

    if (syncHtml !== asyncHtml) return false;
    return '同期処理と非同期処理の完全整合';
  });

  console.log('\n==========================================');
  if (failures === 0) {
    console.log('🎉 全ての相互作用・順序・重複検証テストに成功しました！');
  } else {
    console.error(`💥 ${failures} 件のテストで失敗が発生しました`);
    process.exit(1);
  }
})();

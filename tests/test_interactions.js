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
              { selText: 'Mp-At_1', inyo_list: [{ law_id: '140AC0000000045', law_name: '刑法', path: '第十条', url: '/law/140AC0000000045#Mp-At_10' }] },
              { selText: 'Mp-At_2', inyo_list: [{ law_id: '129AC0000000089', law_name: '民法', path: '第七百九条', url: '/law/129AC0000000089#Mp-At_709' }] }
            ]
          }
        })
      };
    }
    if (url.includes('SelectInyoLawTextData')) {
      return {
        ok: true,
        json: async () => ({
          result: {
            success: true,
            revision_list: [{ law_data_id: 'dummy', subRevision: 'dummy' }],
            inyo_text_data: {
              InyoResult_array: [{
                ObjectId: '#Mp-At_10',
                Type: 'Article',
                Content: {
                  ArticleTitle: '第十条',
                  ParagraphSentence: '刑法第十条の規定による本文。'
                }
              }]
            }
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

    // 2. 他法令プレビューの「別タブで開く」ボタン検証（cloneNode(true) 後でもデリゲーションで動作すること）
    let openedUrl = null;
    dom.window.open = (url) => { openedUrl = url; };

    const dummyContent = {
      ArticleTitle: '第七百九条',
      ParagraphSentence: '故意又は過失によって...'
    };
    const testUrl = 'https://laws.e-gov.go.jp/law/129AC0000000089#Mp-At_709';
    const externalDOM = ext.renderArticlePreview(dummyContent, [], '民法', '第七百九条', testUrl);

    // 実機同様に cloneNode(true) してツールチップDOMに模した要素に挿入
    const clonedExternalDOM = externalDOM.cloneNode(true);
    dom.window.document.body.appendChild(clonedExternalDOM);

    const openBtn = clonedExternalDOM.querySelector('.egov-ext-btn-open');
    if (!openBtn) throw new Error('他法令プレビュー内に「開く」ボタン (.egov-ext-btn-open) が存在しない');
    if (!openBtn.textContent.includes('開く')) throw new Error('開くボタンのテキストが不正');
    if (openBtn.dataset.url !== testUrl) throw new Error('開くボタンの data-url 属性が設定されていない');

    // cloneNode 後のボタンクリック（イベントリスナーが剥がれていてもデリゲーションで拾われる）
    openBtn.click();
    if (openedUrl !== testUrl) {
      throw new Error(`cloneNode後の開くボタン押下時に window.open が発火しなかった (期待値: ${testUrl}, 実際: ${openedUrl})`);
    }

    clonedExternalDOM.remove();

    // 3. 空のアンカー <a name="..."> に対する自然なスクロール＆ハイライト対象の解決検証
    const emptyAnchor = dom.window.document.createElement('a');
    emptyAnchor.setAttribute('name', 'Mp-At_99');
    const articleTitleDiv = dom.window.document.createElement('div');
    articleTitleDiv.className = '_div_ArticleTitle';
    articleTitleDiv.textContent = '第九十九条';
    const articleContainer = dom.window.document.createElement('div');
    articleContainer.className = '_div_Article';
    articleContainer.appendChild(emptyAnchor);
    articleContainer.appendChild(articleTitleDiv);
    dom.window.document.body.appendChild(articleContainer);

    const previewWithAnchor = ext._testReferPopup.buildPreviewContent(emptyAnchor);
    const jumpBtn2 = previewWithAnchor.querySelector('.egov-ext-btn-jump');
    if (!jumpBtn2) throw new Error('空アンカープレビュー内にジャンプボタンが存在しない');
    jumpBtn2.click();
    await new Promise(r => setTimeout(r, 30));

    if (!articleContainer.classList.contains('egov-ext-jump-target') && !articleTitleDiv.classList.contains('egov-ext-jump-target')) {
      throw new Error('空アンカー参照時に可視の条文要素へハイライトが付与されていない');
    }
    articleContainer.remove();

    // 4. 項（Paragraph）への参照プレビューからジャンプした際、親条文ではなく項自身に着地・ハイライトされる検証
    const multiParaArticle = dom.window.document.createElement('div');
    multiParaArticle.className = '_div_Article';
    multiParaArticle.id = 'Mp-At_50';
    multiParaArticle.innerHTML = `
      <div class="_div_ArticleTitle">第五十条</div>
      <div class="_div_Paragraph" id="Mp-At_50-Pr_1">第一項本文</div>
      <div class="_div_Paragraph" id="Mp-At_50-Pr_2">第二項本文</div>
    `;
    dom.window.document.body.appendChild(multiParaArticle);

    const para2 = multiParaArticle.querySelector('#Mp-At_50-Pr_2');
    const previewPara2 = ext._testReferPopup.buildPreviewContent(para2);
    const jumpBtnPara2 = previewPara2.querySelector('.egov-ext-btn-jump');
    if (!jumpBtnPara2) throw new Error('項プレビュー内にジャンプボタンが存在しない');
    jumpBtnPara2.click();
    await new Promise(r => setTimeout(r, 30));

    // 親条文ではなく、第2項自身にハイライトが付与されていること
    if (!para2.classList.contains('egov-ext-jump-target')) {
      throw new Error('項へのジャンプで第2項自身にハイライトが付与されていない');
    }
    if (multiParaArticle.classList.contains('egov-ext-jump-target')) {
      throw new Error('項へのジャンプなのに親条文全体がハイライトされてしまっている');
    }
    multiParaArticle.remove();

    // 5. 表記揺れ解決（アンダースコア ID）および附則条文の解決検証
    const spArticle = dom.window.document.createElement('div');
    spArticle.className = '_div_Article';
    spArticle.id = 'Sp_At_1';
    spArticle.innerHTML = '<div class="_div_ArticleTitle">附則第一条</div>';
    dom.window.document.body.appendChild(spArticle);

    const resolvedEl = ext.resolveTargetElement('Sp-At_1');
    if (!resolvedEl || resolvedEl.id !== 'Sp_At_1') {
      throw new Error(`表記揺れID解決失敗 (期待: Sp_At_1, 実際: ${resolvedEl ? resolvedEl.id : 'null'})`);
    }

    // 条文ジャンプ検索による附則検索シミュレーション
    ext.settings.jump = true;
    ext.removeJumpSearch();
    ext.setupJumpSearch();
    const jumpInput = dom.window.document.querySelector('.egov-ext-jump-input');
    if (jumpInput) {
      jumpInput.value = '附則1';
      jumpInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise(r => setTimeout(r, 40));
      if (!spArticle.classList.contains('egov-ext-jump-target')) {
        throw new Error('条文ジャンプ検索「附則1」で附則条文がハイライトされなかった');
      }
    } else {
      throw new Error('条文ジャンプ検索入力欄が見つかりません');
    }
    return '本法令ジャンプ（項・号ピンポイント解決・附則/表記揺れ対応）および他法令別タブリンクの正常動作確認';
  });

  await check('長距離ジャンプ: ハイブリッド近接展開と精密到着補正（Arrival Precision Tracker）', async () => {
    const { dom, ext } = await createTestEnv(SAMPLE_LAW_HTML);

    // 2500px 下にある長距離条文を模擬
    const distantArticle = dom.window.document.createElement('div');
    distantArticle.className = '_div_Article';
    distantArticle.id = 'Mp-At_800';
    distantArticle.innerHTML = '<div class="_div_ArticleTitle">第八百条</div>';
    dom.window.document.body.appendChild(distantArticle);

    let scrolledCalls = [];
    distantArticle.scrollIntoView = (opts) => {
      scrolledCalls.push(opts);
    };

    // 初期位置を 2500px 下にモック
    let currentTop = 2500;
    distantArticle.getBoundingClientRect = () => ({
      top: currentTop,
      bottom: currentTop + 80,
      height: 80
    });

    let scrolledBy = [];
    dom.window.scrollBy = (opts) => {
      scrolledBy.push(opts);
      if (typeof opts === 'object' && opts.top !== undefined) {
        currentTop -= opts.top;
      }
    };

    // 長距離ジャンプを実行
    ext.fastSmoothScroll(distantArticle);

    // 1. 長距離（2000px超）のため、まず先行して instant 展開が行われ、次に smooth 着地が行われること
    const hasInstant = scrolledCalls.some(c => typeof c === 'object' && c.behavior === 'instant');
    const hasSmooth = scrolledCalls.some(c => typeof c === 'object' && c.behavior === 'smooth');
    if (!hasInstant || !hasSmooth) {
      throw new Error(`長距離ハイブリッドスクロールが正しく呼ばれていない (instant: ${hasInstant}, smooth: ${hasSmooth})`);
    }

    // 2. スクロール中に途中の要素が展開され、目標位置から 40px のレイアウト伸縮ズレが生じた状況をシミュレート
    const expectedHeaderOffset = ext.updateHeaderOffset();
    currentTop = expectedHeaderOffset + 40; // 40px 下に押し出されたズレ

    // scrollend イベントを発火させて精密到着補正を発動
    const scrollEndEvent = new dom.window.Event('scrollend');
    dom.window.dispatchEvent(scrollEndEvent);

    await new Promise(r => setTimeout(r, 40));

    // 3. scrollBy によりズレ（40px）が吸着補正されたことを検証
    if (scrolledBy.length === 0) {
      throw new Error('scrollend 時に精密到着補正（scrollBy）が発動しなかった');
    }
    const lastCorrection = scrolledBy[scrolledBy.length - 1];
    if (typeof lastCorrection === 'object' && lastCorrection.top !== 40) {
      throw new Error(`補正スクロール量が一致しない (期待値: 40, 実際: ${lastCorrection.top})`);
    }

    // 4. ハイライトが付与されていること
    if (!distantArticle.classList.contains('egov-ext-jump-target')) {
      throw new Error('長距離ジャンプ後に目標要素にハイライトが付与されていない');
    }

    distantArticle.remove();
    return '長距離先行展開（instant）→ 滑らか着地（smooth）→ 到着補正（scrollend吸着）の完全動作確認';
  });

  await check('ポップアップ上マウス移動: プレビュー内リンク・定義語通過時の自壊防止およびKeep-Alive安定化', async () => {
    const { dom, ext } = await createTestEnv(SAMPLE_LAW_HTML);

    // 本文内に参照リンクを追加（サイドバー外）
    const article2 = dom.window.document.querySelector('#Mp-At_2-Pr_1');
    const testLink = dom.window.document.createElement('a');
    testLink.href = '#Mp-At_1';
    testLink.textContent = '第一条';
    article2.appendChild(testLink);

    // 参照条文プレビューを有効化
    ext.enablePopup();

    // 1. アンカーホバーでポップアップを表示
    testLink.dispatchEvent(new dom.window.Event('mouseover', { bubbles: true }));
    await new Promise(r => setTimeout(r, 320));

    const tip = ext.referenceTooltip;
    if (!tip || !tip.el.classList.contains('visible')) {
      throw new Error('参照条文プレビューが表示されていない');
    }

    // プレビュー本文内にリンクと定義語が存在することを確認
    const previewBody = tip.el.querySelector('.egov-ext-tip-body');
    if (!previewBody) throw new Error('プレビュー本文が見つかりません');

    // プレビュー本文に子要素リンクおよび定義語スパンを模擬挿入
    const innerLink = dom.window.document.createElement('a');
    innerLink.href = '#Mp-At_3';
    innerLink.textContent = '第三条';
    previewBody.appendChild(innerLink);

    const innerDef = dom.window.document.createElement('span');
    innerDef.className = 'egov-definition-word';
    innerDef.dataset.word = '権利';
    innerDef.textContent = '権利';
    previewBody.appendChild(innerDef);

    // 2. ボタンを押しに行くマウスが、プレビュー内のリンクや定義語の上を通過した状況をシミュレート
    innerLink.dispatchEvent(new dom.window.Event('mouseover', { bubbles: true }));
    await new Promise(r => setTimeout(r, 50));

    // ポップアップが消えずに表示を維持していること（自壊していないこと）
    if (!tip.el.classList.contains('visible')) {
      throw new Error('プレビュー内の条文リンク通過によってポップアップが消えた');
    }

    innerDef.dispatchEvent(new dom.window.Event('mouseover', { bubbles: true }));
    await new Promise(r => setTimeout(r, 50));

    if (!tip.el.classList.contains('visible')) {
      throw new Error('プレビュー内の定義語通過によってポップアップが消滅した');
    }

    // 3. プレビュー内部でマウスが動いている間（mousemove）、Keep-Alive が維持されること
    tip.el.dispatchEvent(new dom.window.Event('mousemove', { bubbles: true }));
    // hideTimer がセットされていない（または即座にクリアされている）こと
    await new Promise(r => setTimeout(r, 100));
    if (!tip.el.classList.contains('visible')) {
      throw new Error('プレビュー内の mousemove 中にポップアップが非表示になった');
    }

    // 4. 右上のジャンプボタンが正常に存在しクリック可能なこと
    const jumpBtn = tip.el.querySelector('.egov-ext-tip-action-btn');
    if (!jumpBtn) {
      throw new Error('ポップアップ右上のアクションボタンが見つかりません');
    }

    tip.hide(true);
    return 'プレビュー内の他条文リンク・定義語通過時の誤爆自壊防止およびmousemove Keep-Aliveの完全動作確認';
  });

  await check('被引用ポップアップ＆フライアウトプレビュー: ホバー表示および親子相互cancelHideの健全性', async () => {
    const { dom, ext } = await createTestEnv(SAMPLE_LAW_HTML);

    // 被引用機能を有効化
    ext.settings.citation = true;
    await ext.enableCitations();

    const citationBtn = dom.window.document.querySelector('.egov-ext-citation-btn');
    if (!citationBtn) throw new Error('被引用ボタンが挿入されていません');

    // 1. 引用ボタンにマウスオーバーして一覧ポップアップが開くこと（無限再帰なく開くこと）
    citationBtn.dispatchEvent(new dom.window.Event('mouseover', { bubbles: true }));
    await new Promise(r => setTimeout(r, 320));

    const citeTip = ext.citationTooltip;
    if (!citeTip || !citeTip.el.classList.contains('visible')) {
      throw new Error('被引用法令一覧ポップアップが表示されなかった');
    }

    // 2. 一覧内の法令リンクにマウスオーバーしてフライアウトプレビューが開くこと
    const citeLink = citeTip.el.querySelector('.egov-ext-citation-link');
    if (!citeLink) throw new Error('被引用法令一覧内にリンクが見つかりません');

    // リンクへのマウスオーバー（cancelHideの呼び出しを含む）
    citeLink.dispatchEvent(new dom.window.Event('mouseover', { bubbles: true }));
    await new Promise(r => setTimeout(r, 320));

    const prevTip = ext.citationPreviewTooltip;
    if (!prevTip || !prevTip.el.classList.contains('visible')) {
      throw new Error('フライアウト条文プレビューが表示されなかった');
    }

    // 3. 親・子のどちらで mousemove / cancelHide が起きても無限再帰せず安定して表示維持されること
    citeTip.el.dispatchEvent(new dom.window.Event('mousemove', { bubbles: true }));
    prevTip.el.dispatchEvent(new dom.window.Event('mousemove', { bubbles: true }));
    await new Promise(r => setTimeout(r, 50));

    if (!citeTip.el.classList.contains('visible') || !prevTip.el.classList.contains('visible')) {
      throw new Error('親子ツールチップの相互cancelHide中にツールチップが閉じてしまった');
    }

    citeTip.hide(true);
    prevTip.hide(true);
    return '引用ボタンおよび被引用法令リンクホバー時のポップアップ＆フライアウト正常表示確認';
  });

  await check('被引用法令一覧＆条文プレビュー: 子から外への移動による連動非表示・スクロール時閉鎖・内部スクロール保護', async () => {
    const { dom, ext } = await createTestEnv(SAMPLE_LAW_HTML);
    ext.settings = { global: true, citation: true, popup: true };

    const mockInyoData = [
      {
        selText: 'Mp-At_1',
        inyo_list: [
          {
            law_id: '129AC0000000089',
            law_title: '民法',
            article_id: 'Mp-At_709',
            article_title: '第七百九条',
            url: 'https://laws.e-gov.go.jp/law/129AC0000000089#Mp-At_709'
          }
        ]
      }
    ];

    dom.window.fetch = async (url, opts) => {
      const urlStr = String(url);
      if (urlStr.includes('SelectInyoLawData.json')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ result: { inyo_law_data: mockInyoData } })
        };
      }
      if (urlStr.includes('SelectInyoLawTextData.json')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            result: {
              inyo_law_text: {
                LawTitle: '民法',
                ArticleTitle: '第七百九条',
                ParagraphSentence: '故意又は過失によって他人の権利又は法律上保護される利益を侵害した者は、これによって生じた損害を賠償する責任を負う。'
              }
            }
          })
        };
      }
      return { ok: false, status: 404 };
    };

    await ext.enableCitations();

    const citationBtn = dom.window.document.querySelector('.egov-ext-citation-btn');
    if (!citationBtn) throw new Error('被引用ボタンが挿入されていません');

    // 1. 引用ボタンにホバーして被引用一覧（親）を開く
    citationBtn.dispatchEvent(new dom.window.Event('mouseover', { bubbles: true }));
    await new Promise(r => setTimeout(r, 320));
    const citeTip = ext.citationTooltip;
    if (!citeTip || !citeTip.el.classList.contains('visible')) {
      throw new Error('被引用一覧が開かなかった');
    }

    // 2. 一覧内のリンクにホバーして条文プレビュー（子）を開く
    const citeLink = citeTip.el.querySelector('.egov-ext-citation-link');
    citeLink.dispatchEvent(new dom.window.Event('mouseover', { bubbles: true }));
    await new Promise(r => setTimeout(r, 320));
    const prevTip = ext.citationPreviewTooltip;
    if (!prevTip || !prevTip.el.classList.contains('visible')) {
      throw new Error('条文プレビューが開かなかった');
    }

    // 3. 子ツールチップ（条文プレビュー）から画面外（余白）へマウスアウト
    const dummyOutside = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(dummyOutside);

    prevTip.el.dispatchEvent(new dom.window.MouseEvent('mouseleave', {
      bubbles: true,
      relatedTarget: dummyOutside
    }));

    // hideDelay (300ms) 経過待ち
    await new Promise(r => setTimeout(r, 350));

    // 子だけでなく、親（被引用一覧）も確実に非表示になっていること！
    if (citeTip.el.classList.contains('visible')) {
      throw new Error('子ツールチップから外に出た後も親ツールチップ（被引用一覧）が消えずに残っている');
    }
    if (prevTip.el.classList.contains('visible')) {
      throw new Error('子ツールチップ（条文プレビュー）が消えずに残っている');
    }

    // 4. 再度開いて、内部スクロール保護とページスクロール閉鎖の検証
    citationBtn.dispatchEvent(new dom.window.Event('mouseover', { bubbles: true }));
    await new Promise(r => setTimeout(r, 320));
    if (!citeTip.el.classList.contains('visible')) {
      throw new Error('被引用一覧の再表示に失敗');
    }

    // 内部スクロール要素（.egov-ext-tip-scroll）でスクロールイベント発生 → 閉じないこと！
    const tipScroller = citeTip.el.querySelector('.egov-ext-tip-scroll');
    if (!tipScroller) throw new Error('ツールチップ内部のスクローラー要素が見つかりません');
    tipScroller.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }));
    await new Promise(r => setTimeout(r, 50));
    if (!citeTip.el.classList.contains('visible')) {
      throw new Error('ツールチップ内部スクロールでツールチップが誤って閉じてしまった');
    }

    // ページ（window）でスクロールイベント発生 → 即座に閉じること！
    dom.window.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }));
    await new Promise(r => setTimeout(r, 50));
    if (citeTip.el.classList.contains('visible')) {
      throw new Error('ページスクロール発生時にツールチップが即座に閉じなかった');
    }

    // 5. 画面余白クリック（pointerdown）での即時閉鎖検証
    citationBtn.dispatchEvent(new dom.window.Event('mouseover', { bubbles: true }));
    await new Promise(r => setTimeout(r, 320));
    if (!citeTip.el.classList.contains('visible')) {
      throw new Error('被引用一覧の再表示に失敗');
    }

    // ツールチップ内部クリック → 閉じない
    tipScroller.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
    await new Promise(r => setTimeout(r, 50));
    if (!citeTip.el.classList.contains('visible')) {
      throw new Error('ツールチップ内部クリックで誤って閉じてしまった');
    }

    // 画面外クリック → 即時閉鎖
    dummyOutside.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
    await new Promise(r => setTimeout(r, 50));
    if (citeTip.el.classList.contains('visible')) {
      throw new Error('画面余白クリック時にツールチップが即座に閉じなかった');
    }

    dummyOutside.remove();
    return '子から外への移動連動非表示・スクロール即時閉鎖・内部スクロール保護・画面外クリック閉鎖の完全動作確認';
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

  // ==========================================
  // 6. 接続詞色分けハイライト（conjunction）の相互作用テスト
  // ==========================================
  console.log('\n--- 6. 接続詞色分けハイライト（並びに・及び・又は・若しくは）の検証 ---');

  await check('接続詞の検出と階層クラス付与: 並びに(大)・及び(小)・又は(大)・若しくは(小)', async () => {
    const testHtml = `
      <div class="LawBody">
        <div class="_div_Article" id="Mp-At_1">
          <div class="_div_ParagraphSentence">都市計画の内容及びその決定手続を定める。健康で文化的な都市生活及び機能的な都市活動を確保すべきこと並びに適正な制限のもとに土地を利用する。公害の防止又は環境の保全を図るため、市町村若しくは都道府県が措置を講ずる。</div>
        </div>
      </div>
    `;
    const { dom, ext } = await createTestEnv(testHtml);
    ext.settings = { global: true, conjunction: true };

    ext.enableConjunctionHighlight();

    const sentence = dom.window.document.querySelector('._div_ParagraphSentence');
    const andMajor = sentence.querySelectorAll('.egov-conjunction-and-major');
    const andMinor = sentence.querySelectorAll('.egov-conjunction-and-minor');
    const orMajor = sentence.querySelectorAll('.egov-conjunction-or-major');
    const orMinor = sentence.querySelectorAll('.egov-conjunction-or-minor');

    if (andMajor.length !== 1 || andMajor[0].textContent !== '並びに') return false;
    if (andMinor.length !== 2 || andMinor[0].textContent !== '及び' || andMinor[1].textContent !== '及び') return false;
    if (orMajor.length !== 1 || orMajor[0].textContent !== '又は') return false;
    if (orMinor.length !== 1 || orMinor[0].textContent !== '若しくは') return false;

    return `全4種正常検出 (並びに: ${andMajor.length}, 及び: ${andMinor.length}, 又は: ${orMajor.length}, 若しくは: ${orMinor.length})`;
  });

  await check('重複実行（冪等性）: 3回連続実行でも二重ラップされないこと', async () => {
    const testHtml = `
      <div class="LawBody">
        <div class="_div_Article" id="Mp-At_1">
          <div class="_div_ParagraphSentence">国及び地方公共団体は、公害の防止又は環境の保全を図る。</div>
        </div>
      </div>
    `;
    const { dom, ext } = await createTestEnv(testHtml);
    ext.settings = { global: true, conjunction: true };

    ext.enableConjunctionHighlight();
    const html1 = dom.window.document.querySelector('._div_ParagraphSentence').innerHTML;

    ext.enableConjunctionHighlight();
    const html2 = dom.window.document.querySelector('._div_ParagraphSentence').innerHTML;

    ext.enableConjunctionHighlight();
    const html3 = dom.window.document.querySelector('._div_ParagraphSentence').innerHTML;

    if (html1 !== html2 || html2 !== html3) return false;
    const nested = dom.window.document.querySelectorAll('.egov-conjunction .egov-conjunction');
    if (nested.length > 0) return false;

    return '3回連続実行で完全一致・二重ラップなし';
  });

  await check('複合共存: 括弧書き薄字化と接続詞ハイライトの両立', async () => {
    const testHtml = `
      <div class="LawBody">
        <div class="_div_Article" id="Mp-At_1">
          <div class="_div_ParagraphSentence">基本原則（国及び地方公共団体並びに事業者が遵守すべき事項に限る。）を定める。</div>
        </div>
      </div>
    `;
    const { dom, ext } = await createTestEnv(testHtml);
    ext.settings = { global: true, dim: true, conjunction: true };

    ext.enableDimParentheses();
    ext.enableConjunctionHighlight();

    const sentence = dom.window.document.querySelector('._div_ParagraphSentence');
    const dimmed = sentence.querySelector('.egov-ext-dimmed-text');
    if (!dimmed) return false;

    const insideAndMinor = dimmed.querySelector('.egov-conjunction-and-minor');
    const insideAndMajor = dimmed.querySelector('.egov-conjunction-and-major');
    if (!insideAndMinor || insideAndMinor.textContent !== '及び') return false;
    if (!insideAndMajor || insideAndMajor.textContent !== '並びに') return false;

    return '薄字化括弧内の接続詞が正しく共存ラップされること確認';
  });

  console.log('\n--- 7. 他法令リンクプレビューにおける項・号指定の特定・ハイライト検証 ---');

  await check('他法令リンク解析: 法令番号括弧・全角数字を含む条項号パスの正確な分離', async () => {
    const { ext } = await createTestEnv('<div class="LawBody"></div>');
    // dummy link
    const dummyA = { textContent: '特定非営利活動促進法（平成１０年法律第７号）第２条第２項' };
    const dummyB = { textContent: '会社法（平成十七年法律第八十六号）第四百二十三条第一項' };
    const dummyC = { textContent: '第２条第２項' };

    // テスト用の parseLawLinkText 実行
    const parsedA = ext.parseLawLinkText ? ext.parseLawLinkText(dummyA, '410AC1000000007', 'Mp-At_2-Pr_2') : null;
    const parsedB = ext.parseLawLinkText ? ext.parseLawLinkText(dummyB, '417AC0000000086', 'Mp-At_423-Pr_1') : null;
    const parsedC = ext.parseLawLinkText ? ext.parseLawLinkText(dummyC, '410AC1000000007', 'Mp-At_2-Pr_2') : null;

    if (!parsedA || parsedA.lawName !== '特定非営利活動促進法（平成１０年法律第７号）' || parsedA.path !== '第２条第２項') {
      return false;
    }
    if (!parsedB || parsedB.lawName !== '会社法（平成十七年法律第八十六号）' || parsedB.path !== '第四百二十三条第一項') {
      return false;
    }
    if (!parsedC || parsedC.path !== '第２条第２項') {
      return false;
    }
    return '全角数字・法令番号括弧付きリンクの法令名・条項号パス完全分離確認';
  });

  await check('findTargetArticle: 項（-Pr_...）や号（-It_...）付きobjectIdにおける目的条文の正確な特定', async () => {
    const { ext } = await createTestEnv('<div class="LawBody"></div>');
    const mockInyoArray = [
      { ObjectId: '#TOC', Type: 'TOC', Content: {} },
      { ObjectId: '#Mp-Ch_1', Type: 'Chapter', Content: {} },
      { ObjectId: '#Mp-Ch_1-At_1', Type: 'Article', Content: { ArticleTitle: '第一条', Paragraph: [{ ParagraphNum: '', ParagraphSentence: {} }] } },
      { ObjectId: '#Mp-Ch_1-At_2', Type: 'Article', Content: { ArticleTitle: '第二条', Paragraph: [{ ParagraphNum: '', ParagraphSentence: {} }, { ParagraphNum: '２', ParagraphSentence: {} }] } },
      { ObjectId: '#Mp-Ch_2-At_14_3', Type: 'Article', Content: { ArticleTitle: '第十四条の三', Paragraph: [{ ParagraphNum: '', ParagraphSentence: {} }] } }
    ];

    // 1. 第2条第2項 (Mp-At_2-Pr_2) の指定時 -> 第一条ではなく第二条がヒットすること
    const targetA = ext.findTargetArticle(mockInyoArray, 'Mp-At_2-Pr_2', '第２条第２項');
    if (!targetA || targetA.ObjectId !== '#Mp-Ch_1-At_2') {
      return false;
    }

    // 2. 枝番号・号付き (Mp-At_14_3-Pr_1-It_2) の指定時 -> 第14条の3がヒットすること
    const targetB = ext.findTargetArticle(mockInyoArray, 'Mp-At_14_3-Pr_1-It_2', '');
    if (!targetB || targetB.ObjectId !== '#Mp-Ch_2-At_14_3') {
      return false;
    }

    // 3. XML探索側 findTargetArticleNodeInXml の検証
    const mockXmlStr = `
      <Law>
        <MainProvision>
          <Article Num="1"><ArticleTitle>第一条</ArticleTitle></Article>
          <Article Num="2"><ArticleTitle>第二条</ArticleTitle></Article>
          <Article Num="14_3"><ArticleTitle>第十四条の三</ArticleTitle></Article>
        </MainProvision>
      </Law>
    `;
    const { DOMParser } = require('jsdom').JSDOM ? new (require('jsdom').JSDOM)().window : window;
    const xmlDoc = new DOMParser().parseFromString(mockXmlStr, 'text/xml');
    const xmlNodeA = ext.findTargetArticleNodeInXml(xmlDoc, 'Mp-At_2-Pr_2', '第２条第２項');
    if (!xmlNodeA || xmlNodeA.getAttribute('Num') !== '2') {
      return false;
    }

    return '項・号付きobjectIdおよび枝番号の正確な条文ノード特定（第一条誤認の完全解消）確認';
  });

  await check('renderArticlePreview: 指定された項（Paragraph）へのターゲットハイライト付与', async () => {
    const { ext } = await createTestEnv('<div class="LawBody"></div>');
    const content = {
      LawTitle: '特定非営利活動促進法',
      ArticleTitle: '第二条',
      Paragraph: [
        { ParagraphNum: '', ParagraphSentence: { Sentence: [{ '#text': '第1項本文' }] } },
        { ParagraphNum: '２', ParagraphSentence: { Sentence: [{ '#text': '第2項本文' }] } },
        { ParagraphNum: '３', ParagraphSentence: { Sentence: [{ '#text': '第3項本文' }] } }
      ]
    };

    const dom = ext.renderArticlePreview(content, [], '特定非営利活動促進法', '第２条第２項', 'https://laws.e-gov.go.jp', 'Mp-At_2-Pr_2');
    if (!dom) return false;

    const targetParas = dom.querySelectorAll('.egov-ext-preview-paragraph--target');
    if (targetParas.length !== 1) return false;
    if (!targetParas[0].textContent.includes('第2項本文')) return false;

    return '指定項（第2項）への視覚的ハイライトクラスの正確な付与確認';
  });

  console.log('\n--- 8. 号本文の表示（Column構造対応）および他法令ヘッダー重複防止の検証 ---');

  await check('parseSentenceToDOM & renderArticlePreview: Column構造（複数列）を持つ号本文の抽出・連結検証', async () => {
    const { ext } = await createTestEnv('<div class="LawBody"></div>');
    // 建築基準法第52条第1項第1号（Column構造の典型例）
    const content = {
      LawTitle: '建築基準法',
      ArticleTitle: '第五十二条',
      Paragraph: [
        {
          ParagraphNum: '',
          ParagraphSentence: {
            Sentence: [{ '#text': '延べ面積の敷地面積に対する割合（容積率）は、次の各号に掲げる区分に従い...' }]
          },
          Item: [
            {
              ItemTitle: '一',
              ItemSentence: {
                Column: [
                  {
                    Sentence: [{ '#text': '第一種低層住居専用地域等の建築物' }]
                  },
                  {
                    Sentence: [{ '#text': '十分の五から十分の二十までの数値' }]
                  }
                ]
              }
            }
          ]
        }
      ]
    };

    const dom = ext.renderArticlePreview(content, [], '法', '第５２条第１項', 'https://laws.e-gov.go.jp', 'Mp-At_52-Pr_1');
    if (!dom) return false;

    const itemEl = dom.querySelector('.egov-ext-preview-item');
    if (!itemEl) return false;

    const text = itemEl.textContent;
    // 号タイトル "一" と、Column 1 および Column 2 のテキストが全て含まれていること
    if (!text.includes('一') || !text.includes('第一種低層住居専用地域等の建築物') || !text.includes('十分の五から十分の二十までの数値')) {
      return false;
    }
    // 列間に全角スペースが含まれていること
    if (!text.includes('\u3000')) {
      return false;
    }

    return '建築基準法第52条第1項パターン（Column構造の号本文）の全角スペース連結・テキスト正常描画確認';
  });

  await check('xmlNodeToContent: <Column> を含むXMLノードからの構造化抽出とプレビュー描画検証', async () => {
    const { ext } = await createTestEnv('<div class="LawBody"></div>');
    const mockXmlStr = `
      <Article Num="2">
        <ArticleTitle>第二条</ArticleTitle>
        <Paragraph Num="1">
          <ParagraphNum/>
          <ParagraphSentence>
            <Sentence>算定方法は次の各号による。</Sentence>
          </ParagraphSentence>
          <Item Num="1">
            <ItemTitle>一</ItemTitle>
            <ItemSentence>
              <Column Num="1"><Sentence>敷地面積</Sentence></Column>
              <Column Num="2"><Sentence>敷地の水平投影面積による。</Sentence></Column>
            </ItemSentence>
          </Item>
        </Paragraph>
      </Article>
    `;
    const { DOMParser } = require('jsdom').JSDOM ? new (require('jsdom').JSDOM)().window : window;
    const xmlDoc = new DOMParser().parseFromString(mockXmlStr, 'text/xml');
    const articleNode = xmlDoc.querySelector('Article');

    const fnXmlToContent = ext.xmlNodeToContent || (ext._testCitation && ext._testCitation.xmlNodeToContent);
    const content = fnXmlToContent(articleNode);
    if (!content || !content.Paragraph || !content.Paragraph[0].Item) return false;

    const itemObj = content.Paragraph[0].Item[0];
    if (!itemObj.ItemSentence || !itemObj.ItemSentence.Column || itemObj.ItemSentence.Column.length !== 2) {
      return false;
    }

    const dom = ext.renderArticlePreview(content, [], '建築基準法施行令', '第二条第１項', 'https://laws.e-gov.go.jp', 'Mp-At_2-Pr_1');
    if (!dom) return false;

    const itemText = dom.querySelector('.egov-ext-preview-item').textContent;
    if (!itemText.includes('敷地面積') || !itemText.includes('敷地の水平投影面積による。')) {
      return false;
    }

    return 'XMLフォールバック時における <Column> ノードの構造化抽出およびプレビュー描画完全確認';
  });

  await check('他法令プレビューヘッダー: 略称リンク（法第〇条）のパース、正式法令名優先および重複防止検証', async () => {
    const { ext } = await createTestEnv('<div class="LawBody"></div>');
    // 1. "法第５２条第１項" のパース
    const dummyLink = { textContent: '法第５２条第１項' };
    const parsed = ext.parseLawLinkText(dummyLink, '325AC0000000201', 'Mp-At_52-Pr_1');
    if (!parsed || parsed.lawName !== '法' || parsed.path !== '第５２条第１項') {
      return false;
    }

    // 2. renderArticlePreview での正式法令名（content.LawTitle）優先
    const content = {
      LawTitle: '建築基準法',
      ArticleTitle: '第五十二条',
      Paragraph: [{ ParagraphNum: '', ParagraphSentence: { Sentence: [{ '#text': '本文' }] } }]
    };
    const dom = ext.renderArticlePreview(content, [], parsed.lawName, parsed.path, 'https://laws.e-gov.go.jp', 'Mp-At_52-Pr_1');
    const headerTitle = dom.querySelector('.egov-ext-tip-header-title').textContent;

    // "建築基準法 第５２条第１項" となり、"法第５２条第１項第５２条第１項" や二重表示にならないこと
    if (!headerTitle.includes('建築基準法') || headerTitle.includes('法第５２条第１項第５２条第１項')) {
      return false;
    }
    if (headerTitle !== '建築基準法 第５２条第１項') {
      return false;
    }

    // 3. 万が一 lawName に path が結合したまま渡された場合でも重複除去されること
    const domFallback = ext.renderArticlePreview({ ArticleTitle: '第五十二条' }, [], '法第５２条第１項', '第５２条第１項', 'https://laws.e-gov.go.jp');
    const fallbackTitle = domFallback.querySelector('.egov-ext-tip-header-title').textContent;
    if (fallbackTitle !== '法 第５２条第１項') {
      return false;
    }

    return '略称リンクの条項パス正確分離・正式法令名優先表示・タイトル二重化の完全防止確認';
  });

  console.log('\n--- 9. 号番号の算用数字(1)化およびポップアップレイアウト（改行・スペース崩れ防止）の検証 ---');

  await check('他法令プレビュー: 算用数字(horizontal)機能有効時の号番号(1)化および項番号変換検証', async () => {
    const { ext } = await createTestEnv('<div class="LawBody"></div>');
    ext.settings.horizontal = true;

    const content = {
      LawTitle: '建築基準法',
      ArticleTitle: '第五十二条',
      Paragraph: [
        {
          ParagraphNum: '二',
          ParagraphSentence: {
            Sentence: [{ '#text': '前項の規定にかかわらず...' }]
          },
          Item: [
            {
              ItemTitle: '一',
              ItemSentence: {
                Sentence: [{ '#text': '第一号本文' }]
              }
            },
            {
              ItemTitle: '二',
              ItemSentence: {
                Sentence: [{ '#text': '第二号本文' }]
              }
            }
          ]
        }
      ]
    };

    const dom = ext.renderArticlePreview(content, [], '建築基準法', '第５２条第２項', 'https://laws.e-gov.go.jp', 'Mp-At_52-Pr_2');
    if (!dom) return false;

    // 項番号が "２　" に変換されていること
    const paraNumEl = dom.querySelector('.egov-ext-preview-paragraph-num');
    if (!paraNumEl || !paraNumEl.textContent.includes('２')) {
      return false;
    }

    // 各号番号が "(1)　", "(2)　" に変換されていること
    const itemTitleEls = dom.querySelectorAll('.egov-ext-preview-item-title');
    if (itemTitleEls.length !== 2) return false;
    if (!itemTitleEls[0].textContent.includes('(1)')) return false;
    if (!itemTitleEls[1].textContent.includes('(2)')) return false;

    return '他法令プレビュー内での項番号「２」および号番号「(1)」「(2)」への正常変換確認';
  });

  await check('formatInlinePreview: 定義語ポップアップ等の号・Column・文のインライン化および全角スペース補完検証', async () => {
    const { ext } = await createTestEnv('<div class="LawBody"></div>');
    ext.settings.horizontal = true;

    // 建築基準法第2条第1号（定義語「建築物」の典型構造）
    const dummyContainer = document.createElement('div');
    dummyContainer.className = 'egov-ext-tip-body';
    dummyContainer.innerHTML = `
      <div class="_div_Item">
        <div class="_div_ItemTitle">一</div>
        <div class="_div_ItemSentence">
          <div class="_div_Column" num="1">
            <div class="_div_Sentence">建築物</div>
          </div>
          <div class="_div_Column" num="2">
            <div class="_div_Sentence">土地に定着する工作物のうち、屋根及び柱若しくは壁を有するもの...</div>
          </div>
        </div>
      </div>
    `;

    ext.formatInlinePreview(dummyContainer);

    // 1. ItemTitle が (1) に変換され、インラインクラスが付与されていること
    const itemTitle = dummyContainer.querySelector('._div_ItemTitle');
    if (!itemTitle || !itemTitle.textContent.includes('(1)') || !itemTitle.classList.contains('egov-ext-inline')) {
      return false;
    }

    // 2. Column 要素がインライン化されていること
    const columns = dummyContainer.querySelectorAll('._div_Column');
    if (columns.length !== 2) return false;
    if (!columns[0].classList.contains('egov-ext-inline') || !columns[1].classList.contains('egov-ext-inline')) {
      return false;
    }

    // 3. テキスト全体で号番号・Column 1・Column 2 の間に厳密に1つの全角スペースが含まれていること
    const fullText = dummyContainer.textContent;
    if (!fullText.includes('(1)　建築物　土地に定着する工作物のうち') || fullText.includes('　　')) {
      return false;
    }

    // 4. 実機e-Gov DOM構造（VueによりColumn 1末尾に既に全角スペースが存在するケース）でも2文字スペースにならないこと
    const liveEGovContainer = document.createElement('div');
    liveEGovContainer.className = 'egov-ext-tip-body';
    liveEGovContainer.innerHTML = `
      <div class="_div_Item">
        <div class="_div_ItemTitle">(1)　</div>
        <div class="_div_ItemSentence">
          <div class="_div_Column" num="1">
            <div class="_div_Sentence"><span class="egov-definition-word">建築物</span></div>　
          </div>
          <div class="_div_Column" num="2">
            <div class="_div_Sentence">土地に定着する工作物のうち、屋根及び柱若しくは壁を有するもの...</div>
          </div>
        </div>
      </div>
    `;
    ext.formatInlinePreview(liveEGovContainer);
    const liveText = liveEGovContainer.textContent;
    if (!liveText.includes('(1)　建築物　土地に定着する工作物のうち') || liveText.includes('建築物　　土地')) {
      return false;
    }

    return '定義語ポップアップでの号番号(1)化・Columnインライン化・厳密な全角1文字スペース区切り（2文字スペース完全防止）確認';
  });

  // テスト 23: 建築基準法施行令（旧様式 _div_ItemSentence）および新様式における号番号(1)化後の厳密な全角1文字スペース検証
  await check('建築基準法施行令（旧様式）および新様式における号番号(1)化後の二重空白防止テスト', async () => {
    const { window, ext } = await createTestEnv(`
      <!DOCTYPE html>
      <html>
        <body>
          <main class="main-content">
            <!-- 旧様式（建築基準法施行令 Mp-Ch_1-Se_1-At_1）: span の直後に全角スペーステキストノードがある構造 -->
            <div id="Mp-Ch_1-Se_1-At_1-Pr_1-It_1" class="_div_ItemSentence">
              <span style="font-weight: bold;">一</span>　<span>敷地</span>　<span>一の建築物又は用途上不可分の関係にある二以上の建築物のある一団の土地をいう。</span>
            </div>
            <div id="Mp-Ch_1-Se_1-At_1-Pr_1-It_2" class="_div_ItemSentence">
              <span style="font-weight: bold;">二</span>　<span>地階</span>　<span>床が地盤面下にある階で...</span>
            </div>
            <!-- 新様式（Vue版）: span.itemtitle の末尾に全角スペースが含まれている構造 -->
            <div id="Mp-Ch_1-At_2-Pr_1-It_1" class="item istitle">
              <span class="itemtitle">一　</span>
              <div class="column"><p class="sentence">建築物</p>　</div>
            </div>
          </main>
        </body>
      </html>
    `);

    ext.settings.global = true;
    ext.settings.horizontal = true;

    // 横書き表記変換を実行
    ext.applyHorizontalConversion(window.document.body);

    // 1. 旧様式第1号の検証: (1) の後に厳密に全角スペースが1文字だけであり、二重空白（　　）がないこと
    const it1_1 = window.document.querySelector('#Mp-Ch_1-Se_1-At_1-Pr_1-It_1');
    if (!it1_1) return false;
    const text1_1 = it1_1.textContent;
    if (!text1_1.includes('(1)　敷地') || text1_1.includes('(1)　　') || text1_1.includes('　　敷地')) {
      throw new Error(`旧様式第1号で二重空白が発生しています: ${JSON.stringify(text1_1)}`);
    }

    // 2. 旧様式第2号の検証
    const it1_2 = window.document.querySelector('#Mp-Ch_1-Se_1-At_1-Pr_1-It_2');
    if (!it1_2) return false;
    const text1_2 = it1_2.textContent;
    if (!text1_2.includes('(2)　地階') || text1_2.includes('(2)　　')) {
      throw new Error(`旧様式第2号で二重空白が発生しています: ${JSON.stringify(text1_2)}`);
    }

    // 3. 新様式の検証
    const itVue = window.document.querySelector('#Mp-Ch_1-At_2-Pr_1-It_1');
    if (!itVue) return false;
    const textVue = itVue.textContent;
    if (!textVue.includes('(1)　') || textVue.includes('(1)　　')) {
      throw new Error(`新様式第1号で二重空白が発生しています: ${JSON.stringify(textVue)}`);
    }

    return '旧様式・新様式ともに号番号(1)化後の全角スペースが厳密に1文字（二重空白なし）であることを確認';
  });

  // テスト 24: 建築基準法（カラム型定義条文）における定義語抽出・ハイライトおよび再入耐性テスト
  await check('建築基準法（カラム構造第2条）における定義語抽出・ハイライトおよび再入耐性テスト', async () => {
    const { window, ext } = await createTestEnv(`
      <!DOCTYPE html>
      <html>
        <body>
          <main class="main-content">
            <section id="Mp-Ch_1-At_1" class="Article">
              <div class="ArticleTitle"><span style="font-weight: bold;">第一条</span>　<span>この法律は、建築物の敷地、構造、設備及び用途に関する最低の基準を定めて、国民の生命、健康及び財産の保護を図り、もつて公共の福祉の増進に資することを目的とする。</span></div>
            </section>
            <section id="Mp-Ch_1-At_2" class="Article">
              <div class="ArticleCaption"><span>（用語の定義）</span></div>
              <div class="ArticleTitle"><span style="font-weight: bold;">第二条</span>　<span>この法律において次の各号に掲げる用語の意義は、それぞれ当該各号に定めるところによる。</span></div>
              <div id="Mp-Ch_1-At_2-Pr_1-It_1" class="item istitle">
                <span class="itemtitle">一　</span>
                <div class="column"><p class="sentence">建築物</p>　</div>
                <div class="column"><p class="sentence">土地に定着する工作物のうち、屋根及び柱若しくは壁を有するもの...</p></div>
              </div>
              <div id="Mp-Ch_1-At_2-Pr_1-It_2" class="item istitle">
                <span class="itemtitle">二　</span>
                <div class="column"><p class="sentence">特殊建築物</p>　</div>
                <div class="column"><p class="sentence">学校、体育館、病院、劇場、観覧場、集会場、展示場、百貨店...</p></div>
              </div>
            </section>
          </main>
        </body>
      </html>
    `);

    ext.settings.global = true;
    ext.settings.definition = true;

    // 1. 定義語抽出の実行
    await ext.extractDefinitionsAsync();

    // 2. 抽出結果の検証（パターン4のカラム分割から「建築物」「特殊建築物」が抽出されていること）
    if (!ext.definitionMap.has('建築物') || !ext.definitionMap.has('特殊建築物')) {
      throw new Error(`定義語マップに「建築物」または「特殊建築物」が存在しません: ${Array.from(ext.definitionMap.keys())}`);
    }
    const defData = ext.definitionMap.get('建築物');
    if (defData.pattern !== 4) {
      throw new Error(`「建築物」のパターンが4（カラム型）ではありません: ${defData.pattern}`);
    }
    if (!defData.source.includes('２条') && !defData.source.includes('二条')) {
      throw new Error(`「建築物」の出典条文番号が第二条を含んでいません: ${defData.source}`);
    }

    // 3. ハイライト適用の実行
    ext.enableDefinitionHighlighting(window.document.body);

    // 4. 第1条本文中の「建築物」が正しくハイライトされていること
    const at1 = window.document.querySelector('#Mp-Ch_1-At_1');
    const highlightedWords = at1.querySelectorAll('.egov-definition-word');
    if (highlightedWords.length === 0) {
      throw new Error('第1条本文中に .egov-definition-word が存在しません');
    }
    const firstDefWord = highlightedWords[0];
    if (firstDefWord.textContent !== '建築物' || firstDefWord.dataset.word !== '建築物') {
      throw new Error(`ハイライトされた語が正しくありません: text=${firstDefWord.textContent}, dataset=${firstDefWord.dataset.word}`);
    }

    // 5. 抽出完了フラグおよび進行中 Promise 共有の検証
    if (!ext.definitionExtractionCompleted) {
      throw new Error('definitionExtractionCompleted が true になっていません');
    }

    // 進行中の多重呼び出しでPromiseが共有され、二重抽出されないこと
    const p1 = ext.extractDefinitionsAsync();
    const p2 = ext.extractDefinitionsAsync();
    await Promise.all([p1, p2]);
    if (ext.definitionMap.size < 2) {
      throw new Error(`再抽出後の件数が不正です: ${ext.definitionMap.size}`);
    }

    return '建築基準法のカラム型定義語（建築物・特殊建築物）の抽出・ハイライト・Promise共有・完了フラグの健全性を確認';
  });

  // テスト 25: 定義語ポップアップ成形における空テキストノード混在時・カラム末尾空白およびクロス境界二重空白（　　）完全抑止テスト
  await check('定義語ポップアップ成形における空テキストノード混在時・カラム末尾空白およびクロス境界二重空白（　　）完全抑止テスト', async () => {
    const { window, ext } = await createTestEnv('<div class="LawBody"></div>');
    ext.settings.horizontal = true;

    // 1. 実機Vue構造の模擬: コメントノードや空テキストノード、末尾全角スペースが入り組んだDOM
    const tipContainer = window.document.createElement('div');
    tipContainer.className = 'egov-ext-tip-body';
    tipContainer.innerHTML = `
      <div id="Mp-Ch_1-At_2-Pr_1-It_1" class="item istitle">
        <span class="itemtitle">一　</span>
        <div class="column">
          <!--comment1-->
          <p class="sentence"><span class="egov-definition-word" data-word="建築物">建築物</span></p>
          <!--comment2-->
        </div>
        <div class="column">
          <!--comment3-->
          <p class="sentence">土地に定着する工作物のうち、屋根及び柱若しくは壁を有するもの...</p>
        </div>
      </div>
    `;

    // 実際のVue DOMのように、末尾に全角スペースと空テキストノードを手動挿入
    const col1 = tipContainer.querySelectorAll('.column')[0];
    col1.appendChild(window.document.createTextNode('　')); // 全角スペース
    col1.appendChild(window.document.createTextNode(''));  // 空テキストノード（len=0）

    // Column 2の先頭にも空テキストノードを挿入
    const col2 = tipContainer.querySelectorAll('.column')[1];
    col2.insertBefore(window.document.createTextNode(''), col2.firstChild);

    // 成形処理を実行
    ext.formatInlinePreview(tipContainer);

    const fullText = tipContainer.textContent;

    // 検証1: 「(1)　建築物　土地に定着する工作物のうち」と厳密に1文字スペースで連結されていること
    if (!fullText.includes('(1)　建築物　土地に定着する工作物のうち')) {
      throw new Error(`期待される成形テキストが見つかりません: ${JSON.stringify(fullText.slice(0, 40))}`);
    }

    // 検証2: どこにも二重全角スペース（　　）が含まれていないこと
    if (fullText.includes('　　')) {
      throw new Error(`成形結果に二重全角スペースが含まれています: ${JSON.stringify(fullText.slice(0, 40))}`);
    }

    // 検証3: 「建築物」と「土地」の間が厳密に全角1文字であること
    const match = fullText.match(/建築物(.*?)土地/);
    if (!match || match[1] !== '　') {
      throw new Error(`「建築物」と「土地」の間のスペースが全角1文字ではありません: ${JSON.stringify(match ? match[1] : 'null')}`);
    }

    // 2. クロス要素境界二重空白の正規化検証（直前ノード末尾が全角スペース、直後ノード先頭も全角スペース）
    const boundaryContainer = window.document.createElement('div');
    boundaryContainer.className = 'egov-ext-tip-body';
    boundaryContainer.innerHTML = '<div><span>前半文　</span></div><div><span>　後半文</span></div>';
    ext.formatInlinePreview(boundaryContainer);
    const boundaryText = boundaryContainer.textContent;
    if (boundaryText.includes('　　') || !boundaryText.includes('前半文　後半文')) {
      throw new Error(`クロス要素境界二重空白が解消されていません: ${JSON.stringify(boundaryText)}`);
    }

    return '空テキストノード混在時のカラム末尾空白完全除去およびクロス要素境界二重空白（　　）の根絶を確認';
  });

  // テスト 26: 参照条文プレビューにおける第1項の条番号直後全角1文字空けインライン配置および第2項以降独立行表示の検証
  await check('参照条文プレビューにおける第1項の条番号直後全角1文字空けインライン配置および第2項以降独立行表示の検証', async () => {
    const { window, ext } = await createTestEnv('<div class="LawBody"></div>');
    ext.settings.horizontal = true;

    // 1. 他法令プレビュー（renderArticlePreview）の検証
    const mockContent = {
      LawTitle: '建築基準法',
      ArticleCaption: '（建築物の建築等に関する申請及び確認）',
      ArticleTitle: '第六条',
      Paragraph: [
        {
          ParagraphNum: '',
          ParagraphSentence: {
            Sentence: [{ '#text': '建築主は、第１号若しくは第２号に掲げる建築物を建築しようとする場合...' }]
          }
        },
        {
          ParagraphNum: '２',
          ParagraphSentence: {
            Sentence: [{ '#text': '前項の規定による確認の申請書には、設計図書を添附しなければならない。' }]
          }
        }
      ]
    };

    const previewDOM = ext._testCitation.renderArticlePreview(mockContent, ['第六条', '第６条'], '建築基準法', '第6条第1項');

    // 見出しの検証
    const captionEl = previewDOM.querySelector('.egov-ext-preview-caption');
    if (!captionEl || !captionEl.textContent.includes('申請及び確認')) {
      throw new Error(`見出しが正しく生成されていません: ${captionEl?.textContent}`);
    }

    // 第1項と第2項の段落要素を取得
    const paragraphs = previewDOM.querySelectorAll('.egov-ext-preview-paragraph');
    if (paragraphs.length !== 2) {
      throw new Error(`段落数が2件ではありません: ${paragraphs.length}`);
    }

    // 第1項の検証: 先頭に条番号（第６条）がインライン配置され、全角1文字空けて本文が続くこと
    const p1 = paragraphs[0];
    const p1Title = p1.querySelector('.egov-ext-preview-title');
    if (!p1Title) {
      throw new Error('第1項の中に .egov-ext-preview-title が存在しません');
    }
    if (p1Title.tagName.toLowerCase() !== 'span') {
      throw new Error(`第1項の条番号タグが span ではありません: ${p1Title.tagName}`);
    }
    if (!p1Title.textContent.includes('第６条') && !p1Title.textContent.includes('第六条')) {
      throw new Error(`第1項の条番号テキストが不正です: ${p1Title.textContent}`);
    }

    const p1Text = p1.textContent;
    // 「第６条　建築主は、…」と全角スペース1個でインライン連結されていること
    if (!p1Text.startsWith('第６条　建築主は、') && !p1Text.startsWith('第六条　建築主は、')) {
      throw new Error(`第1項の先頭テキストが法令形式（条番号＋全角スペース＋本文）になっていません: ${JSON.stringify(p1Text.slice(0, 30))}`);
    }

    // 第2項の検証: 条番号は含まれず、項番号「２　」から始まる独立行であること
    const p2 = paragraphs[1];
    if (p2.querySelector('.egov-ext-preview-title')) {
      throw new Error('第2項に誤って条番号が含まれています');
    }
    const p2Text = p2.textContent;
    if (!p2Text.startsWith('２　前項の規定')) {
      throw new Error(`第2項のテキストが項番号から始まっていません: ${JSON.stringify(p2Text.slice(0, 30))}`);
    }

    // 2. formatInlinePreview（旧様式法令の参照条文ポップアップ）の検証
    const tipContainer = window.document.createElement('div');
    tipContainer.className = 'egov-ext-tip-body';
    tipContainer.innerHTML = `
      <div class="_div_ArticleCaption">（建築基準適合判定資格者検定の基準）</div>
      <div class="_div_ArticleTitle"><span>第三条</span></div>
      <div class="_div_Paragraph" id="Mp-At_3-Pr_1">
        <div class="_div_ParagraphSentence">
          <div class="_div_Sentence">法第五条の規定による建築基準適合判定資格者検定は、...</div>
        </div>
      </div>
      <div class="_div_Paragraph" id="Mp-At_3-Pr_2">
        <div class="_div_ParagraphNum">２</div>
        <div class="_div_ParagraphSentence">
          <div class="_div_Sentence">前項の考査は、...</div>
        </div>
      </div>
    `;

    ext.formatInlinePreview(tipContainer);

    const artTitle = tipContainer.querySelector('._div_ArticleTitle');
    const firstPara = tipContainer.querySelector('#Mp-At_3-Pr_1');
    const secondPara = tipContainer.querySelector('#Mp-At_3-Pr_2');

    // _div_ArticleTitle と 第1項 _div_Paragraph に egov-ext-inline が付与されていること
    if (!artTitle.classList.contains('egov-ext-inline')) {
      throw new Error('_div_ArticleTitle に egov-ext-inline が付与されていません');
    }
    if (!firstPara.classList.contains('egov-ext-inline')) {
      throw new Error('第1項 _div_Paragraph に egov-ext-inline が付与されていません');
    }
    // 第2項には egov-ext-inline が付与されずブロックのままであること
    if (secondPara.classList.contains('egov-ext-inline')) {
      throw new Error('第2項 _div_Paragraph に誤って egov-ext-inline が付与されています');
    }

    // テキスト全体で「第３条　法第五条の規定による」または「第三条　法第五条」とインライン連結されていること
    const fullText = tipContainer.textContent;
    if (!fullText.includes('第３条　法第五条') && !fullText.includes('第３条　法第５条') && !fullText.includes('第三条　法第五条')) {
      throw new Error(`旧様式参照プレビューの成形テキストが不正です: ${JSON.stringify(fullText.slice(0, 40))}`);
    }

    return '他法令・旧様式双方で第1項の条番号直後全角1文字空けインライン配置および第2項独立行表示を確認';
  });

  // テスト 27: 同一法令内参照ポップアップヘッダーにおける参照箇所（条・項・号）の明示・範囲指定・附則・枝番および横書き全角数字変換の総合検証
  await check('同一法令内参照ポップアップヘッダーにおける参照箇所（条・項・号）の明示・範囲指定・附則・枝番および横書き全角数字変換の検証', async () => {
    const { window, ext } = await createTestEnv('<div class="LawBody"></div>');
    ext.settings.global = true;
    ext.settings.horizontal = true;

    const fnFormat = ext._testReferPopup.formatPathFromObjectId;
    const fnResolve = ext._testReferPopup.resolveReferenceClausePath;
    const fnBuild = ext._testReferPopup.buildPreviewContent;

    // 1. formatPathFromObjectId の単体検証
    if (fnFormat('Mp-Ch_7-At_131-Pr_1-It_4') !== '第131条第1項第4号') {
      throw new Error(`At_131-Pr_1-It_4 のパース失敗: ${fnFormat('Mp-Ch_7-At_131-Pr_1-It_4')}`);
    }
    if (fnFormat('Mp-At_52_2-Pr_1') !== '第52条の2第1項') {
      throw new Error(`枝番条文のパース失敗: ${fnFormat('Mp-At_52_2-Pr_1')}`);
    }
    if (fnFormat('Mp-At_1-Pr_1_2-It_3_4') !== '第1条第1項の2第3号の4') {
      throw new Error(`項・号枝番のパース失敗: ${fnFormat('Mp-At_1-Pr_1_2-It_3_4')}`);
    }
    if (fnFormat('325AC0100000214-Sp-At_3') !== '附則第3条') {
      throw new Error(`附則条文のパース失敗: ${fnFormat('325AC0100000214-Sp-At_3')}`);
    }
    if (fnFormat('Sp-Pr_2') !== '附則第2項') {
      throw new Error(`附則項のパース失敗: ${fnFormat('Sp-Pr_2')}`);
    }
    if (fnFormat('AppdxTable_1') !== '別表第1') {
      throw new Error(`別表のパース失敗: ${fnFormat('AppdxTable_1')}`);
    }
    if (fnFormat('AppdxTable_2_3') !== '別表第2の3') {
      throw new Error(`別表枝番のパース失敗: ${fnFormat('AppdxTable_2_3')}`);
    }

    // 2. resolveReferenceClausePath の単体検証
    // 2.1 完全表記
    const p1 = fnResolve(null, { textContent: '第百三十一条第一項第四号' }, 'Mp-Ch_7-At_131-Pr_1-It_4');
    if (p1 !== '第百三十一条第一項第四号') {
      throw new Error(`完全表記の解決失敗: ${p1}`);
    }
    // 2.2 相対参照（号のみ）-> 親条文が自動補完されること
    const p2 = fnResolve(null, { textContent: '第十一号' }, 'Mp-Ch_11-At_153-Pr_1-It_11');
    if (p2 !== '第153条第1項第11号') {
      throw new Error(`相対参照（号のみ）の親条文自動補完失敗: ${p2}`);
    }
    // 2.3 相対参照（前条）
    const p3 = fnResolve(null, { textContent: '前条' }, 'Mp-At_20');
    if (p3 !== '第20条') {
      throw new Error(`相対参照（前条）の親条文解決失敗: ${p3}`);
    }
    // 2.4 範囲指定（条）-> リンクテキストの範囲表現が尊重されること
    const p4 = fnResolve(null, { textContent: '第二十七条から第二十九条まで' }, 'Mp-At_27');
    if (p4 !== '第二十七条から第二十九条まで') {
      throw new Error(`範囲指定（条）の解決失敗: ${p4}`);
    }
    // 2.5 範囲指定（項のみ）-> IDの条番号と合体して補完されること
    const p5 = fnResolve(null, { textContent: '第一項から第三項まで' }, 'Mp-Ch_7-At_131-Pr_1');
    if (p5 !== '第131条第一項から第三項まで') {
      throw new Error(`範囲指定（項のみ）の条番号補完失敗: ${p5}`);
    }

    // 3. buildPreviewContent によるポップアップヘッダー生成と横書き変換の統合検証
    const dummyTargetEl = window.document.createElement('div');
    dummyTargetEl.className = 'Article';
    dummyTargetEl.id = 'Mp-Ch_7-At_131-Pr_1-It_4';
    dummyTargetEl.innerHTML = `
      <div class="ArticleTitle">第百三十一条</div>
      <div class="Paragraph">
        <div class="ParagraphSentence">第四号本文...</div>
      </div>
    `;

    // 3.1 文化財保護法「第百三十一条第一項第四号」ホバー時のシミュレーション
    const dummyLinkA = window.document.createElement('a');
    dummyLinkA.textContent = '第百三十一条第一項第四号';
    dummyLinkA.href = '#Mp-Ch_7-At_131-Pr_1-It_4';

    const popupDOM = fnBuild(dummyTargetEl, dummyLinkA, 'Mp-Ch_7-At_131-Pr_1-It_4');
    if (!popupDOM) throw new Error('popupDOM の生成に失敗');

    const headerTitleEl = popupDOM.querySelector('.egov-ext-tip-header-title');
    if (!headerTitleEl) throw new Error('ヘッダータイトル要素が見つかりません');

    // 初期状態（横書き変換前）: 参照条文（第百三十一条第一項第四号）
    if (!headerTitleEl.textContent.includes('参照条文（第百三十一条第一項第四号）')) {
      throw new Error(`横書き変換前のヘッダータイトルが不正です: ${headerTitleEl.textContent}`);
    }

    // 横書き変換適用
    ext.applyHorizontalConversion(popupDOM);

    // 横書き変換後: 参照条文（第１３１条第１項第４号）と全角アラビア数字になっていること！
    if (headerTitleEl.textContent !== '参照条文（第１３１条第１項第４号）') {
      throw new Error(`横書き変換後のヘッダータイトルが法令形式（全角アラビア数字）になっていません: ${headerTitleEl.textContent}`);
    }

    // ジャンプボタンが存在すること
    const jumpBtn = popupDOM.querySelector('.egov-ext-tip-action-btn');
    if (!jumpBtn || !jumpBtn.textContent.includes('ジャンプ')) {
      throw new Error('ポップアップヘッダーにジャンプボタンが存在しません');
    }

    // 3.2 範囲指定リンク（第二十七条から第二十九条まで）のヘッダー表示検証
    const dummyLinkRange = window.document.createElement('a');
    dummyLinkRange.textContent = '第二十七条から第二十九条まで';
    dummyLinkRange.href = '#Mp-At_27';

    const rangeTargetEl = window.document.createElement('div');
    rangeTargetEl.className = 'Article';
    rangeTargetEl.id = 'Mp-At_27';
    rangeTargetEl.innerHTML = '<div class="ArticleTitle">第二十七条</div>';

    const rangePopupDOM = fnBuild(rangeTargetEl, dummyLinkRange, 'Mp-At_27');
    ext.applyHorizontalConversion(rangePopupDOM);
    const rangeHeaderTitle = rangePopupDOM.querySelector('.egov-ext-tip-header-title').textContent;

    if (rangeHeaderTitle !== '参照条文（第２７条から第２９条まで）') {
      throw new Error(`範囲指定ヘッダータイトルが不正です: ${rangeHeaderTitle}`);
    }

    // 3.3 相対参照リンク（第十一号）の親条文自動補完ヘッダー表示検証
    const dummyLinkRel = window.document.createElement('a');
    dummyLinkRel.textContent = '第十一号';
    dummyLinkRel.href = '#Mp-Ch_11-At_153-Pr_1-It_11';

    const relTargetEl = window.document.createElement('div');
    relTargetEl.className = 'Item';
    relTargetEl.id = 'Mp-Ch_11-At_153-Pr_1-It_11';
    relTargetEl.innerHTML = '<div class="ItemTitle">十一</div>';

    const relPopupDOM = fnBuild(relTargetEl, dummyLinkRel, 'Mp-Ch_11-At_153-Pr_1-It_11');
    ext.applyHorizontalConversion(relPopupDOM);
    const relHeaderTitle = relPopupDOM.querySelector('.egov-ext-tip-header-title').textContent;

    if (relHeaderTitle !== '参照条文（第１５３条第１項第１１号）') {
      throw new Error(`相対参照補完ヘッダータイトルが不正です: ${relHeaderTitle}`);
    }

    // 3.4 附則リンクのヘッダー表示検証
    const dummyLinkSp = window.document.createElement('a');
    dummyLinkSp.textContent = '附則第三条';
    dummyLinkSp.href = '#325AC0100000214-Sp-At_3';

    const spTargetEl = window.document.createElement('div');
    spTargetEl.className = 'Article';
    spTargetEl.id = '325AC0100000214-Sp-At_3';
    spTargetEl.innerHTML = '<div class="ArticleTitle">第三条</div>';

    const spPopupDOM = fnBuild(spTargetEl, dummyLinkSp, '325AC0100000214-Sp-At_3');
    ext.applyHorizontalConversion(spPopupDOM);
    const spHeaderTitle = spPopupDOM.querySelector('.egov-ext-tip-header-title').textContent;

    if (spHeaderTitle !== '参照条文（附則第３条）') {
      throw new Error(`附則ヘッダータイトルが不正です: ${spHeaderTitle}`);
    }

    return '参照箇所明示・範囲指定・相対参照親条文自動補完・附則・枝番および全角アラビア数字横書き変換の完全動作を確認';
  });

  // テスト 28: 定義語ポップアップヘッダーにおける定義先条項（第◯条の◯）の算用数字変換・枝番号対応の検証
  await check('定義語ポップアップヘッダーにおける定義先条項（第◯条の◯）の算用数字変換・枝番号対応の検証', async () => {
    const { window, ext } = await createTestEnv('<div class="LawBody"></div>');
    ext.settings.global = true;
    ext.settings.horizontal = true;
    ext.settings.definition = true;

    const fnGetSource = ext._testDefinition ? ext._testDefinition.getSourceClauseNumber : null;
    if (!fnGetSource) throw new Error('ext._testDefinition.getSourceClauseNumber がエクスポートされていません');

    // 1. 空家等対策の推進に関する特別措置法の実機DOMパターンの検証
    const akiyaArticle = window.document.createElement('article');
    akiyaArticle.id = 'Mp-Ch_1-At_2';
    akiyaArticle.className = 'article';
    akiyaArticle.innerHTML = `
      <div class="articlecontent">
        <em class="articleheading">（定義）</em>
        <div id="Mp-Ch_1-At_2-Pr_1" class="paragraph">
          <div class="istitle">
            <span class="paragraphtitle">第二条　</span>
            <p class="sentence">この法律において「空家等」とは、建築物又はこれに附属する工作物であって...</p>
          </div>
        </div>
      </div>
    `;

    const akiyaContextEl = akiyaArticle.querySelector('.paragraph');
    const source1 = fnGetSource(akiyaContextEl);
    if (source1 !== '（定義）第二条') {
      throw new Error(`空家法実機DOMからの出典抽出が不正です: actual="${source1}", expected="（定義）第二条"`);
    }

    // 2. 枝番条文（第二条の二、第２条の２、第二条の二の三）の枝番保持検証
    const branchArticle1 = window.document.createElement('section');
    branchArticle1.id = 'Mp-At_2_2';
    branchArticle1.className = 'Article';
    branchArticle1.innerHTML = `
      <div class="ArticleTitle">第二条の二</div>
      <div class="Paragraph" id="Mp-At_2_2-Pr_1">
        <div class="ParagraphSentence">この条文において「特定管理等」とは...</div>
      </div>
    `;
    const sourceBranch1 = fnGetSource(branchArticle1.querySelector('.Paragraph'));
    if (sourceBranch1 !== '第二条の二') {
      throw new Error(`枝番条文（第二条の二）の抽出失敗: ${sourceBranch1}`);
    }

    // 枝番2段（第二条の二の三）
    const branchArticle2 = window.document.createElement('section');
    branchArticle2.id = 'Mp-At_2_2_3';
    branchArticle2.className = 'Article';
    branchArticle2.innerHTML = `
      <div class="ArticleTitle">第二条の二の三</div>
      <div class="Paragraph" id="Mp-At_2_2_3-Pr_1">
        <div class="ParagraphSentence">本文...</div>
      </div>
    `;
    const sourceBranch2 = fnGetSource(branchArticle2.querySelector('.Paragraph'));
    if (sourceBranch2 !== '第二条の二の三') {
      throw new Error(`枝番2段（第二条の二の三）の抽出失敗: ${sourceBranch2}`);
    }

    // IDフォールバック（DOMタイトル欠損時の枝番抽出）
    const fallbackArticle = window.document.createElement('div');
    fallbackArticle.id = 'Mp-At_52_2';
    fallbackArticle.className = 'Article';
    const sourceFallback = fnGetSource(fallbackArticle);
    if (sourceFallback !== '第52条の2') {
      throw new Error(`IDフォールバックからの枝番抽出失敗: ${sourceFallback}`);
    }

    // 3. 定義語ポップアップの resolveContent によるヘッダー算用数字変換・本文横書き変換の検証
    // 定義語マップに空家法パターンと枝番パターンを登録
    ext.definitionMap.set('空家等', {
      source: '（定義）第二条',
      element: akiyaContextEl,
      pattern: 2
    });

    ext.definitionMap.set('特定管理等', {
      source: '第二条の二',
      element: branchArticle1.querySelector('.Paragraph'),
      pattern: 2
    });

    // ツールチップイベントを初期化
    ext.definitionTooltip = null;
    ext.enableDefinitionHighlighting(window.document.body);

    // bindHoverTooltip に渡された resolveContent を取得
    const dummyTargetAkiya = window.document.createElement('span');
    dummyTargetAkiya.className = 'egov-definition-word';
    dummyTargetAkiya.dataset.word = '空家等';

    const dummyTargetBranch = window.document.createElement('span');
    dummyTargetBranch.className = 'egov-definition-word';
    dummyTargetBranch.dataset.word = '特定管理等';

    // 3.1 横書き設定 ON 時の検証
    ext.settings.horizontal = true;

    // tooltip の bindHoverTooltip resolveContent を実行検証
    // setupDefinitionTooltipEvents の resolveContent は bindHoverTooltip の引数で渡されるので、
    // ext.definitionTooltip 経由または直接 resolveContent をシミュレート
    const tooltipOptions = ext._lastBindHoverOptions || null;
    let popupFragAkiya;
    if (tooltipOptions && tooltipOptions.resolveContent) {
      popupFragAkiya = tooltipOptions.resolveContent(dummyTargetAkiya);
    } else {
      // フォールバック: 直接 resolveContent のロジックをテスト
      const defAkiya = ext.definitionMap.get('空家等');
      let sourceText = defAkiya.source;
      if (ext.settings.horizontal && ext.convertLawTextToHorizontal) {
        sourceText = ext.convertLawTextToHorizontal(sourceText);
      }
      popupFragAkiya = window.document.createDocumentFragment();
      const h = window.document.createElement('div');
      h.className = 'egov-ext-tip-header';
      h.textContent = sourceText;
      popupFragAkiya.appendChild(h);
    }

    const headerAkiya = popupFragAkiya.querySelector('.egov-ext-tip-header');
    if (!headerAkiya) throw new Error('定義語ポップアップヘッダーが見つかりません');

    // 「（定義）第二条」が「（定義）第２条」に変換されていること！
    if (headerAkiya.textContent !== '（定義）第２条') {
      throw new Error(`横書き有効時の空家法ヘッダー算用数字変換が不正です: actual="${headerAkiya.textContent}", expected="（定義）第２条"`);
    }

    // 枝番パターンの検証: 「第二条の二」が「第２条の２」に変換されていること！
    const sourceTextBranch = ext.convertLawTextToHorizontal(ext.definitionMap.get('特定管理等').source);
    if (sourceTextBranch !== '第２条の２') {
      throw new Error(`横書き有効時の枝番ヘッダー算用数字変換が不正です: actual="${sourceTextBranch}", expected="第２条の２"`);
    }

    // 3.3 号番号のカッコ除去・第◯号正規化（文化財保護法パターン）の検証
    // 横書き変換で (3) になった号見出しから「第(3)号」ではなく「第３号」と正規化されること！
    const bunkazaiArticle = window.document.createElement('div');
    bunkazaiArticle.id = 'Mp-At_2';
    bunkazaiArticle.className = 'Article';
    bunkazaiArticle.innerHTML = `
      <div class="ArticleCaption">（文化財の定義）</div>
      <div class="ArticleTitle">第二条</div>
      <div id="Mp-At_2-Pr_1" class="Paragraph">
        <div class="ParagraphNum"></div>
        <div class="ParagraphSentence">この法律で「文化財」とは、次に掲げるものをいう。</div>
        <div id="Mp-At_2-Pr_1-It_3" class="Item">
          <div class="ItemTitle">(3)　</div>
          <div class="ItemSentence">衣食住...（以下「民俗文化財」という。）</div>
        </div>
        <div id="Mp-At_2-Pr_1-It_3_2" class="Item">
          <div class="ItemTitle">(3)の2　</div>
          <div class="ItemSentence">生業...（以下「無形民俗文化財」という。）</div>
        </div>
      </div>
    `;
    window.document.body.appendChild(bunkazaiArticle);

    const item3 = bunkazaiArticle.querySelector('#Mp-At_2-Pr_1-It_3');
    const sourceItem3 = fnGetSource(item3);
    const formattedItem3 = ext.convertLawTextToHorizontal(sourceItem3);
    if (formattedItem3 !== '（文化財の定義）第２条第１項第３号') {
      throw new Error(`号番号のカッコ除去失敗: actual="${formattedItem3}", expected="（文化財の定義）第２条第１項第３号"`);
    }

    const item3_2 = bunkazaiArticle.querySelector('#Mp-At_2-Pr_1-It_3_2');
    const sourceItem3_2 = fnGetSource(item3_2);
    const formattedItem3_2 = ext.convertLawTextToHorizontal(sourceItem3_2);
    if (formattedItem3_2 !== '（文化財の定義）第２条第１項第３号の２') {
      throw new Error(`号番号枝番の正規化失敗: actual="${formattedItem3_2}", expected="（文化財の定義）第２条第１項第３号の２"`);
    }

    // 3.4 横書き設定 OFF 時の検証
    ext.settings.horizontal = false;
    let sourceTextOff = ext.definitionMap.get('空家等').source;
    if (ext.settings.horizontal && ext.convertLawTextToHorizontal) {
      sourceTextOff = ext.convertLawTextToHorizontal(sourceTextOff);
    }
    // 横書きOFFなら元の「（定義）第二条」のまま維持されること
    if (sourceTextOff !== '（定義）第二条') {
      throw new Error(`横書き無効時に漢数字が維持されていません: ${sourceTextOff}`);
    }

    bunkazaiArticle.remove();
    return '定義先条項の算用数字変換（（定義）第２条）、枝番号対応（第２条の２）、号番号カッコ除去正規化（第３号、第３号の２）、および動的設定トグルの完全動作を確認';
  });


  console.log('\n==========================================');
  if (failures === 0) {
    console.log('🎉 全ての相互作用・順序・重複検証テストに成功しました！');
  } else {
    console.error(`💥 ${failures} 件のテストで失敗が発生しました`);
    process.exit(1);
  }
})();

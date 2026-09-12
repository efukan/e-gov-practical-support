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

  console.log('\n==========================================');
  if (failures === 0) {
    console.log('🎉 全ての相互作用・順序・重複検証テストに成功しました！');
  } else {
    console.error(`💥 ${failures} 件のテストで失敗が発生しました`);
    process.exit(1);
  }
})();

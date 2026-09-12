/**
 * test_extension_integrity.js
 *
 * 拡張機能の総合健全性（Integrity）検証テストスイート。
 * 以下の5つの未検証領域を網羅的にテストします：
 *   1. i18n 多言語リソース整合性（ja/en の完全一致、manifestプレースホルダー解決）
 *   2. 設定UI & ストレージ同期（popup.html / options.html / DEFAULT_SETTINGS の1対1対応と通信）
 *   3. キーボードアクセシビリティ（Escapeによるツールチップ閉鎖、Tabフォーカス、ジャンプ検索Escapeクリア）
 *   4. 印刷スタイル（@media print における自作UIの完全非表示とコントラスト保護）
 *   5. 配布ZIPパッケージ健全性（manifest記載リソースの網羅性、不要開発ファイルの非混入）
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const assert = require('assert');
const { execSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');

let totalTests = 0;
let passedTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    throw err;
  }
}

async function runAsyncTest(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    throw err;
  }
}

async function main() {
  console.log('=== e-Gov 実務サポート: 拡張機能総合健全性 (Integrity) 検証 ===\n');

  // =============================================================================
  // 1. i18n 多言語リソース整合性テスト
  // =============================================================================
  console.log('--- 1. i18n 多言語リソース整合性 ---');

  const manifestPath = path.join(ROOT_DIR, 'manifest.json');
  const jaMessagesPath = path.join(ROOT_DIR, '_locales', 'ja', 'messages.json');
  const enMessagesPath = path.join(ROOT_DIR, '_locales', 'en', 'messages.json');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const jaMessages = JSON.parse(fs.readFileSync(jaMessagesPath, 'utf8'));
  const enMessages = JSON.parse(fs.readFileSync(enMessagesPath, 'utf8'));

  runTest('ja/en メッセージファイルの存在とJSONパース正常性', () => {
    assert(jaMessages && typeof jaMessages === 'object', 'ja messages.json が正しくパースできる');
    assert(enMessages && typeof enMessages === 'object', 'en messages.json が正しくパースできる');
  });

  runTest('ja と en のメッセージキーセット完全一致', () => {
    const jaKeys = Object.keys(jaMessages).sort();
    const enKeys = Object.keys(enMessages).sort();
    assert.deepStrictEqual(jaKeys, enKeys, `jaキー (${jaKeys.join(', ')}) と enキー (${enKeys.join(', ')}) が完全一致すること`);
  });

  runTest('各メッセージの message フィールド非空検証', () => {
    for (const [key, val] of Object.entries(jaMessages)) {
      assert(val.message && val.message.trim().length > 0, `ja: ${key} の message が空でないこと`);
    }
    for (const [key, val] of Object.entries(enMessages)) {
      assert(val.message && val.message.trim().length > 0, `en: ${key} の message が空でないこと`);
    }
  });

  runTest('manifest.json 内の全 __MSG_xxx__ プレースホルダーがロケールに定義されていること', () => {
    const manifestStr = fs.readFileSync(manifestPath, 'utf8');
    const matches = manifestStr.match(/__MSG_([a-zA-Z0-9_]+)__/g) || [];
    assert(matches.length > 0, 'manifest.json 内に __MSG_...__ プレースホルダーが存在する');
    for (const m of matches) {
      const key = m.replace(/__MSG_|__/g, '');
      assert(jaMessages[key], `ja messages にキー '${key}' が存在する`);
      assert(enMessages[key], `en messages にキー '${key}' が存在する`);
    }
  });

  // =============================================================================
  // 2. 設定UI & ストレージ同期テスト
  // =============================================================================
  console.log('\n--- 2. 設定UI & ストレージ・メッセージ同期 ---');

  const popupHtml = fs.readFileSync(path.join(ROOT_DIR, 'popup.html'), 'utf8');
  const optionsHtml = fs.readFileSync(path.join(ROOT_DIR, 'options.html'), 'utf8');
  const settingsJs = fs.readFileSync(path.join(ROOT_DIR, 'js', 'settings.js'), 'utf8');

  // DEFAULT_SETTINGS を抽出
  const defaultSettingsMatch = settingsJs.match(/ext\.DEFAULT_SETTINGS\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\);/);
  assert(defaultSettingsMatch, 'DEFAULT_SETTINGS が settings.js に定義されている');
  const defaultSettings = {};
  defaultSettingsMatch[1].split(',').forEach(line => {
    const m = line.match(/([a-zA-Z0-9_]+)\s*:\s*(true|false)/);
    if (m) defaultSettings[m[1]] = m[2] === 'true';
  });

  const settingKeys = Object.keys(defaultSettings);

  runTest('DEFAULT_SETTINGS に10個の全機能キーが定義されていること', () => {
    const expectedKeys = ['global', 'scrollspy', 'popup', 'definition', 'newtab', 'dim', 'jump', 'horizontal', 'fastrender', 'citation'];
    assert.strictEqual(settingKeys.length, expectedKeys.length);
    expectedKeys.forEach(k => assert(settingKeys.includes(k), `キー '${k}' が DEFAULT_SETTINGS に存在する`));
  });

  runTest('popup.html に DEFAULT_SETTINGS の全キーに対応するチェックボックスが存在すること', () => {
    const dom = new JSDOM(popupHtml);
    const doc = dom.window.document;
    settingKeys.forEach(key => {
      const el = doc.getElementById(`feature-${key}`);
      assert(el, `popup.html に #feature-${key} が存在する`);
      assert.strictEqual(el.type, 'checkbox', `#feature-${key} は checkbox である`);
    });
    const openOptions = doc.getElementById('open-options');
    assert(openOptions, 'popup.html に #open-options ボタンが存在する');
  });

  runTest('options.html に DEFAULT_SETTINGS の全キーに対応するチェックボックスが存在すること', () => {
    const dom = new JSDOM(optionsHtml);
    const doc = dom.window.document;
    settingKeys.forEach(key => {
      const el = doc.getElementById(`feature-${key}`);
      assert(el, `options.html に #feature-${key} が存在する`);
      assert.strictEqual(el.type, 'checkbox', `#feature-${key} は checkbox である`);
    });
  });

  await runAsyncTest('initSettingsUI による設定読み込みとトグル変更時のメッセージ通知 (broadcast)', async () => {
    const dom = new JSDOM(popupHtml, { runScripts: 'dangerously' });
    const window = dom.window;
    const document = window.document;

    let savedStorage = null;
    const sentMessages = [];

    window.chrome = {
      storage: {
        sync: {
          get: async (key) => ({ [key]: { global: true, dim: false } }),
          set: async (obj) => { savedStorage = obj; }
        },
        onChanged: { addListener: () => {} }
      },
      tabs: {
        query: async () => [{ id: 1, url: 'https://laws.e-gov.go.jp/law/123' }],
        sendMessage: async (tabId, msg) => { sentMessages.push({ tabId, msg }); }
      }
    };

    // settings.js を評価
    window.eval(settingsJs);
    assert(window.egovExt && window.egovExt.initSettingsUI, 'initSettingsUI がロードされる');

    await window.egovExt.initSettingsUI({ allTabs: false });

    // ストレージ値がUIに反映されていること
    assert.strictEqual(document.getElementById('feature-global').checked, true, 'global は true');
    assert.strictEqual(document.getElementById('feature-dim').checked, false, 'dim は false');

    // トグルを変更
    const horizontalToggle = document.getElementById('feature-horizontal');
    horizontalToggle.checked = false;
    horizontalToggle.dispatchEvent(new window.Event('change'));

    // 保存とブロードキャストが非同期で行われるのを待つ
    await new Promise(r => setTimeout(r, 20));

    assert(savedStorage && savedStorage.egovSettings, 'chrome.storage.sync.set が呼ばれた');
    assert.strictEqual(savedStorage.egovSettings.horizontal, false, 'horizontal が false で保存された');
    assert.strictEqual(sentMessages.length, 1, 'chrome.tabs.sendMessage が1回呼ばれた');
    assert.strictEqual(sentMessages[0].msg.type, 'SETTINGS_CHANGED', 'メッセージ種別が SETTINGS_CHANGED');
    assert.strictEqual(sentMessages[0].msg.settings.horizontal, false, '送信された設定の horizontal が false');
  });

  // =============================================================================
  // 3. キーボードアクセシビリティ (A11y) 検証
  // =============================================================================
  console.log('\n--- 3. キーボードアクセシビリティ (A11y) ---');

  const tooltipJs = fs.readFileSync(path.join(ROOT_DIR, 'js', 'tooltip.js'), 'utf8');
  const jumpJs = fs.readFileSync(path.join(ROOT_DIR, 'js', 'jump.js'), 'utf8');
  const utilsJs = fs.readFileSync(path.join(ROOT_DIR, 'js', 'utils.js'), 'utf8');

  await runAsyncTest('Escapeキーで開いているツールチップが即座に閉じられること', async () => {
    const dom = new JSDOM(`
      <!DOCTYPE html><html><body>
        <div id="anchor" class="tip-anchor">ホバー対象</div>
      </body></html>
    `, { runScripts: 'dangerously' });
    const window = dom.window;
    const document = window.document;

    window.eval(utilsJs);
    window.eval(tooltipJs);
    const ext = window.egovExt;

    const tip = ext.createTooltip({ variant: 'reference' });
    ext.bindHoverTooltip({
      selector: '.tip-anchor',
      tooltip: tip,
      showDelay: 0,
      resolveContent: () => document.createTextNode('ツールチップ内容')
    });

    const anchor = document.getElementById('anchor');
    anchor.getBoundingClientRect = () => ({
      top: 100, bottom: 120, left: 100, right: 200, width: 100, height: 20
    });

    anchor.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }));
    await new Promise(r => setTimeout(r, 20));

    assert.strictEqual(tip.el.classList.contains('visible'), true, 'ツールチップが表示されている');

    // Escape キーを押下
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(r => setTimeout(r, 20));

    assert.strictEqual(tip.el.classList.contains('visible'), false, 'Escapeキーでツールチップが非表示になった');
  });

  runTest('条文ジャンプ検索のEscapeキーによる入力クリア＆blur処理', () => {
    const dom = new JSDOM(`
      <!DOCTYPE html><html><body>
        <div class="header-placeholder" id="law-header"></div>
      </body></html>
    `, { runScripts: 'dangerously' });
    const window = dom.window;
    const document = window.document;

    window.eval(utilsJs);
    window.eval(jumpJs);
    const ext = window.egovExt;
    ext.settings = { global: true, jump: true };

    ext.setupJumpSearch();

    const container = document.getElementById('egov-ext-jump-container');
    assert(container, 'ジャンプ検索コンテナが生成された');
    const input = container.querySelector('.egov-ext-jump-input');
    const clearBtn = container.querySelector('.egov-ext-jump-clear');
    assert(input, '入力欄が存在する');
    assert(clearBtn, 'クリアボタンが存在する');

    // 文字を入力
    input.value = '15';
    input.dispatchEvent(new window.Event('input'));
    assert.strictEqual(clearBtn.classList.contains('visible'), true, '入力によりクリアボタンが表示される');

    let blurCalled = false;
    input.blur = () => { blurCalled = true; };

    // Escapeキーを押下
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    assert.strictEqual(input.value, '', 'Escapeキーで入力がクリアされた');
    assert.strictEqual(clearBtn.classList.contains('visible'), false, 'クリアボタンが非表示になった');
    assert.strictEqual(blurCalled, true, 'blur() が実行された');
  });

  runTest('条文ジャンプ検索クリアボタンのキーボード操作 (Enter/Space)', () => {
    const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`, { runScripts: 'dangerously' });
    const window = dom.window;
    const document = window.document;

    window.eval(utilsJs);
    window.eval(jumpJs);
    const ext = window.egovExt;
    ext.settings = { global: true, jump: true };

    ext.setupJumpSearch();

    const input = document.querySelector('.egov-ext-jump-input');
    const clearBtn = document.querySelector('.egov-ext-jump-clear');

    input.value = '25';
    input.dispatchEvent(new window.Event('input'));

    // Clearボタンで Spaceキーを押下
    clearBtn.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    assert.strictEqual(input.value, '', 'Spaceキーで入力がクリアされた');

    input.value = '30';
    clearBtn.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.strictEqual(input.value, '', 'Enterキーで入力がクリアされた');
  });

  runTest('css/style.css 内のフォーカス視認性 (:focus-visible) 定義', () => {
    const styleCss = fs.readFileSync(path.join(ROOT_DIR, 'css', 'style.css'), 'utf8');
    assert(styleCss.includes('.egov-ext-jump-input:focus-visible'), 'jump-input の focus-visible が定義されている');
    assert(styleCss.includes('.egov-ext-citation-btn:focus-visible'), 'citation-btn の focus-visible が定義されている');
    assert(styleCss.includes('.egov-definition-word:focus-visible'), 'definition-word の focus-visible が定義されている');
    assert(styleCss.includes('.egov-ext-tip-action-btn:focus-visible'), 'tip-action-btn の focus-visible が定義されている');
  });


  runTest('css/style.css 内のツールチップ・プレビュー内引用ボタン非表示 (display: none) 定義', () => {
    const styleCss = fs.readFileSync(path.join(ROOT_DIR, 'css', 'style.css'), 'utf8');
    assert(styleCss.includes('.egov-ext-tip .egov-ext-citation-btn'), 'tip 内の citation-btn 非表示ルールが定義されている');
    assert(styleCss.includes('.egov-ext-preview-container .egov-ext-citation-btn'), 'preview-container 内の citation-btn 非表示ルールが定義されている');
  });

  runTest('css/style.css 内のツールチップ z-index がステータスバッジ（ヘッダーコンテナ）より前面に設定されていること', () => {
    const styleCss = fs.readFileSync(path.join(ROOT_DIR, 'css', 'style.css'), 'utf8');
    const headerMatch = styleCss.match(/\.egov-ext-header-container\s*\{[\s\S]*?z-index:\s*(\d+)/);
    assert(headerMatch, '.egov-ext-header-container の z-index が定義されている');
    const headerZIndex = parseInt(headerMatch[1], 10);

    const tipMatch = styleCss.match(/\.egov-ext-tip\s*\{[\s\S]*?z-index:\s*(\d+)/);
    assert(tipMatch, '.egov-ext-tip の z-index が定義されている');
    const tipZIndex = parseInt(tipMatch[1], 10);

    const previewMatch = styleCss.match(/\.egov-ext-tip--preview\s*\{[\s\S]*?z-index:\s*(\d+)/);
    assert(previewMatch, '.egov-ext-tip--preview の z-index が定義されている');
    const previewZIndex = parseInt(previewMatch[1], 10);

    assert(tipZIndex > headerZIndex, `ツールチップの z-index (${tipZIndex}) はヘッダーコンテナ (${headerZIndex}) より大きいこと`);
    assert(previewZIndex >= tipZIndex, `プレビューツールチップの z-index (${previewZIndex}) は通常ツールチップ (${tipZIndex}) 以上であること`);
  });


  // =============================================================================
  // 4. 印刷スタイル (@media print) 検証
  // =============================================================================
  console.log('\n--- 4. 印刷スタイル (@media print) ---');

  runTest('@media print 内で自作UI要素が完全非表示 (display: none !important) になっていること', () => {
    const styleCss = fs.readFileSync(path.join(ROOT_DIR, 'css', 'style.css'), 'utf8');
    const printMatch = styleCss.match(/@media\s+print\s*\{([\s\S]*?)\n\}/);
    assert(printMatch, '@media print ブロックが存在する');
    const printContent = printMatch[1];

    const requiredHiddenSelectors = [
      '.egov-ext-header-container',
      '.egov-ext-status-badge',
      '.egov-ext-jump-container',
      '.egov-ext-jump-modal',
      '.egov-ext-tip',
      '.egov-ext-citation-btn',
      '.egov-ext-citation-modal',
      '.egov-ext-toast'
    ];

    requiredHiddenSelectors.forEach(sel => {
      assert(printContent.includes(sel), `印刷非表示セレクタに '${sel}' が含まれている`);
    });

    assert(printContent.includes('display: none !important'), 'display: none !important が指定されている');
    assert(printContent.includes('.egov-ext-dimmed-text'), '印刷時の括弧書き文字コントラスト補正が含まれている');
    assert(printContent.includes('.egov-definition-word'), '印刷時の定義語下線消去が含まれている');
  });

  // =============================================================================
  // 5. 配布ZIPパッケージ健全性検証
  // =============================================================================
  console.log('\n--- 5. 配布ZIPパッケージ健全性 ---');

  const zipPath = path.join(ROOT_DIR, 'e-gov-layout-changes.zip');

  runTest('配布パッケージ e-gov-layout-changes.zip の存在とサイズ確認', () => {
    assert(fs.existsSync(zipPath), 'e-gov-layout-changes.zip がルートに存在する');
    const stats = fs.statSync(zipPath);
    assert(stats.size > 50000, `ZIPサイズが妥当である (${Math.round(stats.size / 1024)} KB)`);
    assert(stats.size < 5000000, `ZIPサイズが過大でない (${Math.round(stats.size / 1024)} KB)`);
  });

  runTest('manifest.json に記載されたすべてのファイルがZIPアーカイブに含まれていること', () => {
    const zipFileList = execSync(`unzip -l "${zipPath}"`, { encoding: 'utf8' });

    // manifest記載の content_scripts, background, icons, action, options_ui, locales を抽出
    const requiredFiles = [
      'manifest.json',
      'popup.html',
      'options.html',
      'icons/icon16.png',
      'icons/icon48.png',
      'icons/icon128.png',
      'css/style.css',
      'css/popup.css',
      'css/options.css',
      'js/popup.js',
      'js/options.js',
      'js/background.js',
      '_locales/ja/messages.json',
      '_locales/en/messages.json'
    ];

    // content_scripts の js を追加
    manifest.content_scripts.forEach(cs => {
      cs.js.forEach(f => requiredFiles.push(f));
    });

    requiredFiles.forEach(file => {
      assert(zipFileList.includes(file), `ZIP内に必須ファイル '${file}' が存在する`);
    });
  });

  runTest('不要な開発用ファイルがZIPアーカイブに混入していないこと', () => {
    const zipFileList = execSync(`unzip -l "${zipPath}"`, { encoding: 'utf8' });
    const forbiddenPatterns = [
      'node_modules',
      '.git',
      '.agents',
      'tests/',
      'package.json',
      'package-lock.json',
      'scripts/',
      'CHROMEWEBSTORE.md'
    ];

    forbiddenPatterns.forEach(pat => {
      assert(!zipFileList.includes(pat), `ZIP内に不要開発用パス '${pat}' が混入していないこと`);
    });
  });

  console.log(`\n======================================================`);
  console.log(`全総合健全性テスト完了: ${passedTests}/${totalTests} PASS (100%)`);
  console.log(`======================================================\n`);
}

main().catch(err => {
  console.error('Fatal integrity test error:', err);
  process.exit(1);
});

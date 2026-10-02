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
  console.log('=== e-Gov法令ひもとき: 拡張機能総合健全性 (Integrity) 検証 ===\n');

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

  runTest('extDesc の文字数が Manifest / Chrome Web Store の上限（132文字）以内であること', () => {
    assert(jaMessages.extDesc.message.length <= 132, `ja: extDesc (${jaMessages.extDesc.message.length}文字) は 132 文字以内であること`);
    assert(enMessages.extDesc.message.length <= 132, `en: extDesc (${enMessages.extDesc.message.length}文字) は 132 文字以内であること`);
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

  runTest('条文ページに差し込む要素に aria-hidden を使わないこと（e-Gov の CSS が [aria-hidden=true] を display:none にするため）', () => {
    const scripts = new Set();
    manifest.content_scripts.forEach(cs => (cs.js || []).forEach(f => scripts.add(f)));
    for (const f of scripts) {
      const src = fs.readFileSync(path.join(ROOT_DIR, f), 'utf8');
      assert(!/aria-hidden="|['"]aria-hidden['"]\s*,/.test(src), `${f} に aria-hidden が無いこと`);
    }
  });

  runTest('manifest.json と package.json のバージョン番号完全一致および popup.html バージョンタグ整合性', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    assert.strictEqual(manifest.version, pkg.version, `manifest.version (${manifest.version}) と package.json version (${pkg.version}) が一致すること`);

    // セマンティックバージョニング形式 (X.Y.Z) 検証
    assert(/^\d+\.\d+\.\d+$/.test(manifest.version), `バージョン (${manifest.version}) がセマンティックバージョニング形式であること`);

    // popup.html の version-tag 検証
    const popupHtml = fs.readFileSync(path.join(ROOT_DIR, 'popup.html'), 'utf8');
    const versionMatch = popupHtml.match(/<span class="version-tag">(.*?)<\/span>/);
    assert(versionMatch, 'popup.html に version-tag が存在する');
    const [major, minor] = manifest.version.split('.');
    assert.strictEqual(versionMatch[1], `v${major}.${minor}`, `popup.html の version-tag (${versionMatch[1]}) が v${major}.${minor} と一致すること`);
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
    const m = line.match(/([a-zA-Z0-9_]+)\s*:\s*(['"][^'"]+['"]|true|false)/);
    if (m) {
      if (m[2] === 'true') defaultSettings[m[1]] = true;
      else if (m[2] === 'false') defaultSettings[m[1]] = false;
      else defaultSettings[m[1]] = m[2].replace(/['"]/g, '');
    }
  });

  const settingKeys = Object.keys(defaultSettings);
  const toggleKeys = settingKeys.filter(k => k !== 'definitionColor');

  runTest('DEFAULT_SETTINGS に全17設定キー（16機能トグル＋定義語カラー）が定義され、全機能が初期状態で全て ON (true) であること', () => {
    const expectedKeys = ['global', 'scrollspy', 'popup', 'definition', 'parentDefinition', 'newtab', 'dim', 'jump', 'horizontal', 'conjunction', 'fastrender', 'citation', 'favorite', 'quickToggle', 'backref', 'marker', 'definitionColor'];
    assert.strictEqual(settingKeys.length, expectedKeys.length);
    expectedKeys.forEach(k => assert(settingKeys.includes(k), `キー '${k}' が DEFAULT_SETTINGS に存在する`));
    
    // 初回インストール時にすべての機能トグルが ON (true) であることを厳密に検証
    toggleKeys.forEach(k => {
      assert.strictEqual(defaultSettings[k], true, `機能トグル '${k}' のデフォルト値は true (ON) であること`);
    });

    assert.strictEqual(defaultSettings.definitionColor, '#00695c', 'デフォルトの定義語カラーは緑系ティール深緑(#00695c)である');
  });

  runTest('popup.html に 全機能トグルに対応するチェックボックスが存在し、全て初期状態で checked であること', () => {
    const dom = new JSDOM(popupHtml);
    const doc = dom.window.document;
    toggleKeys.forEach(key => {
      const el = doc.getElementById(`feature-${key}`);
      assert(el, `popup.html に #feature-${key} が存在する`);
      assert.strictEqual(el.type, 'checkbox', `#feature-${key} は checkbox である`);
      assert(el.hasAttribute('checked'), `popup.html の #feature-${key} には checked 属性が付与されていること`);
    });
    const openOptions = doc.getElementById('open-options');
    assert(openOptions, 'popup.html に #open-options ボタンが存在する');
  });

  runTest('options.html に 全機能トグルおよび定義語カラー設定UIが存在し、全て初期状態で checked であること', () => {
    const dom = new JSDOM(optionsHtml);
    const doc = dom.window.document;
    toggleKeys.forEach(key => {
      const el = doc.getElementById(`feature-${key}`);
      assert(el, `options.html に #feature-${key} が存在する`);
      assert.strictEqual(el.type, 'checkbox', `#feature-${key} は checkbox である`);
      assert(el.hasAttribute('checked'), `options.html の #feature-${key} には checked 属性が付与されていること`);
    });
    const colorPicker = doc.getElementById('def-color-picker');
    assert(colorPicker, 'options.html に #def-color-picker が存在する');
    const swatches = doc.querySelectorAll('.def-color-swatch');
    assert(swatches.length >= 5, 'options.html に 5個以上のカラースウォッチが存在する');
  });

  await runAsyncTest('初回インストール時（storage未設定時）に loadSettings() が全機能 ON (true) を返すこと', async () => {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'dangerously' });
    const window = dom.window;
    window.chrome = {
      storage: {
        sync: {
          get: async () => ({}) // 空ストレージ（初回インストール状態）
        }
      }
    };
    window.eval(settingsJs);
    const loaded = await window.egovExt.loadSettings();
    toggleKeys.forEach(k => {
      assert.strictEqual(loaded[k], true, `初回読み込み時に機能 '${k}' が true (ON) であること`);
    });
    assert.strictEqual(loaded.definitionColor, '#00695c', '初回読み込み時の定義語カラーが #00695c であること');
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

  const favoritesJs = fs.readFileSync(path.join(ROOT_DIR, 'js', 'favorites.js'), 'utf8');
  const utilsJsForFavorites = fs.readFileSync(path.join(ROOT_DIR, 'js', 'utils.js'), 'utf8');
  const jumpJsForFavorites = fs.readFileSync(path.join(ROOT_DIR, 'js', 'jump.js'), 'utf8');

  /** chrome.storage の1区画（sync / local）の最小限の模擬。onChanged も発火する */
  function createStorageArea(areaName, listeners, options = {}) {
    const mem = {};
    const notify = (changes) => listeners.forEach(l => l(changes, areaName));
    return {
      mem,
      get: async (key) => {
        if (key === null || key === undefined) return JSON.parse(JSON.stringify(mem));
        return key in mem ? { [key]: JSON.parse(JSON.stringify(mem[key])) } : {};
      },
      set: async (obj) => {
        if (options.maxItems && Object.keys(Object.assign({}, mem, obj)).length > options.maxItems) {
          throw new Error('QUOTA_BYTES quota exceeded');
        }
        const changes = {};
        for (const k of Object.keys(obj)) {
          changes[k] = { oldValue: mem[k], newValue: obj[k] };
          mem[k] = JSON.parse(JSON.stringify(obj[k]));
        }
        notify(changes);
      },
      remove: async (key) => {
        const keys = Array.isArray(key) ? key : [key];
        const changes = {};
        keys.forEach(k => { if (k in mem) { changes[k] = { oldValue: mem[k] }; delete mem[k]; } });
        notify(changes);
      }
    };
  }

  function createStorageMock(options) {
    const listeners = [];
    return {
      sync: createStorageArea('sync', listeners, options),
      local: createStorageArea('local', listeners),
      onChanged: { addListener: (l) => listeners.push(l) }
    };
  }

  await runAsyncTest('お気に入りの追加・重複時の更新・削除（chrome.storage.sync に1件1キーで保存し、新しい順で読む）', async () => {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'dangerously' });
    const window = dom.window;
    const storage = createStorageMock();
    window.chrome = { storage };
    window.eval(favoritesJs);
    const ext = window.egovExt;

    assert.strictEqual((await ext.loadFavorites()).length, 0, '初期状態は空');
    await ext.addFavorite({ lawId: '322AC0000000067', title: '地方自治法', lawNum: '昭和二十二年法律第六十七号' });
    await new Promise(r => setTimeout(r, 5)); // 登録日時をずらす
    await ext.addFavorite({ lawId: '129ac0000000089', title: '民法' });
    let list = await ext.loadFavorites();
    assert.strictEqual(list.map(f => f.lawId).join(','), '129AC0000000089,322AC0000000067', '新しく登録したものが先頭、法令IDは大文字にそろう');

    await ext.addFavorite({ lawId: '322AC0000000067', title: '地方自治法（新）' });
    list = await ext.loadFavorites();
    assert.strictEqual(list.length, 2, '同じ法令は二重に登録しない');
    assert.strictEqual(list[1].title, '地方自治法（新）', '登録済みなら法令名だけ新しくする');
    assert.strictEqual(list[1].lawNum, '昭和二十二年法律第六十七号', '渡されなかった法令番号は残す');

    await ext.removeFavorite('322AC0000000067');
    list = await ext.loadFavorites();
    assert.strictEqual(list.map(f => f.lawId).join(','), '129AC0000000089', '外した法令が消える');
    assert.strictEqual(storage.sync.mem['egovFav:129AC0000000089'].t, '民法', 'egovFav:<法令ID> のキーに1件ずつ保存される');
    assert(!('egovFav:322AC0000000067' in storage.sync.mem), '外した法令のキーは消える');
    assert.strictEqual(ext.getLawPageUrl('129AC0000000089'), 'https://laws.e-gov.go.jp/law/129AC0000000089');
  });

  await runAsyncTest('お気に入り: 上限の件数・同期容量の不足では登録せず理由を返す、開発版の local の一覧を同期へ移す', async () => {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'dangerously' });
    const window = dom.window;
    const storage = createStorageMock({ maxItems: 3 });
    await storage.local.set({ egovFavorites: [{ lawId: '322AC0000000067', title: '地方自治法', lawNum: '', addedAt: 1 }] });
    window.chrome = { storage };
    window.eval(favoritesJs);
    const ext = window.egovExt;

    const migrated = await ext.loadFavorites();
    assert.strictEqual(migrated.length, 1, '以前 local に置いた一覧が読める');
    assert(storage.sync.mem['egovFav:322AC0000000067'], '同期ストレージへ移された');
    assert(!('egovFavorites' in storage.local.mem), 'local の古い一覧は消える');

    assert.strictEqual((await ext.addFavorite({ lawId: 'A1', title: 'a' })).ok, true);
    assert.strictEqual((await ext.addFavorite({ lawId: 'A2', title: 'b' })).ok, true);
    const quota = await ext.addFavorite({ lawId: 'A3', title: 'c' });
    assert.strictEqual(quota.ok, false, '容量を超えると登録しない');
    assert.strictEqual(quota.reason, 'quota');
    assert(ext.describeFavoriteError(quota).includes('同期'), '容量不足の説明を返す');

    ext.FAVORITES_MAX = 3;
    const full = await ext.addFavorite({ lawId: 'A4', title: 'd' });
    assert.strictEqual(full.reason, 'full', '上限の件数に達したら full');
    assert.strictEqual((await ext.addFavorite({ lawId: 'A1', title: 'a（改）' })).ok, true, '登録済みの法令の更新は上限でもできる');
  });

  await runAsyncTest('条文ページのお気に入りボタン: 法令名の読み取り・登録/解除・他画面での変更への追従・設定オフで除去', async () => {
    const dom = new JSDOM(`<!DOCTYPE html><html><head><title>地方自治法 | e-Gov 法令検索</title></head><body>
      <h1 class="title title-law"><span class="lawlabel">地方自治法<span class="lawnumber">（昭和二十二年法律第六十七号）</span></span></h1>
    </body></html>`, { runScripts: 'dangerously', url: 'https://laws.e-gov.go.jp/law/322AC0000000067' });
    const window = dom.window;
    const document = window.document;
    const storage = createStorageMock();
    window.chrome = { storage };
    window.eval(utilsJsForFavorites);
    window.eval(jumpJsForFavorites);
    window.eval(favoritesJs);
    const ext = window.egovExt;
    ext.settings = { global: true, jump: true, favorite: true };

    ext.setupJumpSearch();
    ext.setupFavoriteButton();
    const btn = document.getElementById('egov-ext-fav-btn');
    assert(btn, 'お気に入りボタンが置かれた');
    assert.strictEqual(btn.nextElementSibling && btn.nextElementSibling.id, 'egov-ext-jump-container', '条文ジャンプ検索の左隣に置かれる');
    const info = ext.readCurrentLawInfo();
    assert.strictEqual(info.title, '地方自治法', '見出しから法令名を読む');
    assert.strictEqual(info.lawNum, '昭和二十二年法律第六十七号', '見出しから法令番号を読む');

    btn.click();
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(btn.getAttribute('aria-pressed'), 'true', '押すと登録済みの表示になる');
    assert.strictEqual(storage.sync.mem['egovFav:322AC0000000067'].t, '地方自治法', '法令名が保存される');

    // ポップアップや同期している別の端末で外された場合もボタンの表示が戻る
    await storage.sync.remove('egovFav:322AC0000000067');
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(btn.getAttribute('aria-pressed'), 'false', '他の画面で外されたら表示が戻る');

    ext.settings.favorite = false;
    ext.setupFavoriteButton();
    assert(!document.getElementById('egov-ext-fav-btn'), '設定をオフにするとボタンが消える');
  });

  await runAsyncTest('条文ページの切り替えボタン: お気に入りの左隣に置き、押すと設定を保存して全機能を掛け直す・設定オフで除去', async () => {
    const dom = new JSDOM('<!DOCTYPE html><html><head><title>地方自治法 | e-Gov 法令検索</title></head><body></body></html>',
      { runScripts: 'dangerously', url: 'https://laws.e-gov.go.jp/law/322AC0000000067' });
    const window = dom.window;
    const document = window.document;
    const storage = createStorageMock();
    window.chrome = { storage };
    window.eval(settingsJs);
    window.eval(utilsJsForFavorites);
    window.eval(jumpJsForFavorites);
    window.eval(favoritesJs);
    window.eval(fs.readFileSync(path.join(ROOT_DIR, 'js', 'quick_toggle.js'), 'utf8'));
    const ext = window.egovExt;
    ext.settings = Object.assign({}, ext.DEFAULT_SETTINGS);
    let applied = 0;
    ext.applySettings = () => { applied++; };

    ext.setupJumpSearch();
    ext.setupFavoriteButton();
    ext.setupQuickToggles();
    const group = document.getElementById('egov-ext-quick-toggles');
    assert(group, '切り替えボタンの組が置かれた');
    assert.strictEqual(group.nextElementSibling && group.nextElementSibling.id, 'egov-ext-fav-btn', 'お気に入りボタンの左隣に置かれる');
    const buttons = Array.from(group.querySelectorAll('.egov-ext-quick-btn'));
    assert.strictEqual(buttons.map(b => b.dataset.key).join(','), 'horizontal,dim,conjunction,definition,citation,backref,marker');
    assert.strictEqual(group.querySelectorAll('.egov-ext-quick-sep').length, 2, '表示の4つ・引用と参照の2つ・マーカーの間に仕切りが2つ');
    assert.strictEqual(Array.from(group.querySelectorAll('.egov-ext-quick-secondary')).map(e => e.dataset.key || 'sep').join(','), 'sep,citation,backref,sep,marker', '幅が足りないとき先に隠すのは、仕切りと「被引用」「参照元」「マーカー」');
    assert.strictEqual(Array.from(group.querySelectorAll('.egov-ext-quick-tertiary')).map(e => e.dataset.key || 'sep').join(','), 'sep,citation,backref', 'いちばん先に隠すのは「被引用」「参照元」と前の仕切り（「マーカー」の前の仕切りは残る）');
    assert(buttons.every(b => b.getAttribute('aria-pressed') === 'true'), '初期値はすべてオン');

    buttons[0].click();
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(ext.settings.horizontal, false, '押した機能がオフになる');
    assert.strictEqual(buttons[0].getAttribute('aria-pressed'), 'false', '見た目もオフになる');
    assert.strictEqual(storage.sync.mem.egovSettings.horizontal, false, '設定が保存される');
    assert.strictEqual(storage.sync.mem.egovSettings.dim, true, 'ほかの機能はそのまま');
    assert.strictEqual(applied, 1, '全機能の掛け直しが呼ばれる');

    ext.settings.quickToggle = false;
    ext.setupQuickToggles();
    assert(!document.getElementById('egov-ext-quick-toggles'), '設定をオフにすると消える');

    // 法令名検索を開く虫眼鏡と、設定画面を開く歯車: 押すと background.js へ依頼を送る
    const sent = [];
    window.chrome.runtime = { sendMessage: async (msg) => { sent.push(msg); } };
    ext.setupSettingsButton();
    const search = document.getElementById('egov-ext-search-btn');
    const gear = document.getElementById('egov-ext-settings-btn');
    assert(search && gear, '虫眼鏡と歯車のボタンが置かれた');
    assert(search.getAttribute('aria-label') && gear.getAttribute('aria-label'), 'どちらにも読み上げ用の名前がある');
    search.click();
    gear.click();
    assert.strictEqual(sent.map(m => m.type).join(','), 'OPEN_LAW_SEARCH,OPEN_OPTIONS_PAGE', '虫眼鏡は検索、歯車は設定画面を開く依頼を送る');
    ext.setupSettingsButton();
    assert.strictEqual(document.querySelectorAll('#egov-ext-search-btn, #egov-ext-settings-btn').length, 2, '2回呼んでも増えない');
    ext.settings.global = false;
    ext.setupSettingsButton();
    assert(!document.getElementById('egov-ext-settings-btn') && !document.getElementById('egov-ext-search-btn'), '拡張全体をオフにすると虫眼鏡も歯車も消える');
  });

  await runAsyncTest('background.js: 設定画面・法令名検索を開く依頼は、この拡張自身からのものだけ受ける', async () => {
    const bgJs = fs.readFileSync(path.join(ROOT_DIR, 'js', 'background.js'), 'utf8');
    let listener = null;
    let opened = 0;
    let popupOpenedWith = null;
    let popupFails = false;
    const createdTabs = [];
    const session = {};
    const chromeMock = {
      action: {
        setIcon: () => Promise.resolve(),
        openPopup: async (opts) => { if (popupFails) throw new Error('not allowed'); popupOpenedWith = opts; }
      },
      runtime: {
        id: 'self-id',
        onStartup: { addListener() {} },
        onInstalled: { addListener() {} },
        onMessage: { addListener: (l) => { listener = l; } },
        openOptionsPage: () => { opened++; return Promise.resolve(); },
        getURL: (p) => 'chrome-extension://self-id/' + p,
        lastError: null
      },
      tabs: { create: (props) => { createdTabs.push(props); } },
      storage: {
        sync: { get: (k, cb) => cb({}) },
        session: { set: async (o) => Object.assign(session, o), remove: async (k) => { delete session[k]; } },
        onChanged: { addListener() {} }
      }
    };
    new Function('chrome', bgJs)(chromeMock);
    assert(listener, 'onMessage のリスナーが登録される');
    listener({ type: 'OPEN_OPTIONS_PAGE' }, { id: 'other-id' });
    assert.strictEqual(opened, 0, 'ほかの拡張からの依頼では開かない');
    listener({ type: 'SOMETHING_ELSE' }, { id: 'self-id' });
    assert.strictEqual(opened, 0, '別の種類のメッセージでは開かない');
    listener({ type: 'OPEN_OPTIONS_PAGE' }, { id: 'self-id' });
    assert.strictEqual(opened, 1, 'この拡張からの依頼で設定画面を開く');

    const pageTab = { id: 7, index: 3, windowId: 42 };
    listener({ type: 'OPEN_LAW_SEARCH' }, { id: 'other-id', tab: pageTab });
    await new Promise(r => setTimeout(r, 10));
    assert.strictEqual(popupOpenedWith, null, 'ほかの拡張からの依頼ではポップアップを開かない');

    listener({ type: 'OPEN_LAW_SEARCH' }, { id: 'self-id', tab: pageTab });
    await new Promise(r => setTimeout(r, 10));
    assert.strictEqual(popupOpenedWith && popupOpenedWith.windowId, 42, '条文ページのあるウィンドウでポップアップを開く');
    assert(session.egovPopupFocusSearch, '検索欄にカーソルを入れる印を残す');

    popupFails = true;
    listener({ type: 'OPEN_LAW_SEARCH' }, { id: 'self-id', tab: pageTab });
    await new Promise(r => setTimeout(r, 10));
    assert.strictEqual(createdTabs.length, 1, 'ポップアップを開けなければ新しいタブで開く');
    assert.strictEqual(createdTabs[0].url, 'chrome-extension://self-id/popup.html?view=tab');
    assert.strictEqual(createdTabs[0].index, 4, '条文ページの右隣に開く');
    assert(!session.egovPopupFocusSearch, 'タブで開いたときは印を残さない');
  });

  runTest('同じ法令の中の参照元: 参照されている条・項・号の番号の横に件数の印を付け、自分の中への参照は数えない', () => {
    // e-Gov の本文の作り（2026-10-01 に建築基準法で確かめた形）に合わせた最小の本文
    const html = `<!DOCTYPE html><html><body><div id="provisionview" class="provisionview">
      <article id="Mp-Ch_1-At_3" class="article"><div class="articlecontent">
        <div id="Mp-Ch_1-At_3-Pr_1" class="paragraph"><div class="istitle"><span class="paragraphtitle">第三条　</span>
          <p class="sentence">次に掲げるものは、<a href="#Mp-Ch_1-At_3-Pr_1-It_1">次の各号</a>のとおりとする。</p></div>
          <div id="Mp-Ch_1-At_3-Pr_1-It_1" class="item istitle"><span class="itemtitle">一　</span><p class="sentence">建築物</p></div>
          <div id="Mp-Ch_1-At_3-Pr_1-It_2" class="item istitle"><span class="itemtitle">二　</span><p class="sentence"><a href="#Mp-Ch_1-At_3-Pr_1-It_1">前号</a>の敷地</p></div>
        </div>
        <div id="Mp-Ch_1-At_3-Pr_2" class="paragraph space"><div class="istitle"><span class="paragraphtitle">２　</span>
          <p class="sentence"><a href="#Mp-Ch_1-At_3-Pr_1">前項</a>の規定は、<a href="#Mp-Ch_1-At_3-Pr_1-It_2">同項第二号</a>に準用する。</p></div></div>
      </div></article>
      <article id="Mp-Ch_1-At_4" class="article"><div class="articlecontent">
        <div id="Mp-Ch_1-At_4-Pr_1" class="paragraph"><div class="istitle"><span class="paragraphtitle">第四条　</span>
          <p class="sentence"><a href="#Mp-Ch_1-At_3">第三条</a>の規定は、<span class="egov-ext-dimmed-text">（<a href="#Mp-Ch_1-At_3-Pr_1">同条第一項</a>を除く。）</span>
          <a href="#Mp-Ch_1-At_4">この条</a>と<a href="#Mp-Ch_1">第一章</a>に適用する。</p></div></div>
      </div></article>
    </div></body></html>`;
    const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://laws.e-gov.go.jp/law/325AC0000000201' });
    const window = dom.window;
    const document = window.document;
    window.chrome = { storage: createStorageMock() };
    window.eval(settingsJs);
    window.eval(utilsJsForFavorites);
    window.eval(fs.readFileSync(path.join(ROOT_DIR, 'js', 'tooltip.js'), 'utf8'));
    window.eval(fs.readFileSync(path.join(ROOT_DIR, 'js', 'refer_popup.js'), 'utf8'));
    window.eval(fs.readFileSync(path.join(ROOT_DIR, 'js', 'backref.js'), 'utf8'));
    const ext = window.egovExt;
    ext.settings = Object.assign({}, ext.DEFAULT_SETTINGS);
    ext.getLawContainer = () => document.getElementById('provisionview');

    ext.enableBackrefs(true);
    const badgeAfter = (sel) => {
      const label = document.querySelector(sel);
      const next = label && label.nextElementSibling;
      return next && next.classList.contains('egov-ext-backref-btn') ? next.textContent : null;
    };
    // 第三条（＝第3条第1項）: 第3条第2項「前項」と、第4条第1項「第三条」「同条第一項」（同じ参照元は1件）→ 2件
    assert.strictEqual(badgeAfter('#Mp-Ch_1-At_3-Pr_1 > .istitle > .paragraphtitle'), '↩2', '条と第1項への参照は条の番号にまとめ、同じ参照元は1件に数える');
    // 第1号: 第2号の「前号」だけ。第1項の「次の各号」は自分の中への参照なので数えない
    assert.strictEqual(badgeAfter('#Mp-Ch_1-At_3-Pr_1-It_1 > .itemtitle'), '↩1', '自分の号を指す「次の各号」は数えない');
    assert.strictEqual(badgeAfter('#Mp-Ch_1-At_3-Pr_1-It_2 > .itemtitle'), '↩1', '号への参照');
    assert.strictEqual(badgeAfter('#Mp-Ch_1-At_3-Pr_2 > .istitle > .paragraphtitle'), null, '参照されていない項には付けない');
    assert.strictEqual(badgeAfter('#Mp-Ch_1-At_4-Pr_1 > .istitle > .paragraphtitle'), null, '自分の条を指す「この条」や章への参照は数えない');
    assert.strictEqual(document.querySelectorAll('.egov-ext-backref-btn').length, 3, '印は3つ');
    assert(document.querySelector('.egov-ext-backref-btn').getAttribute('aria-label').includes('件'), '読み上げ用の名前に件数が入る');
    assert.strictEqual(ext.formatPathFromObjectId('Mp-Ch_1-At_4-Pr_1'), '第4条第1項', '参照元の名前は条項の形');

    ext.enableBackrefs(true);
    assert.strictEqual(document.querySelectorAll('.egov-ext-backref-btn').length, 3, '付け直しても増えない');

    ext.settings.backref = false;
    ext.enableBackrefs();
    assert.strictEqual(document.querySelectorAll('.egov-ext-backref-btn').length, 0, '設定をオフにすると印が消える');
  });

  const annotationStoreJs = fs.readFileSync(path.join(ROOT_DIR, 'js', 'annotation_store.js'), 'utf8');

  await runAsyncTest('マーカー・メモの保存: 端末の中への保存・削除、同期の枠と長さの上限、保存先の切り替え、書き出しと読み込み', async () => {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'dangerously' });
    const window = dom.window;
    const storage = createStorageMock();
    window.chrome = { storage };
    window.eval(annotationStoreJs);
    const ext = window.egovExt;
    const LAW = '325AC0000000201';
    const mk = (id, extra) => Object.assign({ id, k: 'text', p: 'Mp-Ch_1-At_6-Pr_1', l: '第6条第1項', q: '建築物', b: '', f: '', o: 0, c: 1, m: '' }, extra || {});

    assert.strictEqual(await ext.getAnnotationMode(), 'local', '初期値は端末の中');
    assert.strictEqual((await ext.saveAnnotation(LAW, mk('a1'))).ok, true);
    assert.strictEqual((await ext.saveAnnotation(LAW, mk('a2', { c: 2, m: 'メモ' }))).ok, true);
    assert.strictEqual((await ext.loadAnnotations(LAW)).length, 2, '2件読める');
    assert(Array.isArray(storage.local.mem['egovNotes:' + LAW]), '端末の中に法令ごとの配列で置く');
    assert(!Object.keys(storage.sync.mem).some(k => k.startsWith('egovMk:')), '同期ストレージには置かない');
    await ext.saveAnnotation(LAW, mk('a2', { m: '書き直し' }));
    assert.strictEqual((await ext.loadAnnotations(LAW)).find(a => a.id === 'a2').m, '書き直し', '同じ ID は置き換える');
    await ext.removeAnnotation(LAW, 'a1');
    assert.strictEqual((await ext.loadAnnotations(LAW)).length, 1, '消せる');

    // 端末の中のメモは長くてもよいが、同期にすると500字まで
    await ext.saveAnnotation(LAW, mk('long', { m: 'あ'.repeat(600) }));
    let switched = await ext.setAnnotationMode('sync');
    assert.strictEqual(switched.ok, false, '500字を超えるメモがあると同期に切り替えない');
    assert.strictEqual(switched.reason, 'tooLong');
    assert.strictEqual(await ext.getAnnotationMode(), 'local', '切り替わっていない');
    await ext.removeAnnotation(LAW, 'long');

    switched = await ext.setAnnotationMode('sync');
    assert.strictEqual(switched.ok, true, '同期に切り替えられる');
    assert.strictEqual(await ext.getAnnotationMode(), 'sync');
    assert(storage.sync.mem['egovMk:' + LAW + ':a2'], '同期には1件ずつ別の項目で置く');
    assert(!('egovNotes:' + LAW in storage.local.mem), '移したら端末の中からは消す');
    assert.strictEqual((await ext.loadAnnotations(LAW)).length, 1, '同期から読める');
    assert.strictEqual((await ext.saveAnnotation(LAW, mk('a3', { m: 'い'.repeat(501) }))).reason, 'tooLong', '同期のときは501字のメモを保存しない');

    // 同期の枠を超えると保存しない
    ext.ANNOTATION_SYNC_MAX_ITEMS = 2;
    assert.strictEqual((await ext.saveAnnotation(LAW, mk('a3'))).ok, true);
    assert.strictEqual((await ext.saveAnnotation(LAW, mk('a4'))).reason, 'full', '件数の枠を超えたら full');
    ext.ANNOTATION_SYNC_MAX_ITEMS = 180;
    const usage = await ext.getAnnotationSyncUsage();
    assert.strictEqual(usage.items, 2);
    assert(usage.bytes > 0 && usage.bytes === Object.keys(storage.sync.mem).filter(k => k.startsWith('egovMk:'))
      .reduce((sum, k) => sum + ext.annotationByteSize(k, storage.sync.mem[k]), 0), '使用量はキーと値の UTF-8 バイト数の合計');
    assert.strictEqual(ext.annotationByteSize('k', 'あ'), 1 + 5, '日本語は1文字3バイトで数える（"あ" は5バイト）');

    // 書き出し → 端末の中に戻す → 読み込み（同じ ID は直した日時の新しいほう）
    const exported = await ext.exportAnnotations();
    assert.strictEqual(exported.format, 'egov-himotoki-annotations');
    assert.strictEqual(exported.laws[LAW].length, 2);
    assert.strictEqual((await ext.setAnnotationMode('local')).ok, true, '端末の中に戻せる');
    assert(!Object.keys(storage.sync.mem).some(k => k.startsWith('egovMk:')), '戻したら同期からは消す');
    await ext.removeAnnotation(LAW, 'a3');
    const old = JSON.parse(JSON.stringify(exported));
    old.laws[LAW].forEach(a => { a.u = 1; a.m = '古い'; });
    const imported = await ext.importAnnotations(old);
    assert.strictEqual(imported.ok, true);
    assert.strictEqual(imported.added, 1, '消したものは戻る');
    assert.strictEqual(imported.updated, 0, '手元のほうが新しいものは置き換えない');
    assert.strictEqual((await ext.importAnnotations({ hello: 1 })).reason, 'format', '別の形のファイルは読まない');
  });

  await runAsyncTest('マーカー・メモの一覧: 条項の順に並べ、漢数字・全角を同じに扱って検索し、色・種類で絞り込む。法令名は書き出し・読み込みで引き継ぐ', async () => {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'dangerously' });
    const window = dom.window;
    const storage = createStorageMock();
    window.chrome = { storage };
    window.eval(annotationStoreJs);
    window.eval(fs.readFileSync(path.join(ROOT_DIR, 'js', 'notes.js'), 'utf8'));
    const ext = window.egovExt;
    const n = ext._testNotes;

    const ids = ['Mp-Ch_1-At_7-Pr_1', 'Mp-Ch_1-At_6-Pr_2', 'Mp-Ch_1-At_6_2-Pr_1', 'Mp-Ch_1-At_6-Pr_1-It_2', '325AC0000000201-Sp-At_1-Pr_1', 'Mp-Ch_1-At_6-Pr_1'];
    const sorted = ids.slice().sort((a, b) => n.compareKeys(n.provisionOrderKey(a), n.provisionOrderKey(b)));
    assert.strictEqual(sorted.join(' '), 'Mp-Ch_1-At_6-Pr_1 Mp-Ch_1-At_6-Pr_1-It_2 Mp-Ch_1-At_6-Pr_2 Mp-Ch_1-At_6_2-Pr_1 Mp-Ch_1-At_7-Pr_1 325AC0000000201-Sp-At_1-Pr_1', '条・項・号の順、第6条の2は第6条の後、附則は最後');

    assert.strictEqual(ext.normalizeForSearch('第七十七条の３５　ＡＢＣ'), '第77条の35abc', '漢数字・全角数字・全角英字・空白をそろえる');
    const law = { title: '建築基準法', lawNum: '昭和二十五年法律第二百一号' };
    const marker = { k: 'text', c: 2, q: '第７７条の３５', l: '第6条第2項', m: '準防火地域に注意' };
    const note = { k: 'provision', c: 1, q: '', l: '第7条第1項', m: '' };
    const st = (query, filter, memoOnly) => ({ normalizedQuery: ext.normalizeForSearch(query || ''), filter: filter || 'all', memoOnly: !!memoOnly });
    assert(n.matches(marker, law, st('第七十七条')), '漢数字で探しても、全角数字で覚えた語句に当たる');
    assert(n.matches(marker, law, st('第6条')), '条項の名前で当たる');
    assert(n.matches(marker, law, st('建築基準')), '法令名で当たる');
    assert(n.matches(marker, law, st('準防火')), 'メモで当たる');
    assert(n.matches(note, law, st('第二百一号')), '法令番号で当たる（漢数字のまま）');
    assert(!n.matches(marker, law, st('民法')), '当たらない語');
    assert(n.matches(marker, law, st('', 'c2')) && !n.matches(marker, law, st('', 'c1')), '色で絞り込む');
    assert(n.matches(note, law, st('', 'provision')) && !n.matches(marker, law, st('', 'provision')), '項・号へのメモだけに絞り込む');
    assert(!n.matches(note, law, st('', 'all', true)), 'メモがあるものだけ');

    assert.strictEqual(ext.describeLawId('325AC0000000201'), '昭和25年法律第201号', '法令名が分からないときは法令IDから法令番号を組み立てる');
    assert.strictEqual(ext.describeLawId('506CO0000000012'), '令和6年政令第12号');
    assert(ext.describeLawId('415M60000400057').startsWith('法令ID'), '組み立てられない形は法令IDのまま');

    await ext.rememberLawTitle('325AC0000000201', '建築基準法', '昭和二十五年法律第二百一号');
    await ext.saveAnnotation('325AC0000000201', { id: 'x1', k: 'text', p: 'Mp-Ch_1-At_6-Pr_1', l: '第6条第1項', q: '建築物', c: 1, m: '' });
    const exported = await ext.exportAnnotations();
    assert.strictEqual(exported.titles['325AC0000000201'].t, '建築基準法', '書き出しに法令名を添える');
    // 別の端末を想定して空にしてから読み込む
    Object.keys(storage.local.mem).forEach(k => delete storage.local.mem[k]);
    assert.strictEqual(Object.keys(await ext.getLawTitles()).length, 0);
    await ext.importAnnotations(exported);
    assert.strictEqual((await ext.getLawTitles())['325AC0000000201'].t, '建築基準法', '読み込むと法令名も覚える');
  });

  runTest('マーカー・メモの照合: 漢数字と算用数字の違い・空白をそろえて見つけ直し、同じ語句が2つあれば前後で選ぶ', () => {
    const html = `<!DOCTYPE html><html><body><div id="provisionview">
      <div id="Mp-Ch_1-At_6-Pr_1" class="paragraph"><div class="istitle"><span class="paragraphtitle">第六条　</span><button class="egov-ext-backref-btn">↩3</button>
        <p class="sentence">建築主は、第７７条の３５の規定により、<span class="egov-ext-dimmed-text">（建築物を除く。）</span>建築物を建築する。</p></div></div>
      <div id="Mp-Ch_1-At_6-Pr_2" class="paragraph"><div class="istitle"><span class="paragraphtitle">２　</span>
        <p class="sentence">前項の規定は、適用しない。</p></div></div>
    </div></body></html>`;
    const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://laws.e-gov.go.jp/law/325AC0000000201' });
    const window = dom.window;
    const document = window.document;
    window.chrome = { storage: createStorageMock(), runtime: { onMessage: { addListener() {} } } };
    window.eval(settingsJs);
    window.eval(utilsJsForFavorites);
    window.eval(fs.readFileSync(path.join(ROOT_DIR, 'js', 'backref.js'), 'utf8'));
    window.eval(annotationStoreJs);
    window.eval(fs.readFileSync(path.join(ROOT_DIR, 'js', 'annotations.js'), 'utf8'));
    const ext = window.egovExt;
    const t = ext._testAnnotations;

    assert.strictEqual(t.normalizeWithMap('第七十七条の三十五　の規定').norm, '第77条の35の規定', '漢数字は算用数字に、空白は除く');
    assert.strictEqual(t.normalizeWithMap('第７７条').norm, '第77条', '全角の数字は半角に');

    const pr1 = document.getElementById('Mp-Ch_1-At_6-Pr_1');
    // 覚えたときは漢数字（算用数字化の前）でも、今の本文（算用数字）で見つかる
    let range = ext.findAnnotationRange({ q: '第七十七条の三十五', b: '建築主は、', f: 'の規定' }, pr1);
    assert(range, '漢数字で覚えた語句が、算用数字の本文で見つかる');
    assert.strictEqual(range.toString(), '第７７条の３５', '本文の該当箇所に範囲が付く');

    // 「建築物」は括弧の中と外に2つある。後ろの数文字で外のほうを選ぶ
    range = ext.findAnnotationRange({ q: '建築物', b: '除く。）', f: 'を建築する' }, pr1);
    assert(range && range.startContainer.parentElement.tagName === 'P', '前後の数文字で、括弧の外の「建築物」を選ぶ');
    range = ext.findAnnotationRange({ q: '建築物', b: '（', f: 'を除く' }, pr1);
    assert(range && range.startContainer.parentElement.classList.contains('egov-ext-dimmed-text'), '括弧の中の「建築物」も選べる');

    // 拡張が足した「↩3」の文字は本文として数えない
    assert(!t.collectSegments(pr1).raw.includes('↩'), '印の文字は本文に含めない');

    // 描いたときに見つからないものは記録する
    t.setState('325AC0000000201', [
      { id: 'ok', k: 'text', p: 'Mp-Ch_1-At_6-Pr_2', q: '前項', b: '', f: 'の規定', c: 1, m: '' },
      { id: 'changed', k: 'text', p: 'Mp-Ch_1-At_6-Pr_2', q: '削られた語', c: 1, m: '' },
      { id: 'missing', k: 'text', p: 'Mp-Ch_9-At_99-Pr_1', q: '何か', c: 1, m: '' },
      { id: 'note', k: 'provision', p: 'Mp-Ch_1-At_6-Pr_2', l: '第6条第2項', q: '', c: 1, m: '要確認' }
    ]);
    t.render();
    const orphans = t.getOrphans();
    assert.strictEqual(orphans.get('changed'), 'changed', '語句が見つからないものは changed');
    assert.strictEqual(orphans.get('missing'), 'missing', '条・項・号が無いものは missing');
    assert(!orphans.has('ok') && !orphans.has('note'), '見つかったものは記録しない');
    const flag = document.querySelector('#Mp-Ch_1-At_6-Pr_2 .egov-ext-note-flag');
    assert(flag, '項へのメモは番号の横に付箋の印を置く');
    assert(flag.title.includes('要確認'), '付箋にマウスを乗せるとメモの中身が出る');
    ext.disableAnnotations();
    assert(!document.querySelector('.egov-ext-note-flag'), 'オフにすると付箋が消える');
  });

  runTest('ポップアップの法令名検索: 名前がそのもの・前方一致・法律を上に、廃止を下に並べる', () => {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'dangerously' });
    const window = dom.window;
    window.eval(fs.readFileSync(path.join(ROOT_DIR, 'js', 'popup.js'), 'utf8'));
    const { toSearchItem, rankSearchItems } = window.egovExt._testPopup;
    const law = (id, title, type, extra = {}) => ({
      law_info: { law_id: id, law_type: type, law_num: '' },
      revision_info: Object.assign({ law_title: title, repeal_status: 'None', abbrev: null }, extra)
    });
    const raw = [
      law('A1', '民法の一部を改正する法律の施行に伴う関係政令の整備に関する政令', 'CabinetOrder'),
      law('A2', '民法施行法', 'Act'),
      law('A3', '旧民法', 'Act', { repeal_status: 'Repeal' }),
      law('A4', '民法', 'Act'),
      law('A5', '電子消費者契約に関する民法の特例に関する法律', 'Act', { abbrev: '電子契約法,電子消費者契約法' })
    ];
    const ranked = rankSearchItems(raw.map(toSearchItem), '民法');
    assert.strictEqual(ranked.map(i => i.lawId).join(','), 'A4,A2,A1,A5,A3');
    assert.strictEqual(ranked[4].repealLabel, '廃止', '廃止の法令には印が付く');

    const byAbbrev = rankSearchItems(raw.map(toSearchItem), '電子契約法');
    assert.strictEqual(byAbbrev[0].lawId, 'A5', '略称がそのものなら先頭');
  });

  await runAsyncTest('ポップアップの検索の履歴: 新しい順・同じ語は先頭へ・件数の上限・1件ずつ消せる（local に保存）', async () => {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'dangerously' });
    const window = dom.window;
    const storage = createStorageMock();
    window.chrome = { storage };
    window.eval(fs.readFileSync(path.join(ROOT_DIR, 'js', 'popup.js'), 'utf8'));
    const { loadSearchHistory, addSearchHistory, removeSearchHistory, HISTORY_MAX } = window.egovExt._testPopup;

    await addSearchHistory('民法');
    await addSearchHistory('地自法');
    await addSearchHistory('  民法 ');
    await addSearchHistory('   ');
    assert.strictEqual((await loadSearchHistory()).join(','), '民法,地自法', '同じ語は先頭へ移り、空の語は残さない');

    for (let i = 0; i < HISTORY_MAX + 5; i++) await addSearchHistory('語' + i);
    assert.strictEqual((await loadSearchHistory()).length, HISTORY_MAX, `履歴は ${HISTORY_MAX} 件まで`);

    await removeSearchHistory('語' + (HISTORY_MAX + 4));
    const list = await loadSearchHistory();
    assert(!list.includes('語' + (HISTORY_MAX + 4)), '指定した語が消える');
    assert(Array.isArray(storage.local.mem.egovSearchHistory), 'chrome.storage.local に保存される');
    assert(!('egovSearchHistory' in storage.sync.mem), '同期ストレージには置かない');
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

  runTest('css/style.css 内のツールチップ z-index がヘッダーコンテナ（右上の切り替えボタン・お気に入り・条文ジャンプ）より前面に設定されていること', () => {
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
  // 4. ダークモード整合性検証 (Material 3 Dark Theme)
  // =============================================================================
  console.log('\n--- 4. ダークモード整合性検証 (Material 3 Dark Theme) ---');

  runTest('popup.html および options.html の head に <meta name="color-scheme" content="light dark"> が設定されていること', () => {
    const popupHtml = fs.readFileSync(path.join(ROOT_DIR, 'popup.html'), 'utf8');
    const optionsHtml = fs.readFileSync(path.join(ROOT_DIR, 'options.html'), 'utf8');

    assert(popupHtml.includes('<meta name="color-scheme" content="light dark">'), 'popup.html に color-scheme meta が存在する');
    assert(optionsHtml.includes('<meta name="color-scheme" content="light dark">'), 'options.html に color-scheme meta が存在する');
  });

  runTest('css/popup.css および css/options.css に color-scheme 宣言およびダークモードメディアクエリが定義されていること', () => {
    const popupCss = fs.readFileSync(path.join(ROOT_DIR, 'css', 'popup.css'), 'utf8');
    const optionsCss = fs.readFileSync(path.join(ROOT_DIR, 'css', 'options.css'), 'utf8');

    // color-scheme: light dark
    assert(popupCss.includes('color-scheme: light dark;'), 'css/popup.css に color-scheme: light dark 宣言が存在する');
    assert(optionsCss.includes('color-scheme: light dark;'), 'css/options.css に color-scheme: light dark 宣言が存在する');

    // @media (prefers-color-scheme: dark)
    assert(popupCss.includes('@media (prefers-color-scheme: dark)'), 'css/popup.css に prefers-color-scheme: dark が存在する');
    assert(optionsCss.includes('@media (prefers-color-scheme: dark)'), 'css/options.css に prefers-color-scheme: dark が存在する');

    // テスト・手動用セレクタ :root[data-theme="dark"]
    assert(popupCss.includes(':root[data-theme="dark"]'), 'css/popup.css に :root[data-theme="dark"] が存在する');
    assert(optionsCss.includes(':root[data-theme="dark"]'), 'css/options.css に :root[data-theme="dark"] が存在する');

    // ダークトークン (#191c20, #22262b, #a8c7fa)
    assert(popupCss.includes('--md-sys-color-background: #191c20;'), 'css/popup.css にダーク背景色 #191c20 が存在する');
    assert(popupCss.includes('--md-sys-color-primary: #a8c7fa;'), 'css/popup.css にダークアクセント #a8c7fa が存在する');
    assert(optionsCss.includes('--md-sys-color-background: #191c20;'), 'css/options.css にダーク背景色 #191c20 が存在する');
    assert(optionsCss.includes('--md-sys-color-primary: #a8c7fa;'), 'css/options.css にダークアクセント #a8c7fa が存在する');

    // M3スイッチのダーク用チェックマーク反転 (ライトブルー #a8c7fa)
    assert(popupCss.includes('stroke="%23a8c7fa"'), 'css/popup.css のスイッチチェックマークにダーク反転色 %23a8c7fa が定義されている');
    assert(optionsCss.includes('stroke="%23a8c7fa"'), 'css/options.css のスイッチチェックマークにダーク反転色 %23a8c7fa が定義されている');
  });

  // =============================================================================
  // 5. 印刷スタイル (@media print) 検証
  // =============================================================================
  console.log('\n--- 5. 印刷スタイル (@media print) ---');

  runTest('@media print 内で自作UI要素が完全非表示 (display: none !important) になっていること', () => {
    const styleCss = fs.readFileSync(path.join(ROOT_DIR, 'css', 'style.css'), 'utf8');
    const printMatch = styleCss.match(/@media\s+print\s*\{([\s\S]*?)\n\}/);
    assert(printMatch, '@media print ブロックが存在する');
    const printContent = printMatch[1];

    const requiredHiddenSelectors = [
      '.egov-ext-header-container',
      '.egov-ext-quick-toggles',
      '.egov-ext-fav-btn',
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
  // 6. 配布ZIPパッケージ健全性検証
  // =============================================================================
  console.log('\n--- 6. 配布ZIPパッケージ健全性 ---');

  const zipPath = path.join(ROOT_DIR, 'e-gov-layout-changes.zip');

  // 配布ZIPは gitignore 対象の成果物なので、clone 直後の環境には存在しない。
  // ZIP がある場合（npm run package 実行後）だけ中身を検証する。
  // Firefox 用ZIPの検証（後述）と同じ扱い。
  if (fs.existsSync(zipPath)) {
    runTest('配布パッケージ e-gov-layout-changes.zip のサイズ確認', () => {
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
        'notes.html',
        'js/notes.js',
        'css/notes.css',
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
  } else {
    console.log('  - e-gov-layout-changes.zip が無いため配布ZIPの検証をスキップ（npm run package で生成すると検証されます）');
  }

  // =============================================================================
  // 6. Firefox アドオン互換性およびパッケージ健全性テスト
  // =============================================================================
  console.log('\n--- 6. Firefox アドオン互換性およびパッケージ健全性 ---');

  const firefoxManifestPath = path.join(ROOT_DIR, 'manifest.firefox.json');
  const firefoxZipPath = path.join(ROOT_DIR, 'e-gov-layout-changes-firefox.zip');

  runTest('manifest.firefox.json が存在し、構文が正しいJSONであること', () => {
    assert(fs.existsSync(firefoxManifestPath), 'manifest.firefox.json が存在する');
    const content = fs.readFileSync(firefoxManifestPath, 'utf8');
    const ffManifest = JSON.parse(content);
    assert.strictEqual(ffManifest.manifest_version, 3, 'manifest_version は 3 であること');
    assert.strictEqual(ffManifest.version, manifest.version, 'Firefox manifestのバージョンが通常manifestと一致すること');
  });

  runTest('manifest.firefox.json に Gecko ID・strict_min_version・データ収集の宣言が正しく定義されていること', () => {
    const ffManifest = JSON.parse(fs.readFileSync(firefoxManifestPath, 'utf8'));
    assert(ffManifest.browser_specific_settings, 'browser_specific_settings が定義されていること');
    assert(ffManifest.browser_specific_settings.gecko, 'gecko 設定が定義されていること');
    assert.strictEqual(ffManifest.browser_specific_settings.gecko.id, 'egov-himotoki@efukan.jp', 'Gecko IDが設定されていること');
    // データ収集の宣言（data_collection_permissions）が効くのは Firefox 140 以降
    assert.strictEqual(ffManifest.browser_specific_settings.gecko.strict_min_version, '140.0', 'strict_min_version が 140.0 であること');
    // e-Gov の API へ送るもの: 表示中の法令の法令ID・条文ID（websiteContent）と、法令名検索で入力した語（searchTerms）
    assert.deepStrictEqual(ffManifest.browser_specific_settings.gecko.data_collection_permissions, { required: ['websiteContent', 'searchTerms'] }, 'データ収集の宣言が websiteContent と searchTerms であること');
  });

  runTest('manifest.firefox.json の background が scripts 配列形式（Event Page）であること', () => {
    const ffManifest = JSON.parse(fs.readFileSync(firefoxManifestPath, 'utf8'));
    assert(ffManifest.background, 'background が定義されていること');
    assert(Array.isArray(ffManifest.background.scripts), 'background.scripts が配列であること');
    assert(ffManifest.background.scripts.includes('js/background.js'), 'js/background.js が含まれていること');
  });

  if (fs.existsSync(firefoxZipPath)) {
    runTest('e-gov-layout-changes-firefox.zip 内の manifest.json が Firefox 仕様に準拠していること', () => {
      const manifestInZip = execSync(`unzip -p "${firefoxZipPath}" manifest.json`, { encoding: 'utf8' });
      const parsedInZip = JSON.parse(manifestInZip);
      assert.strictEqual(parsedInZip.browser_specific_settings?.gecko?.id, 'egov-himotoki@efukan.jp');
      assert.strictEqual(parsedInZip.browser_specific_settings?.gecko?.strict_min_version, '140.0');
      assert.deepStrictEqual(parsedInZip.browser_specific_settings?.gecko?.data_collection_permissions, { required: ['websiteContent', 'searchTerms'] });
      assert(Array.isArray(parsedInZip.background?.scripts));
    });

    runTest('e-gov-layout-changes-firefox.zip に全必須ファイルが含まれ不要ファイルが混入していないこと', () => {
      const zipFileList = execSync(`unzip -l "${firefoxZipPath}"`, { encoding: 'utf8' });
      assert(zipFileList.includes('manifest.json'));
      assert(zipFileList.includes('popup.html'));
      assert(zipFileList.includes('options.html'));
      assert(zipFileList.includes('js/content.js'));
      assert(zipFileList.includes('js/citation.js'));
      assert(zipFileList.includes('icons/icon128.png'));
      assert(!zipFileList.includes('node_modules'));
      assert(!zipFileList.includes('.git'));
      assert(!zipFileList.includes('scripts/'));
      assert(!zipFileList.includes('FIREFOX_ADDONS.md'));
    });
  }

  console.log(`\n======================================================`);
  console.log(`全総合健全性テスト完了: ${passedTests}/${totalTests} PASS (100%)`);
  console.log(`======================================================\n`);
}

main().catch(err => {
  console.error('Fatal integrity test error:', err);
  process.exit(1);
});

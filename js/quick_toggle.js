/**
 * quick_toggle.js
 *
 * 条文ページ右上（お気に入りボタンの左隣）に置く、表示の切り替えボタンの組。
 * 算用数字・括弧の薄字化・接続詞の色分け・定義語の下線と、被引用・同じ法令の中の参照元の表示を、
 * 設定画面を開かずにその場でオン・オフする。
 * 設定「切り替えボタン」（quickToggle）でボタンの組ごと出さないようにできる。
 * あわせて、右上の並びの右端に、法令名検索（ツールバーのポップアップ）を開く虫眼鏡と、設定画面を開く歯車を置く
 * （こちらは設定に関わらず、条文ページなら出す）。
 *
 * 押したときは、ポップアップから切り替えたときと同じく設定を保存し、content.js の applySettings() で
 * 全機能を掛け直す（切り替えの経路を2つに分けない）。
 */

window.egovExt = window.egovExt || {};

(function(ext) {

  const GROUP_ID = 'egov-ext-quick-toggles';

  /**
   * 並べる機能。key は DEFAULT_SETTINGS のキー。groupStart の前には細い仕切りを入れる
   * （表示を整える4つと、引用・参照のつながりを見せる2つを分ける）。
   * secondary の付いたもの（と、その前の仕切り）は、画面の幅が足りないときに先に隠す
   * @type {ReadonlyArray<{key: string, label: string, name: string, groupStart?: boolean, secondary?: boolean}>}
   */
  ext.QUICK_TOGGLE_ITEMS = Object.freeze([
    { key: 'horizontal', label: '算用数字', name: '横書き数字変換（漢数字を算用数字に）' },
    { key: 'dim', label: '括弧', name: '括弧書きの薄字化' },
    { key: 'conjunction', label: '接続詞', name: '接続詞の色分け' },
    { key: 'definition', label: '定義語', name: '定義語の下線とホバー辞書' },
    { key: 'citation', label: '被引用', name: '被引用（他の法令からの引用）の「引用」ボタン', groupStart: true, secondary: true },
    { key: 'backref', label: '参照元', name: '同じ法令の中の参照元（番号の横の「↩」）', secondary: true }
  ]);

  /**
   * ボタンの見た目（オン・オフ）を今の設定に合わせる
   * @param {HTMLElement} group
   */
  function renderGroup(group) {
    group.querySelectorAll('.egov-ext-quick-btn').forEach(btn => {
      const item = ext.QUICK_TOGGLE_ITEMS.find(i => i.key === btn.dataset.key);
      const on = !!(ext.settings && ext.settings[btn.dataset.key]);
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.title = `${item ? item.name : ''}：${on ? 'オン（押すとオフ）' : 'オフ（押すとオン）'}`;
    });
  }

  /**
   * ボタンが押されたら、その機能を切り替えて保存し、全機能を掛け直す
   * @param {MouseEvent} e
   */
  async function handleClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const key = e.currentTarget.dataset.key;
    if (!key || !ext.settings) return;
    ext.settings = Object.assign({}, ext.settings, { [key]: !ext.settings[key] });
    const group = document.getElementById(GROUP_ID);
    if (group) renderGroup(group);
    if (ext.saveSettings) await ext.saveSettings(ext.settings);
    if (ext.applySettings) ext.applySettings();
  }

  /**
   * 切り替えボタンの組を置く（既にあれば見た目を今の設定に合わせるだけ）。
   * お気に入りボタンか条文ジャンプ検索があれば、その左隣に置く
   */
  ext.setupQuickToggles = function() {
    if (!ext.settings || !ext.settings.global || !ext.settings.quickToggle
        || !(ext.checkIfLawPage && ext.checkIfLawPage())) {
      ext.removeQuickToggles();
      return;
    }

    let group = document.getElementById(GROUP_ID);
    if (!group || !document.body.contains(group)) {
      group = document.createElement('div');
      group.id = GROUP_ID;
      group.className = 'egov-ext-quick-toggles';
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', '表示の切り替え');

      ext.QUICK_TOGGLE_ITEMS.forEach(item => {
        if (item.groupStart) {
          const sep = document.createElement('span');
          sep.className = 'egov-ext-quick-sep' + (item.secondary ? ' egov-ext-quick-secondary' : '');
          sep.setAttribute('aria-hidden', 'true');
          group.appendChild(sep);
        }
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'egov-ext-quick-btn' + (item.secondary ? ' egov-ext-quick-secondary' : '');
        btn.dataset.key = item.key;
        const dot = document.createElement('span');
        dot.className = 'egov-ext-quick-dot';
        dot.setAttribute('aria-hidden', 'true');
        btn.appendChild(dot);
        btn.appendChild(document.createTextNode(item.label));
        btn.addEventListener('click', handleClick);
        group.appendChild(btn);
      });

      const headerContainer = ext.getOrCreateHeaderContainer();
      const next = document.getElementById('egov-ext-fav-btn') || document.getElementById('egov-ext-jump-container');
      if (next && next.parentNode === headerContainer) {
        headerContainer.insertBefore(group, next);
      } else {
        headerContainer.appendChild(group);
      }
    }
    renderGroup(group);
  };

  const SETTINGS_BUTTON_ID = 'egov-ext-settings-btn';

  const GEAR_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
    + '<circle cx="12" cy="12" r="3"/>'
    + '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'
    + '</svg>';

  const SEARCH_BUTTON_ID = 'egov-ext-search-btn';

  const SEARCH_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
    + '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';

  /**
   * 右上の並びの右端に置く、丸いアイコンのボタンを作る。押すと background.js へ依頼を送る
   * （content script からは設定画面もポップアップも直接開けない）
   * @param {string} id
   * @param {string} className
   * @param {string} label - title と読み上げ用の名前
   * @param {string} svg
   * @param {string} messageType - background.js へ送る依頼の種類
   * @returns {HTMLButtonElement}
   */
  function createRoundButton(id, className, label, svg, messageType) {
    const btn = document.createElement('button');
    btn.id = id;
    btn.type = 'button';
    btn.className = 'egov-ext-round-btn ' + className;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.innerHTML = svg;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        const sent = chrome.runtime.sendMessage({ type: messageType });
        if (sent && sent.catch) sent.catch(() => {});
      } catch (err) {
        console.debug('egov-ext: 依頼を送れませんでした:', messageType, err);
      }
    });
    return btn;
  }

  /**
   * 右上の並びの右端に、法令名検索（ツールバーのポップアップ）を開く虫眼鏡と、設定画面を開く歯車を置く。
   * 並びの右端に来るよう CSS の order で後ろに回すので、DOM の中の位置は問わない。設定に関わらず、条文ページなら出す
   */
  ext.setupSettingsButton = function() {
    if (!ext.settings || !ext.settings.global || !(ext.checkIfLawPage && ext.checkIfLawPage())) {
      ext.removeSettingsButton();
      return;
    }
    const container = ext.getOrCreateHeaderContainer();
    const search = document.getElementById(SEARCH_BUTTON_ID);
    if (!search || !document.body.contains(search)) {
      container.appendChild(createRoundButton(SEARCH_BUTTON_ID, 'egov-ext-search-btn',
        '法令名で検索（拡張機能のポップアップを開く）', SEARCH_SVG, 'OPEN_LAW_SEARCH'));
    }
    const gear = document.getElementById(SETTINGS_BUTTON_ID);
    if (!gear || !document.body.contains(gear)) {
      container.appendChild(createRoundButton(SETTINGS_BUTTON_ID, 'egov-ext-settings-btn',
        'e-Gov法令ひもときの設定を開く', GEAR_SVG, 'OPEN_OPTIONS_PAGE'));
    }
  };

  /**
   * 虫眼鏡と歯車のボタンをDOMから取り除く
   */
  ext.removeSettingsButton = function() {
    [SEARCH_BUTTON_ID, SETTINGS_BUTTON_ID].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.remove();
    });
    if (ext.checkAndRemoveHeaderContainer) ext.checkAndRemoveHeaderContainer();
  };

  /**
   * 切り替えボタンの組をDOMから取り除く
   */
  ext.removeQuickToggles = function() {
    const group = document.getElementById(GROUP_ID);
    if (group) group.remove();
    if (ext.checkAndRemoveHeaderContainer) ext.checkAndRemoveHeaderContainer();
  };

})(window.egovExt);

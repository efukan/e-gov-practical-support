/**
 * quick_toggle.js
 *
 * 条文ページ右上（お気に入りボタンの左隣）に置く、表示の切り替えボタンの組。
 * 算用数字・括弧の薄字化・接続詞の色分け・定義語の下線を、設定画面を開かずにその場でオン・オフする。
 * 設定「切り替えボタン」（quickToggle）でボタンの組ごと出さないようにできる。
 *
 * 押したときは、ポップアップから切り替えたときと同じく設定を保存し、content.js の applySettings() で
 * 全機能を掛け直す（切り替えの経路を2つに分けない）。
 */

window.egovExt = window.egovExt || {};

(function(ext) {

  const GROUP_ID = 'egov-ext-quick-toggles';

  /**
   * 並べる機能。key は DEFAULT_SETTINGS のキー
   * @type {ReadonlyArray<{key: string, label: string, name: string}>}
   */
  ext.QUICK_TOGGLE_ITEMS = Object.freeze([
    { key: 'horizontal', label: '算用数字', name: '横書き数字変換（漢数字を算用数字に）' },
    { key: 'dim', label: '括弧', name: '括弧書きの薄字化' },
    { key: 'conjunction', label: '接続詞', name: '接続詞の色分け' },
    { key: 'definition', label: '定義語', name: '定義語の下線とホバー辞書' }
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
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'egov-ext-quick-btn';
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

  /**
   * 切り替えボタンの組をDOMから取り除く
   */
  ext.removeQuickToggles = function() {
    const group = document.getElementById(GROUP_ID);
    if (group) group.remove();
    if (ext.checkAndRemoveHeaderContainer) ext.checkAndRemoveHeaderContainer();
  };

})(window.egovExt);

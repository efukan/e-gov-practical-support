/**
 * settings.js
 *
 * 拡張機能の設定に関する唯一の情報源（single source of truth）。
 * content script・popup・options ページのすべてから読み込まれる。
 *
 * - DEFAULT_SETTINGS : 全機能のデフォルト値
 * - loadSettings()   : chrome.storage.sync から読み込み、デフォルト値とマージして返す
 * - saveSettings()   : chrome.storage.sync へ保存する
 * - initSettingsUI() : popup.html / options.html 共通のトグルUI初期化
 */

window.egovExt = window.egovExt || {};

(function(ext) {
  /**
   * 設定の保存先となる chrome.storage.sync のキー名
   * @type {string}
   */
  ext.SETTINGS_STORAGE_KEY = 'egovSettings';

  /**
   * 全機能のデフォルト値。すべて true（オン）。
   * 機能を追加する場合はここだけを変更すればよい。
   * @type {Readonly<Object<string, boolean>>}
   */
  ext.DEFAULT_SETTINGS = Object.freeze({
    global: true,
    scrollspy: true,
    popup: true,
    definition: true,
    newtab: true,
    dim: true,
    jump: true,
    horizontal: true,
    fastrender: true,
    citation: true
  });

  /**
   * 保存済みの設定を読み込み、デフォルト値にマージした新しいオブジェクトを返す。
   * 読み込みに失敗した場合はデフォルト値のコピーを返す。
   * @returns {Promise<Object<string, boolean>>}
   */
  ext.loadSettings = async function() {
    const defaults = Object.assign({}, ext.DEFAULT_SETTINGS);
    try {
      const result = await chrome.storage.sync.get(ext.SETTINGS_STORAGE_KEY);
      const stored = result && result[ext.SETTINGS_STORAGE_KEY];
      if (stored) {
        // デフォルトをベースにマージし、新機能追加時の undefined を防ぐ
        return Object.assign(defaults, stored);
      }
    } catch (e) {
      console.error('egov-ext: 設定の読み込みに失敗しました。デフォルト値を使用します:', e);
    }
    return defaults;
  };

  /**
   * 設定を chrome.storage.sync へ保存する
   * @param {Object<string, boolean>} settings - 保存する設定オブジェクト
   * @returns {Promise<void>}
   */
  ext.saveSettings = async function(settings) {
    try {
      await chrome.storage.sync.set({ [ext.SETTINGS_STORAGE_KEY]: settings });
    } catch (e) {
      console.error('egov-ext: 設定の保存に失敗しました:', e);
    }
  };

  /**
   * popup.html / options.html 共通のトグルUIを初期化する。
   * DEFAULT_SETTINGS の各キーに対応する `#feature-<キー>` のチェックボックスを自動で束ねる。
   *
   * @param {Object} [config]
   * @param {boolean} [config.allTabs=false] - true なら全タブへ、false ならアクティブタブのみへ設定変更を通知する
   * @param {boolean} [config.syncFromStorage=false] - true なら他画面での変更を storage.onChanged で逆同期する
   * @returns {Promise<void>}
   */
  ext.initSettingsUI = async function(config) {
    const { allTabs = false, syncFromStorage = false } = config || {};

    /** @type {Object<string, HTMLInputElement>} */
    const toggles = {};
    for (const key in ext.DEFAULT_SETTINGS) {
      const el = document.getElementById(`feature-${key}`);
      if (el) toggles[key] = el;
    }

    let settings = await ext.loadSettings();

    /** 現在の settings をチェックボックスへ反映する */
    function syncUI() {
      for (const key in toggles) {
        if (settings[key] !== undefined) {
          toggles[key].checked = settings[key];
        }
      }
      // グローバルスイッチが OFF のときは画面全体をグレーアウトする
      document.body.classList.toggle('global-off', !(toggles.global && toggles.global.checked));
    }

    syncUI();

    /**
     * 変更後の設定を、対象となる e-Gov タブへ通知する
     * @param {Object<string, boolean>} newSettings
     */
    async function broadcast(newSettings) {
      const message = { type: 'SETTINGS_CHANGED', settings: newSettings };
      const tabs = await chrome.tabs.query(allTabs ? {} : { active: true, currentWindow: true });
      tabs.forEach(tab => {
        // アクティブタブのみへ送る場合は、権限の都合で url が取れないことがあるため無条件で試行する
        const isEgovTab = allTabs ? (tab.url && tab.url.includes('e-gov.go.jp'))
                                  : (!tab.url || tab.url.includes('e-gov.go.jp'));
        if (isEgovTab) {
          chrome.tabs.sendMessage(tab.id, message).catch(() => {});
        }
      });
    }

    for (const key in toggles) {
      toggles[key].addEventListener('change', async (e) => {
        settings[key] = e.target.checked;
        if (key === 'global') {
          document.body.classList.toggle('global-off', !e.target.checked);
        }
        await ext.saveSettings(settings);
        await broadcast(settings);
      });
    }

    if (syncFromStorage) {
      // popup 等、他の画面で設定が変更されたことを検知してスイッチ表示を同期する
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'sync' || !changes[ext.SETTINGS_STORAGE_KEY]) return;
        const newSettings = changes[ext.SETTINGS_STORAGE_KEY].newValue;
        if (!newSettings) return;
        settings = Object.assign({}, ext.DEFAULT_SETTINGS, newSettings);
        syncUI();
      });
    }
  };

})(window.egovExt);

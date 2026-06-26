/**
 * options.js
 * 
 * 【役割】
 * 詳細設定画面（options.html）のコントロール用スクリプトです。
 * 設定状態の保存、読み込み、e-Govタブへのリアルタイム通知、
 * およびポップアップ操作による設定変更時のリアルタイム同期を担います。
 */
document.addEventListener('DOMContentLoaded', async () => {
  // 各スイッチ要素の参照
  const toggles = {
    global: document.getElementById('feature-global'),
    scrollspy: document.getElementById('feature-scrollspy'),
    popup: document.getElementById('feature-popup'),
    definition: document.getElementById('feature-definition'),
    newtab: document.getElementById('feature-newtab'),
    dim: document.getElementById('feature-dim'),
    jump: document.getElementById('feature-jump'),
    horizontal: document.getElementById('feature-horizontal'),
    fastrender: document.getElementById('feature-fastrender')
  };

  // 初期設定のデフォルト値
  const defaultSettings = {
    global: true,
    scrollspy: true,
    popup: true,
    definition: true,
    newtab: true,
    dim: true,
    jump: true,
    horizontal: true,
    fastrender: true
  };
  
  let settings = defaultSettings;
  
  // ストレージから現在の設定を読み込み
  try {
    const result = await chrome.storage.sync.get('egovSettings');
    if (result && result.egovSettings) {
      settings = { ...defaultSettings, ...result.egovSettings };
    }
  } catch (e) {
    console.error("e-Gov Pro Options: 設定の取得に失敗しました:", e);
  }

  // 現在の設定状態を画面（UI）のスイッチに反映
  for (const key in toggles) {
    if (settings[key] !== undefined && toggles[key]) {
      toggles[key].checked = settings[key];
    }
  }

  // グローバルスイッチの有効・無効に合わせて画面のスタイル（グレーアウト）を更新
  function updateGlobalState() {
    if (toggles.global && toggles.global.checked) {
      document.body.classList.remove('global-off');
    } else {
      document.body.classList.add('global-off');
    }
  }

  updateGlobalState();

  // スイッチが切り替えられた時の保存とメッセージ送信イベントを登録
  for (const key in toggles) {
    if (toggles[key]) {
      toggles[key].addEventListener('change', async (e) => {
        settings[key] = e.target.checked;
        await chrome.storage.sync.set({ egovSettings: settings });
        
        if (key === 'global') {
          updateGlobalState();
        }

        // 開いているすべての e-Gov 法令検索タブに変更後の設定内容を通知する
        const tabs = await chrome.tabs.query({});
        tabs.forEach(tab => {
          // url プロパティの安全確認をした上で送信する
          const isEgovTab = tab.url && tab.url.includes('e-gov.go.jp');
          if (isEgovTab) {
            chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_CHANGED', settings }).catch(() => {});
          }
        });
      });
    }
  }

  // ポップアップ画面等、他の場所で設定が変更されたことをリアルタイムに検知してスイッチ表示を同期する
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync' && changes.egovSettings) {
      const newSettings = changes.egovSettings.newValue;
      if (newSettings) {
        settings = newSettings;
        for (const key in toggles) {
          if (settings[key] !== undefined && toggles[key]) {
            toggles[key].checked = settings[key];
          }
        }
        updateGlobalState();
      }
    }
  });

});

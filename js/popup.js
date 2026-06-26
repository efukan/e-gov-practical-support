/**
 * popup.js
 * 
 * 【役割】
 * このファイルは、拡張機能のアイコンをクリックして表示される「ポップアップ画面」の
 * 裏側で動くスクリプトです。ユーザーがスイッチを切り替えた時の動きや、設定の保存を担います。
 */
document.addEventListener('DOMContentLoaded', async () => {
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
  try {
    const result = await chrome.storage.sync.get('egovSettings');
    if (result && result.egovSettings) {
      settings = { ...defaultSettings, ...result.egovSettings };
    }
  } catch (e) {
    console.error("e-Gov Pro Popup: Storage retrieval failed, utilizing default values:", e);
  }

  // Sync state to UI
  for (const key in toggles) {
    if (settings[key] !== undefined && toggles[key]) {
      toggles[key].checked = settings[key];
    }
  }

  function updateGlobalState() {
    if (toggles.global && toggles.global.checked) {
      document.body.classList.remove('global-off');
    } else {
      document.body.classList.add('global-off');
    }
  }

  updateGlobalState();

  // Handle changes
  for (const key in toggles) {
    if (toggles[key]) {
      toggles[key].addEventListener('change', async (e) => {
        settings[key] = e.target.checked;
        await chrome.storage.sync.set({ egovSettings: settings });
        
        if (key === 'global') {
          updateGlobalState();
        }

        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs.length > 0) {
          // URLが取得できない場合（権限上の制限など）でも、安全のために無条件で送信を試みる
          const isEgovTab = !tabs[0].url || tabs[0].url.includes('e-gov.go.jp');
          if (isEgovTab) {
            chrome.tabs.sendMessage(tabs[0].id, { type: 'SETTINGS_CHANGED', settings }).catch(() => {});
          }
        }
      });
    }
  }

  // 詳細設定ページを開くボタンのバインド
  const openOptionsBtn = document.getElementById('open-options');
  if (openOptionsBtn) {
    openOptionsBtn.addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
    });
  }

});

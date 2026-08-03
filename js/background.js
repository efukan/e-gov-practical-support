/**
 * background.js
 * 
 * 【役割】
 * このファイルは「Service Worker（サービスワーカー）」としてバックグラウンドで常に待機・実行されるプログラムです。
 * 拡張機能全体のオン・オフ状態を監視し、ツールバーのアイコンをカラーまたはグレーアウトさせる処理を行います。
 */

function updateIcon(isGlobalEnabled) {
  const suffix = isGlobalEnabled ? '' : '-off';
  chrome.action.setIcon({
    path: {
      "16": `/icons/icon16${suffix}.png`,
      "48": `/icons/icon48${suffix}.png`,
      "128": `/icons/icon128${suffix}.png`
    }
  }).catch(e => console.error("Error setting icon:", e));
}

// Initial set on startup
// ブラウザ起動時の初期化処理
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.sync.get('egovSettings', (result) => {
    if (chrome.runtime.lastError) return;
    const settings = (result && result.egovSettings) || { global: true };
    updateIcon(settings.global);
  });
});

// Initial set on install/reload
// 拡張機能がインストール・更新された時の初期化処理
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get('egovSettings', (result) => {
    if (chrome.runtime.lastError) return;
    const settings = (result && result.egovSettings) || { global: true };
    updateIcon(settings.global);
  });
  // インストール/更新時の初期処理はアイコン状態の同期のみ（下の updateIcon が担当）
});

// Service Worker 起動時（スリープ復帰時含む）のアイコン状態同調
chrome.storage.sync.get('egovSettings', (result) => {
  if (chrome.runtime.lastError) return;
  const settings = (result && result.egovSettings) || { global: true };
  updateIcon(settings.global);
});

// Listen for settings changes to update the icon dynamically
// ストレージ（設定値）の変更を検知して、アイコンの表示状態を即座に更新する
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync' && changes.egovSettings) {
    const newSettings = changes.egovSettings.newValue;
    if (newSettings && typeof newSettings.global === 'boolean') {
      updateIcon(newSettings.global);
    }
  }
});

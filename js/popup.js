/**
 * popup.js
 *
 * 拡張機能のアイコンをクリックして表示されるポップアップ画面のスクリプト。
 * トグルUIの実体は js/settings.js の initSettingsUI() が担い、
 * ここではポップアップ固有の振る舞い（アクティブタブのみへの通知、詳細設定を開くボタン）だけを扱う。
 */
document.addEventListener('DOMContentLoaded', async () => {
  await window.egovExt.initSettingsUI({ allTabs: false, syncFromStorage: false });

  const openOptionsBtn = document.getElementById('open-options');
  if (openOptionsBtn) {
    openOptionsBtn.addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
    });
  }
});

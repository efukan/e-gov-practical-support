/**
 * options.js
 *
 * 詳細設定画面（options.html）のスクリプト。
 * トグルUIの実体は js/settings.js の initSettingsUI() が担い、
 * ここでは詳細設定固有の振る舞い（全タブへの通知、他画面からの変更の逆同期）だけを指定する。
 */
document.addEventListener('DOMContentLoaded', async () => {
  await window.egovExt.initSettingsUI({ allTabs: true, syncFromStorage: true });
});

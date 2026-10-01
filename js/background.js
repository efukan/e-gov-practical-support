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

/** 虫眼鏡から開いたことをポップアップに伝える chrome.storage.session のキー（値は依頼した時刻） */
const FOCUS_SEARCH_KEY = 'egovPopupFocusSearch';

/**
 * ツールバーのポップアップを、法令名検索の欄にカーソルを入れた状態で開く。
 * action.openPopup() は Chrome 127 以降で使える。開けなかったとき（古い版・Firefox の条件など）は、
 * 同じ画面（popup.html）を、条文ページの右隣の新しいタブで開く
 * @param {chrome.runtime.MessageSender} sender
 */
async function openLawSearch(sender) {
  const tab = sender.tab;
  try {
    if (chrome.storage.session) await chrome.storage.session.set({ [FOCUS_SEARCH_KEY]: Date.now() });
  } catch (e) {}
  try {
    if (!chrome.action.openPopup) throw new Error('action.openPopup is not available');
    await chrome.action.openPopup(tab && typeof tab.windowId === 'number' ? { windowId: tab.windowId } : undefined);
  } catch (e) {
    console.debug('egov-ext: ポップアップを開けなかったので、新しいタブで開きます:', e);
    try {
      if (chrome.storage.session) await chrome.storage.session.remove(FOCUS_SEARCH_KEY);
    } catch (err) {}
    const createProps = { url: chrome.runtime.getURL('popup.html?view=tab') };
    if (tab && typeof tab.index === 'number') createProps.index = tab.index + 1;
    if (tab && typeof tab.id === 'number') createProps.openerTabId = tab.id;
    chrome.tabs.create(createProps);
  }
}

// 条文ページ右上の歯車・虫眼鏡ボタン（js/quick_toggle.js）からの依頼。
// content script からは設定画面もポップアップも直接開けないので、ここで代わりに開く
chrome.runtime.onMessage.addListener((request, sender) => {
  if (!request || !sender || sender.id !== chrome.runtime.id) return; // この拡張の content script からの依頼だけ受ける
  if (request.type === 'OPEN_OPTIONS_PAGE') {
    chrome.runtime.openOptionsPage().catch(e => console.error('Error opening options page:', e));
  } else if (request.type === 'OPEN_LAW_SEARCH') {
    openLawSearch(sender);
  }
});

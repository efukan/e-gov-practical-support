/**
 * favorites.js
 *
 * 法令のお気に入り。content script とポップアップの両方から読み込まれる。
 * - 保存・読み込み（chrome.storage.local。端末内だけに置き、同期はしない）
 * - 条文ページ右上の「☆ お気に入り」ボタン（設定「お気に入りボタン」でオン・オフ。content script のみ）
 *
 * 保存するのは法令ID・法令名・法令番号・登録日時だけで、新しく登録したものを先頭に並べる。
 */

window.egovExt = window.egovExt || {};

(function(ext) {
  /**
   * お気に入りの保存先となる chrome.storage.local のキー名
   * @type {string}
   */
  ext.FAVORITES_STORAGE_KEY = 'egovFavorites';

  /**
   * 保存しておくお気に入りの上限。超えた分は古いものから外す
   * @type {number}
   */
  ext.FAVORITES_MAX = 500;

  /**
   * @typedef {Object} FavoriteLaw
   * @property {string} lawId   - 法令ID（例: 322AC0000000067）
   * @property {string} title   - 法令名（例: 地方自治法）
   * @property {string} [lawNum] - 法令番号（例: 昭和二十二年法律第六十七号）
   * @property {number} addedAt - 登録日時（ミリ秒）
   */

  /**
   * 法令IDから e-Gov法令検索の条文ページのURLを作る（その時点で施行中の版が開く）
   * @param {string} lawId
   * @returns {string}
   */
  ext.getLawPageUrl = function(lawId) {
    return 'https://laws.e-gov.go.jp/law/' + encodeURIComponent(lawId);
  };

  /**
   * 保存済みのお気に入りを返す（新しく登録したものが先頭）
   * @returns {Promise<FavoriteLaw[]>}
   */
  ext.loadFavorites = async function() {
    try {
      const result = await chrome.storage.local.get(ext.FAVORITES_STORAGE_KEY);
      const list = result && result[ext.FAVORITES_STORAGE_KEY];
      if (Array.isArray(list)) {
        return list.filter(f => f && typeof f.lawId === 'string' && f.lawId);
      }
    } catch (e) {
      console.error('egov-ext: お気に入りの読み込みに失敗しました:', e);
    }
    return [];
  };

  /**
   * お気に入りを保存する
   * @param {FavoriteLaw[]} list
   * @returns {Promise<void>}
   */
  ext.saveFavorites = async function(list) {
    try {
      await chrome.storage.local.set({ [ext.FAVORITES_STORAGE_KEY]: list.slice(0, ext.FAVORITES_MAX) });
    } catch (e) {
      console.error('egov-ext: お気に入りの保存に失敗しました:', e);
    }
  };

  /**
   * お気に入りに加える。登録済みなら法令名・法令番号だけ新しくし、並び順は変えない
   * @param {{lawId: string, title?: string, lawNum?: string}} law
   * @returns {Promise<FavoriteLaw[]>} 保存後の一覧
   */
  ext.addFavorite = async function(law) {
    const list = await ext.loadFavorites();
    const lawId = String(law.lawId).toUpperCase();
    const existing = list.find(f => f.lawId === lawId);
    if (existing) {
      if (law.title) existing.title = law.title;
      if (law.lawNum) existing.lawNum = law.lawNum;
    } else {
      list.unshift({
        lawId,
        title: law.title || lawId,
        lawNum: law.lawNum || '',
        addedAt: Date.now()
      });
    }
    await ext.saveFavorites(list);
    return list;
  };

  /**
   * お気に入りから外す
   * @param {string} lawId
   * @returns {Promise<FavoriteLaw[]>} 保存後の一覧
   */
  ext.removeFavorite = async function(lawId) {
    const id = String(lawId).toUpperCase();
    const list = (await ext.loadFavorites()).filter(f => f.lawId !== id);
    await ext.saveFavorites(list);
    return list;
  };

  // ---------------------------------------------------------------------------
  // 条文ページ右上の「☆ お気に入り」ボタン（content script 用）
  // ---------------------------------------------------------------------------

  const BUTTON_ID = 'egov-ext-fav-btn';

  const STAR_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">'
    + '<polygon points="12 2.8 14.9 8.7 21.4 9.6 16.7 14.2 17.8 20.6 12 17.6 6.2 20.6 7.3 14.2 2.6 9.6 9.1 8.7" '
    + 'stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';

  let storageListenerAdded = false;

  /**
   * 表示中の法令の名前と法令番号をページから読む。
   * 見出し（h1.title-law）が無ければタブの題名（「地方自治法 | e-Gov 法令検索」）から取る
   * @returns {{title: string, lawNum: string}}
   */
  ext.readCurrentLawInfo = function() {
    let title = '';
    let lawNum = '';
    const heading = document.querySelector('h1.title-law, .title-law');
    if (heading) {
      const numEl = heading.querySelector('.lawnumber');
      if (numEl) lawNum = numEl.textContent.trim().replace(/^[（(]|[）)]$/g, '');
      const clone = heading.cloneNode(true);
      clone.querySelectorAll('.lawnumber').forEach(n => n.remove());
      title = clone.textContent.replace(/\s+/g, ' ').trim();
    }
    if (!title) {
      title = (document.title || '').replace(/\s*[|｜]\s*e-Gov.*$/, '').trim();
    }
    return { title, lawNum };
  };

  /**
   * ボタンの見た目（登録済みかどうか）を合わせる
   * @param {HTMLButtonElement} btn
   * @param {boolean} isFavorite
   */
  function renderButtonState(btn, isFavorite) {
    btn.classList.toggle('is-favorite', isFavorite);
    btn.setAttribute('aria-pressed', isFavorite ? 'true' : 'false');
    btn.title = isFavorite
      ? 'お気に入りから外す'
      : 'この法令をお気に入りに追加（拡張機能のアイコンから開けます）';
  }

  /**
   * 保存済みの一覧を読み直して、ボタンの見た目を今の法令に合わせる
   * @returns {Promise<void>}
   */
  async function refreshFavoriteButton() {
    const btn = document.getElementById(BUTTON_ID);
    if (!btn) return;
    const lawId = btn.dataset.lawId;
    const list = await ext.loadFavorites();
    // 読み込みの間に別の法令へ移っていたら、その法令の分は後から来る呼び出しに任せる
    if (btn.dataset.lawId !== lawId) return;
    renderButtonState(btn, list.some(f => f.lawId === lawId));
  }

  /**
   * ボタンが押されたとき、登録と解除を切り替える
   * @param {MouseEvent} e
   */
  async function handleButtonClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const btn = e.currentTarget;
    const lawId = btn.dataset.lawId;
    if (!lawId) return;
    const willAdd = !btn.classList.contains('is-favorite');
    // 保存を待たずに見た目を先に変える（押した手応えを遅らせない）
    renderButtonState(btn, willAdd);
    if (willAdd) {
      const info = ext.readCurrentLawInfo();
      await ext.addFavorite({ lawId, title: info.title, lawNum: info.lawNum });
    } else {
      await ext.removeFavorite(lawId);
    }
  }

  /**
   * 条文ページ右上にお気に入りボタンを置く（既にあれば今の法令に合わせるだけ）。
   * 条文ジャンプ検索の入力欄があればその左隣に置く
   */
  ext.setupFavoriteButton = function() {
    if (!ext.settings || !ext.settings.global || !ext.settings.favorite
        || !(ext.checkIfLawPage && ext.checkIfLawPage())) {
      ext.removeFavoriteButton();
      return;
    }
    const lawId = ext.getLawIdFromUrl ? ext.getLawIdFromUrl(window.location.href) : null;
    if (!lawId) {
      ext.removeFavoriteButton();
      return;
    }

    let btn = document.getElementById(BUTTON_ID);
    if (!btn || !document.body.contains(btn)) {
      btn = document.createElement('button');
      btn.id = BUTTON_ID;
      btn.type = 'button';
      btn.className = 'egov-ext-fav-btn';
      btn.innerHTML = STAR_SVG + '<span class="egov-ext-fav-label">お気に入り</span>';
      btn.addEventListener('click', handleButtonClick);
      renderButtonState(btn, false);

      const headerContainer = ext.getOrCreateHeaderContainer();
      const jumpContainer = document.getElementById('egov-ext-jump-container');
      if (jumpContainer && jumpContainer.parentNode === headerContainer) {
        headerContainer.insertBefore(btn, jumpContainer);
      } else {
        headerContainer.appendChild(btn);
      }
    }

    if (btn.dataset.lawId !== lawId) {
      btn.dataset.lawId = lawId;
      renderButtonState(btn, false);
    }
    refreshFavoriteButton();

    // ポップアップや別タブで登録・解除されたら、見た目を合わせる
    if (!storageListenerAdded && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'local' && changes[ext.FAVORITES_STORAGE_KEY]) {
          refreshFavoriteButton();
        }
      });
      storageListenerAdded = true;
    }
  };

  /**
   * お気に入りボタンをDOMから取り除く
   */
  ext.removeFavoriteButton = function() {
    const btn = document.getElementById(BUTTON_ID);
    if (btn) btn.remove();
    if (ext.checkAndRemoveHeaderContainer) ext.checkAndRemoveHeaderContainer();
  };

})(window.egovExt);

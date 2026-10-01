/**
 * favorites.js
 *
 * 法令のお気に入り。content script とポップアップの両方から読み込まれる。
 * - 保存・読み込み（chrome.storage.sync。ブラウザの同期で他の端末にもそろう）
 * - 条文ページ右上の「☆ お気に入り追加」ボタン（設定「お気に入りボタン」でオン・オフ。content script のみ）
 *
 * 同期ストレージは1項目8KB・全体で約100KB・最大512項目までなので、一覧を1つの配列にせず、
 * 1件ずつ「egovFav:<法令ID>」のキーに分けて置く（配列だと30件ほどで1項目の上限に届くうえ、
 * 2台で同時に登録すると後から書いた方の配列で上書きされて片方が消える）。
 * 保存するのは法令名・法令番号・登録日時だけで、容量を節約するため短い名前（t/n/a）で持つ。
 */

window.egovExt = window.egovExt || {};

(function(ext) {
  /**
   * お気に入り1件ごとの chrome.storage.sync のキーの頭。後ろに法令IDを付ける
   * @type {string}
   */
  ext.FAVORITE_KEY_PREFIX = 'egovFav:';

  /**
   * お気に入りの上限。同期ストレージの容量（約100KB）と項目数（512）に余裕を残す
   * @type {number}
   */
  ext.FAVORITES_MAX = 300;

  /** 同期に切り替える前の版（未公開の開発版）が chrome.storage.local に置いていた一覧のキー */
  const LEGACY_LOCAL_KEY = 'egovFavorites';

  /**
   * @typedef {Object} FavoriteLaw
   * @property {string} lawId   - 法令ID（例: 322AC0000000067）
   * @property {string} title   - 法令名（例: 地方自治法）
   * @property {string} [lawNum] - 法令番号（例: 昭和二十二年法律第六十七号）
   * @property {number} addedAt - 登録日時（ミリ秒）
   */

  /**
   * 登録・解除の結果
   * @typedef {Object} FavoriteResult
   * @property {boolean} ok
   * @property {'full'|'quota'|'error'} [reason] - 失敗したとき。full: 上限の件数、quota: 同期ストレージの容量
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
   * 登録・解除に失敗したときの利用者向けの説明
   * @param {FavoriteResult} result
   * @returns {string}
   */
  ext.describeFavoriteError = function(result) {
    if (result && result.reason === 'full') {
      return `お気に入りは${ext.FAVORITES_MAX}件まで登録できます。使わないものを外してから登録してください`;
    }
    if (result && result.reason === 'quota') {
      return 'ブラウザの同期の保存容量がいっぱいで登録できませんでした。使わないお気に入りを外してください';
    }
    return 'お気に入りを保存できませんでした。もう一度お試しください';
  };

  /**
   * 法令IDから保存用のキーを作る
   * @param {string} lawId
   * @returns {string}
   */
  function keyOf(lawId) {
    return ext.FAVORITE_KEY_PREFIX + String(lawId).toUpperCase();
  }

  /**
   * 開発版で chrome.storage.local に置いていた一覧を、同期ストレージへ一度だけ移す
   * @type {Promise<void>|null}
   */
  let legacyMigration = null;
  function migrateLegacyFavorites() {
    if (legacyMigration) return legacyMigration;
    legacyMigration = (async () => {
      try {
        if (!chrome.storage.local) return;
        const result = await chrome.storage.local.get(LEGACY_LOCAL_KEY);
        const legacy = result && result[LEGACY_LOCAL_KEY];
        if (!Array.isArray(legacy)) return;
        const items = {};
        legacy.slice(0, ext.FAVORITES_MAX).forEach(f => {
          if (f && f.lawId) items[keyOf(f.lawId)] = { t: f.title || f.lawId, n: f.lawNum || '', a: f.addedAt || Date.now() };
        });
        if (Object.keys(items).length > 0) await chrome.storage.sync.set(items);
        await chrome.storage.local.remove(LEGACY_LOCAL_KEY);
      } catch (e) {
        console.debug('egov-ext: 以前のお気に入りの移し替えに失敗しました:', e);
      }
    })();
    return legacyMigration;
  }

  /**
   * 保存済みのお気に入りを返す（新しく登録したものが先頭）
   * @returns {Promise<FavoriteLaw[]>}
   */
  ext.loadFavorites = async function() {
    await migrateLegacyFavorites();
    try {
      const all = await chrome.storage.sync.get(null);
      return Object.keys(all || {})
        .filter(key => key.startsWith(ext.FAVORITE_KEY_PREFIX) && all[key])
        .map(key => {
          const v = all[key];
          const lawId = key.slice(ext.FAVORITE_KEY_PREFIX.length);
          return { lawId, title: v.t || lawId, lawNum: v.n || '', addedAt: v.a || 0 };
        })
        .sort((a, b) => b.addedAt - a.addedAt);
    } catch (e) {
      console.error('egov-ext: お気に入りの読み込みに失敗しました:', e);
    }
    return [];
  };

  /**
   * お気に入りに加える。登録済みなら法令名・法令番号だけ新しくし、並び順（登録日時）は変えない
   * @param {{lawId: string, title?: string, lawNum?: string}} law
   * @returns {Promise<FavoriteResult>}
   */
  ext.addFavorite = async function(law) {
    const key = keyOf(law.lawId);
    try {
      const result = await chrome.storage.sync.get(key);
      const current = result && result[key];
      if (!current) {
        const list = await ext.loadFavorites();
        if (list.length >= ext.FAVORITES_MAX) return { ok: false, reason: 'full' };
      }
      await chrome.storage.sync.set({
        [key]: {
          t: law.title || (current && current.t) || String(law.lawId).toUpperCase(),
          n: law.lawNum || (current && current.n) || '',
          a: current && current.a ? current.a : Date.now()
        }
      });
      return { ok: true };
    } catch (e) {
      const quota = /quota/i.test(String(e && e.message));
      // 容量の不足は画面で知らせるので、拡張機能の管理画面の「エラー」には積まない
      (quota ? console.debug : console.error)('egov-ext: お気に入りの保存に失敗しました:', e);
      return { ok: false, reason: quota ? 'quota' : 'error' };
    }
  };

  /**
   * お気に入りから外す
   * @param {string} lawId
   * @returns {Promise<FavoriteResult>}
   */
  ext.removeFavorite = async function(lawId) {
    try {
      await chrome.storage.sync.remove(keyOf(lawId));
      return { ok: true };
    } catch (e) {
      console.error('egov-ext: お気に入りの削除に失敗しました:', e);
      return { ok: false, reason: 'error' };
    }
  };

  /**
   * storage.onChanged の変更の中に、お気に入りの登録・解除が含まれているか
   * @param {Object} changes
   * @param {string} areaName
   * @returns {boolean}
   */
  ext.isFavoritesChange = function(changes, areaName) {
    return areaName === 'sync' && Object.keys(changes || {}).some(key => key.startsWith(ext.FAVORITE_KEY_PREFIX));
  };

  // ---------------------------------------------------------------------------
  // 条文ページ右上の「☆ お気に入り追加」ボタン（content script 用）
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
    // 色だけでなく文言でも登録済みかどうかが分かるようにする
    const label = btn.querySelector('.egov-ext-fav-label');
    if (label && !btn.classList.contains('has-error')) {
      label.textContent = isFavorite ? 'お気に入り済み' : 'お気に入り追加';
    }
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
    // 保存を待たずに見た目を先に変える（押した手応えを遅らせない）。登録したときは星を一度弾ませる
    renderButtonState(btn, willAdd);
    btn.classList.remove('is-popping');
    if (willAdd) {
      void btn.offsetWidth; // 続けて押したときもアニメーションをやり直す
      btn.classList.add('is-popping');
      setTimeout(() => btn.classList.remove('is-popping'), 400);
    }
    let result;
    if (willAdd) {
      const info = ext.readCurrentLawInfo();
      result = await ext.addFavorite({ lawId, title: info.title, lawNum: info.lawNum });
    } else {
      result = await ext.removeFavorite(lawId);
    }
    if (!result.ok) {
      // 保存できなかったら見た目を戻し、ボタンの中に理由を短く出す（数秒で元に戻す）
      renderButtonState(btn, !willAdd);
      showButtonError(btn, ext.describeFavoriteError(result));
    }
  }

  /**
   * 登録できなかったことをボタンの中に数秒だけ出す
   * @param {HTMLButtonElement} btn
   * @param {string} message - ボタンの title（マウスを乗せると出る説明）にする全文
   */
  function showButtonError(btn, message) {
    const label = btn.querySelector('.egov-ext-fav-label');
    if (!label) return;
    btn.classList.add('has-error');
    btn.title = message;
    label.textContent = '登録できません';
    clearTimeout(btn._egovErrorTimer);
    btn._egovErrorTimer = setTimeout(() => {
      btn.classList.remove('has-error');
      renderButtonState(btn, btn.classList.contains('is-favorite'));
    }, 4000);
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
      btn.innerHTML = STAR_SVG + '<span class="egov-ext-fav-label">お気に入り追加</span>';
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

    // ポップアップ・別タブ・同期している別の端末で登録・解除されたら、見た目を合わせる
    if (!storageListenerAdded && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (ext.isFavoritesChange(changes, areaName)) {
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

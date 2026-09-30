/**
 * popup.js
 *
 * 拡張機能のアイコンをクリックして表示されるポップアップ画面のスクリプト。
 * トグルUIの実体は js/settings.js の initSettingsUI() が担い、
 * ここではポップアップ固有の振る舞いを扱う。
 * - 法令名検索（e-Gov法令API の法令名・略称検索。結果から新しいタブで開く・お気に入りに加える）
 * - お気に入りの一覧（js/favorites.js が保存を担う）
 * - 「機能の設定」の折りたたみ、詳細設定を開くボタン
 */

window.egovExt = window.egovExt || {};

(function(ext) {

  /** 法令名検索のAPI（e-Gov法令API v2。法令名と略称の部分一致） */
  const SEARCH_API = 'https://laws.e-gov.go.jp/api/2/laws';

  /** APIから受け取る件数。並べ替えてから上位 SEARCH_SHOW_MAX 件を出す */
  const SEARCH_FETCH_LIMIT = 100;
  const SEARCH_SHOW_MAX = 30;

  /** 入力が止まってから検索するまでの待ち時間（ms） */
  const SEARCH_DEBOUNCE_MS = 300;

  /** 「機能の設定」の開閉を覚えておく localStorage のキー */
  const SETTINGS_OPEN_KEY = 'egovPopupSettingsOpen';

  /** 法令の種別の表示名と、検索結果での並び順（憲法・法律を先に） */
  const LAW_TYPES = {
    Constitution: { label: '憲法', rank: 0 },
    Act: { label: '法律', rank: 1 },
    CabinetOrder: { label: '政令', rank: 2 },
    ImperialOrder: { label: '勅令', rank: 3 },
    MinisterialOrdinance: { label: '府省令', rank: 4 },
    Rule: { label: '規則', rank: 5 },
    Misc: { label: 'その他', rank: 6 }
  };

  /** 廃止・失効などの表示名（repeal_status が 'None' 以外のとき） */
  const REPEAL_LABELS = {
    Repeal: '廃止',
    Expire: '失効',
    Suspend: '停止',
    LossOfEffectiveness: '失効'
  };

  /**
   * @typedef {Object} LawSearchItem
   * @property {string} lawId
   * @property {string} title
   * @property {string} lawNum
   * @property {string} lawType
   * @property {string[]} abbrevs
   * @property {string} repealLabel - 廃止等でなければ空文字
   */

  /**
   * e-Gov法令API の応答（laws 配列の1件）を、画面で使う形にそろえる
   * @param {Object} law
   * @returns {LawSearchItem|null}
   */
  function toSearchItem(law) {
    const info = (law && law.law_info) || {};
    const rev = (law && (law.current_revision_info || law.revision_info)) || {};
    if (!info.law_id) return null;
    const status = rev.repeal_status;
    return {
      lawId: String(info.law_id).toUpperCase(),
      title: rev.law_title || info.law_id,
      lawNum: info.law_num || '',
      lawType: info.law_type || rev.law_type || '',
      abbrevs: rev.abbrev ? String(rev.abbrev).split(',').map(a => a.trim()).filter(Boolean) : [],
      repealLabel: status && status !== 'None' ? (REPEAL_LABELS[status] || '廃止等') : ''
    };
  }

  /**
   * 検索語との近さ。0: 法令名か略称がそのもの、1: 前方一致、2: それ以外（途中に含む）
   * @param {LawSearchItem} item
   * @param {string} query
   * @returns {number}
   */
  function matchScore(item, query) {
    const names = [item.title].concat(item.abbrevs);
    if (names.some(n => n === query)) return 0;
    if (names.some(n => n.startsWith(query))) return 1;
    return 2;
  }

  /**
   * 検索結果を「探している法令が上に来る」順に並べる。
   * API は法令IDの順（おおむね古い順）で返すため、そのままだと「民法」で民法が埋もれることがある。
   * 廃止等 → 後ろ、名前がそのもの → 前方一致 → 途中に含む、法律 → 政令 → 府省令、短い名前が先
   * @param {LawSearchItem[]} items
   * @param {string} query
   * @returns {LawSearchItem[]}
   */
  function rankSearchItems(items, query) {
    const seen = new Set();
    const unique = items.filter(item => {
      if (!item || seen.has(item.lawId)) return false;
      seen.add(item.lawId);
      return true;
    });
    const typeRank = item => (LAW_TYPES[item.lawType] ? LAW_TYPES[item.lawType].rank : 9);
    return unique.sort((a, b) =>
      (a.repealLabel ? 1 : 0) - (b.repealLabel ? 1 : 0)
      || matchScore(a, query) - matchScore(b, query)
      || typeRank(a) - typeRank(b)
      || a.title.length - b.title.length
    );
  }

  /**
   * 法令名・略称で e-Gov法令API を検索する
   * @param {string} query
   * @param {AbortSignal} [signal]
   * @returns {Promise<{items: LawSearchItem[], total: number}>}
   */
  async function searchLaws(query, signal) {
    const url = `${SEARCH_API}?law_title=${encodeURIComponent(query)}&limit=${SEARCH_FETCH_LIMIT}&response_format=json`;
    const res = await fetch(url, { signal, headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const items = (json.laws || []).map(toSearchItem).filter(Boolean);
    return {
      items: rankSearchItems(items, query),
      total: typeof json.total_count === 'number' ? json.total_count : items.length
    };
  }

  const STAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
    + '<polygon points="12 2.8 14.9 8.7 21.4 9.6 16.7 14.2 17.8 20.6 12 17.6 6.2 20.6 7.3 14.2 2.6 9.6 9.1 8.7" '
    + 'stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';

  /**
   * ☆ ボタンの見た目を登録状態に合わせる
   * @param {HTMLButtonElement} btn
   * @param {boolean} isFavorite
   */
  function renderStar(btn, isFavorite) {
    btn.classList.toggle('is-favorite', isFavorite);
    btn.setAttribute('aria-pressed', isFavorite ? 'true' : 'false');
    const label = isFavorite ? 'お気に入りから外す' : 'お気に入りに追加';
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }

  document.addEventListener('DOMContentLoaded', async () => {
    const searchInput = document.getElementById('law-search');
    const searchSection = document.getElementById('search-section');
    const searchStatus = document.getElementById('search-status');
    const searchResults = document.getElementById('search-results');
    const favoritesSection = document.getElementById('favorites-section');
    const favoriteList = document.getElementById('favorite-list');
    const favoriteEmpty = document.getElementById('favorite-empty');
    const favoriteCount = document.getElementById('favorite-count');
    const settingsPanel = document.getElementById('settings-panel');
    if (!searchInput || !favoriteList || !settingsPanel) return; // ポップアップ以外（テスト等）で読まれたとき

    /** 登録済みの法令ID。☆ の見た目はここを見て決める */
    let favoriteIds = new Set();

    /** 各 ☆ ボタン（法令IDごと）。一覧と検索結果の両方にあるので、切り替えたら全部そろえる */
    function syncStars() {
      document.querySelectorAll('.fav-toggle').forEach(btn => {
        renderStar(btn, favoriteIds.has(btn.dataset.lawId));
      });
    }

    /**
     * 法令を新しいタブで開き、ポップアップを閉じる
     * @param {string} lawId
     */
    function openLaw(lawId) {
      chrome.tabs.create({ url: ext.getLawPageUrl(lawId) });
      window.close();
    }

    /**
     * 一覧の1行（開くボタン＋☆）を作る
     * @param {{lawId: string, title: string, lawNum?: string, lawType?: string, repealLabel?: string}} law
     * @returns {HTMLLIElement}
     */
    function buildLawItem(law) {
      const li = document.createElement('li');
      li.className = 'law-item';

      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'law-open';
      open.title = `${law.title} を新しいタブで開く`;

      const title = document.createElement('span');
      title.className = 'law-title';
      title.textContent = law.title;
      open.appendChild(title);

      const metaParts = [];
      if (law.lawType && LAW_TYPES[law.lawType]) metaParts.push(LAW_TYPES[law.lawType].label);
      if (law.lawNum) metaParts.push(law.lawNum);
      if (metaParts.length > 0 || law.repealLabel) {
        const meta = document.createElement('span');
        meta.className = 'law-meta';
        if (law.repealLabel) {
          const tag = document.createElement('span');
          tag.className = 'law-tag-repealed';
          tag.textContent = law.repealLabel;
          meta.appendChild(tag);
        }
        meta.appendChild(document.createTextNode(metaParts.join('・')));
        open.appendChild(meta);
      }
      open.addEventListener('click', () => openLaw(law.lawId));

      const star = document.createElement('button');
      star.type = 'button';
      star.className = 'fav-toggle';
      star.dataset.lawId = law.lawId;
      star.innerHTML = STAR_SVG;
      renderStar(star, favoriteIds.has(law.lawId));
      star.addEventListener('click', async () => {
        if (favoriteIds.has(law.lawId)) {
          favoriteIds.delete(law.lawId);
          syncStars();
          await ext.removeFavorite(law.lawId);
        } else {
          favoriteIds.add(law.lawId);
          syncStars();
          await ext.addFavorite({ lawId: law.lawId, title: law.title, lawNum: law.lawNum });
        }
        updateFavoriteCount();
      });

      li.appendChild(open);
      li.appendChild(star);
      return li;
    }

    function updateFavoriteCount() {
      favoriteCount.textContent = favoriteIds.size > 0 ? `（${favoriteIds.size}）` : '';
    }

    /**
     * お気に入りの一覧を描き直す。
     * 一覧の ☆ で外した行はその場では消さず、☆ だけ白抜きにする（押し間違えてもすぐ戻せる）。
     * 次にポップアップを開いたとき、または検索をやめて一覧に戻ったときに消える
     */
    async function renderFavorites() {
      const list = await ext.loadFavorites();
      favoriteIds = new Set(list.map(f => f.lawId));
      favoriteList.textContent = '';
      list.forEach(f => favoriteList.appendChild(buildLawItem(f)));
      favoriteEmpty.hidden = list.length > 0;
      updateFavoriteCount();
    }

    // ---- 法令名検索 ----

    let debounceTimer = null;
    let abortController = null;
    /** @type {Map<string, {items: LawSearchItem[], total: number}>} */
    const searchCache = new Map();

    function showSearchMode(isSearching) {
      searchSection.hidden = !isSearching;
      favoritesSection.hidden = isSearching;
    }

    /**
     * @param {{items: LawSearchItem[], total: number}} result
     * @param {string} query
     */
    function renderSearchResult(result, query) {
      searchResults.textContent = '';
      if (result.items.length === 0) {
        searchStatus.textContent = `「${query}」を名前に含む法令は見つかりませんでした`;
        return;
      }
      const shown = result.items.slice(0, SEARCH_SHOW_MAX);
      shown.forEach(item => searchResults.appendChild(buildLawItem(item)));
      searchStatus.textContent = result.total > shown.length
        ? `検索結果 ${result.total}件（上位${shown.length}件を表示。語を足すと絞り込めます）`
        : `検索結果 ${result.total}件`;
    }

    async function runSearch() {
      clearTimeout(debounceTimer);
      const query = searchInput.value.trim();
      if (!query) {
        if (abortController) abortController.abort();
        showSearchMode(false);
        renderFavorites();
        return;
      }
      showSearchMode(true);

      if (searchCache.has(query)) {
        renderSearchResult(searchCache.get(query), query);
        return;
      }

      if (abortController) abortController.abort();
      abortController = new AbortController();
      const { signal } = abortController;
      searchStatus.textContent = '検索しています…';
      try {
        const result = await searchLaws(query, signal);
        searchCache.set(query, result);
        // 待っている間に入力が変わっていたら、古い結果は出さない
        if (searchInput.value.trim() !== query) return;
        renderSearchResult(result, query);
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        console.debug('egov-ext: 法令名検索に失敗しました:', e);
        searchResults.textContent = '';
        searchStatus.textContent = '検索できませんでした。通信の状態を確かめて、もう一度お試しください';
      }
    }

    searchInput.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      if (!searchInput.value.trim()) {
        runSearch();
        return;
      }
      debounceTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.isComposing) return; // 変換確定の Enter では検索しない
      if (e.key === 'Enter') {
        e.preventDefault();
        runSearch();
      } else if (e.key === 'ArrowDown') {
        const first = (searchSection.hidden ? favoriteList : searchResults).querySelector('.law-open');
        if (first) {
          e.preventDefault();
          first.focus();
        }
      }
    });

    // 一覧の中は ↑↓ で行を移れるようにする（先頭で ↑ なら検索欄へ戻る）
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const current = document.activeElement;
      if (!current || !current.classList.contains('law-open')) return;
      const list = current.closest('.law-list');
      if (!list) return;
      const buttons = Array.from(list.querySelectorAll('.law-open'));
      const index = buttons.indexOf(current);
      e.preventDefault();
      if (e.key === 'ArrowDown' && index < buttons.length - 1) {
        buttons[index + 1].focus();
      } else if (e.key === 'ArrowUp') {
        if (index > 0) buttons[index - 1].focus();
        else searchInput.focus();
      }
    });

    // ---- 機能の設定（折りたたみ） ----

    try {
      settingsPanel.open = localStorage.getItem(SETTINGS_OPEN_KEY) === '1';
    } catch (e) {}
    settingsPanel.addEventListener('toggle', () => {
      try {
        localStorage.setItem(SETTINGS_OPEN_KEY, settingsPanel.open ? '1' : '0');
      } catch (e) {}
    });

    await Promise.all([
      ext.initSettingsUI({ allTabs: false, syncFromStorage: false }),
      renderFavorites()
    ]);

    const openOptionsBtn = document.getElementById('open-options');
    if (openOptionsBtn) {
      openOptionsBtn.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
      });
    }
  });

  // テスト用に並べ替えの関数を公開する
  ext._testPopup = { toSearchItem, rankSearchItems, matchScore };

})(window.egovExt);

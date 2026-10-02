/**
 * popup.js
 *
 * 拡張機能のアイコンをクリックして表示されるポップアップ画面のスクリプト。
 * トグルUIの実体は js/settings.js の initSettingsUI() が担い、
 * ここではポップアップ固有の振る舞いを扱う。
 * - 法令名検索（e-Gov法令API の法令名・略称検索。結果から新しいタブで開く・お気に入りに加える）
 * - 検索の履歴（入力欄を押したときや ↓ で、入力欄の下に出す。ゴミ箱で1件ずつ消せる）
 * - お気に入りの一覧（js/favorites.js が保存を担う）
 * - 「機能の設定」の折りたたみ、詳細設定を開くボタン
 * - 条文ページの虫眼鏡から開かれたときは、検索欄にカーソルを入れる（開けなかったときは新しいタブで開かれる）
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

  /** 検索の履歴の保存先（chrome.storage.local。この端末だけに置き、同期はしない） */
  const HISTORY_STORAGE_KEY = 'egovSearchHistory';

  /** 覚えておく検索の履歴の件数 */
  const HISTORY_MAX = 10;

  /** 条文ページの虫眼鏡から開いたことを background.js が知らせる chrome.storage.session のキー（値は依頼した時刻） */
  const FOCUS_SEARCH_KEY = 'egovPopupFocusSearch';

  /** 虫眼鏡からの依頼として扱う時間（ms）。これより古い印は、開いたあとに残ったものとみなす */
  const FOCUS_SEARCH_WINDOW_MS = 10000;

  /** ポップアップを開けなかったときに、新しいタブで開いたか（background.js が popup.html?view=tab で開く） */
  const IS_TAB_VIEW = new URLSearchParams(location.search).get('view') === 'tab';

  /**
   * 条文ページの虫眼鏡から開かれたか。印は1回で消す
   * @returns {Promise<boolean>}
   */
  async function consumeFocusSearchRequest() {
    if (IS_TAB_VIEW) return true;
    try {
      if (!chrome.storage.session) return false;
      const result = await chrome.storage.session.get(FOCUS_SEARCH_KEY);
      const requestedAt = result && result[FOCUS_SEARCH_KEY];
      if (!requestedAt) return false;
      await chrome.storage.session.remove(FOCUS_SEARCH_KEY);
      return Date.now() - requestedAt < FOCUS_SEARCH_WINDOW_MS;
    } catch (e) {
      return false;
    }
  }

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

  /**
   * 検索の履歴を返す（新しいものが先頭）
   * @returns {Promise<string[]>}
   */
  async function loadSearchHistory() {
    try {
      const result = await chrome.storage.local.get(HISTORY_STORAGE_KEY);
      const list = result && result[HISTORY_STORAGE_KEY];
      if (Array.isArray(list)) return list.filter(q => typeof q === 'string' && q.trim());
    } catch (e) {
      console.debug('egov-ext: 検索の履歴を読めませんでした:', e);
    }
    return [];
  }

  /**
   * @param {string[]} list
   * @returns {Promise<string[]>}
   */
  async function saveSearchHistory(list) {
    const next = list.slice(0, HISTORY_MAX);
    try {
      await chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: next });
    } catch (e) {
      console.debug('egov-ext: 検索の履歴を保存できませんでした:', e);
    }
    return next;
  }

  /**
   * 検索語を履歴の先頭に加える（同じ語は先頭へ移す）
   * @param {string} query
   * @returns {Promise<string[]>} 保存後の履歴
   */
  async function addSearchHistory(query) {
    const q = String(query || '').trim();
    const list = await loadSearchHistory();
    if (!q) return list;
    return saveSearchHistory([q].concat(list.filter(item => item !== q)));
  }

  /**
   * 検索語を履歴から消す
   * @param {string} query
   * @returns {Promise<string[]>} 保存後の履歴
   */
  async function removeSearchHistory(query) {
    const list = await loadSearchHistory();
    return saveSearchHistory(list.filter(item => item !== query));
  }

  const STAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
    + '<polygon points="12 2.8 14.9 8.7 21.4 9.6 16.7 14.2 17.8 20.6 12 17.6 6.2 20.6 7.3 14.2 2.6 9.6 9.1 8.7" '
    + 'stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';

  const CLOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
    + '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';

  const TRASH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
    + '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';

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
    if (IS_TAB_VIEW) document.documentElement.classList.add('is-tab-view');
    const searchInput = document.getElementById('law-search');
    const searchSection = document.getElementById('search-section');
    const searchStatus = document.getElementById('search-status');
    const searchResults = document.getElementById('search-results');
    const favoritesSection = document.getElementById('favorites-section');
    const favoriteList = document.getElementById('favorite-list');
    const favoriteEmpty = document.getElementById('favorite-empty');
    const favoriteCount = document.getElementById('favorite-count');
    const settingsPanel = document.getElementById('settings-panel');
    const searchWrap = document.getElementById('search-wrap');
    const historyPanel = document.getElementById('search-history');
    const historyList = document.getElementById('search-history-list');
    const notice = document.getElementById('popup-notice');
    if (!searchInput || !favoriteList || !settingsPanel || !historyPanel) return; // ポップアップ以外（テスト等）で読まれたとき

    let noticeTimer = null;
    /**
     * 検索欄の下に短いお知らせを数秒だけ出す（お気に入りを保存できなかったとき等）
     * @param {string} message
     */
    function showNotice(message) {
      notice.textContent = message;
      notice.hidden = false;
      clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => { notice.hidden = true; }, 6000);
    }

    /** 登録済みの法令ID。☆ の見た目はここを見て決める */
    let favoriteIds = new Set();

    /** 各 ☆ ボタン（法令IDごと）。一覧と検索結果の両方にあるので、切り替えたら全部そろえる */
    function syncStars() {
      document.querySelectorAll('.fav-toggle').forEach(btn => {
        renderStar(btn, favoriteIds.has(btn.dataset.lawId));
      });
    }

    /**
     * 法令を新しいタブで開き、ポップアップを閉じる。
     * 検索結果から開いたときは、その検索語を履歴に残す（タブを開くとポップアップが閉じるので先に保存する）
     * @param {string} lawId
     * @param {boolean} fromSearch
     */
    async function openLaw(lawId, fromSearch) {
      if (fromSearch) await addSearchHistory(searchInput.value);
      if (IS_TAB_VIEW) {
        // 新しいタブで開いた検索画面なら、そのタブを法令のページに切り替える
        location.href = ext.getLawPageUrl(lawId);
        return;
      }
      chrome.tabs.create({ url: ext.getLawPageUrl(lawId) });
      window.close();
    }

    /**
     * 一覧の1行（開くボタン＋☆）を作る
     * @param {{lawId: string, title: string, lawNum?: string, lawType?: string, repealLabel?: string}} law
     * @param {{fromSearch?: boolean}} [options] - 検索結果の行なら、開いたり ☆ を押したりしたときに検索語を履歴に残す
     * @returns {HTMLLIElement}
     */
    function buildLawItem(law, options) {
      const fromSearch = !!(options && options.fromSearch);
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
      open.addEventListener('click', () => openLaw(law.lawId, fromSearch));

      const star = document.createElement('button');
      star.type = 'button';
      star.className = 'fav-toggle';
      star.dataset.lawId = law.lawId;
      star.innerHTML = STAR_SVG;
      renderStar(star, favoriteIds.has(law.lawId));
      star.addEventListener('click', async () => {
        const adding = !favoriteIds.has(law.lawId);
        // 保存を待たずに見た目を先に変え、保存できなかったら戻す
        if (adding) favoriteIds.add(law.lawId);
        else favoriteIds.delete(law.lawId);
        syncStars();
        updateFavoriteCount();
        if (adding && fromSearch) addSearchHistory(searchInput.value);

        const result = adding
          ? await ext.addFavorite({ lawId: law.lawId, title: law.title, lawNum: law.lawNum })
          : await ext.removeFavorite(law.lawId);
        if (!result.ok) {
          if (adding) favoriteIds.delete(law.lawId);
          else favoriteIds.add(law.lawId);
          syncStars();
          updateFavoriteCount();
          showNotice(ext.describeFavoriteError(result));
        }
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
      annotationsSection.hidden = isSearching || !annotationsAvailable;
      openNotesBtn.hidden = isSearching || !hasAnyAnnotations;
    }

    // ---- すべての法令のマーカー・メモの一覧（notes.html） ----

    const openNotesBtn = document.getElementById('open-notes');
    let hasAnyAnnotations = false;

    async function renderNotesLink() {
      if (!openNotesBtn || !ext.loadAllAnnotations) return;
      const all = await ext.loadAllAnnotations();
      let count = 0;
      all.forEach(list => { count += list.length; });
      hasAnyAnnotations = count > 0;
      document.getElementById('open-notes-label').textContent = `すべてのマーカー・メモ（${count}）`;
      openNotesBtn.hidden = !hasAnyAnnotations || !searchSection.hidden;
    }

    if (openNotesBtn) {
      openNotesBtn.addEventListener('click', () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('notes.html') });
        window.close();
      });
    }

    // ---- この法令のマーカー・メモ ----

    const annotationsSection = document.getElementById('annotations-section');
    const annotationList = document.getElementById('annotation-list');
    const annotationEmpty = document.getElementById('annotation-empty');
    const annotationCount = document.getElementById('annotation-count');
    /** いま開いているタブが e-Gov の条文ページで、マーカー・メモがオンか */
    let annotationsAvailable = false;

    /**
     * いま開いているタブの法令のマーカー・メモを一覧にする。
     * 本文の中で見つからなかったもの（改正などで文が変わった可能性）は、条文ページに聞いて印を付ける
     */
    async function renderAnnotations() {
      annotationsAvailable = false;
      annotationsSection.hidden = true;
      if (!ext.loadAnnotations || !annotationsSection) return;
      let tab = null;
      try {
        [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      } catch (e) {}
      const match = tab && tab.url && tab.url.match(/^https?:\/\/laws\.e-gov\.go\.jp\/law\/([0-9A-Za-z_]+)/);
      const settings = ext.loadSettings ? await ext.loadSettings() : {};
      if (!match || !settings.global || !settings.marker) return;
      const lawId = match[1].toUpperCase();
      const list = await ext.loadAnnotations(lawId);

      let orphans = new Map();
      try {
        const status = await chrome.tabs.sendMessage(tab.id, { type: 'EGOV_ANNOTATION_STATUS' });
        if (status && status.lawId === lawId && Array.isArray(status.orphans)) orphans = new Map(status.orphans);
      } catch (e) {}

      annotationsAvailable = true;
      annotationList.textContent = '';
      list.slice().sort((x, y) => (y.u || y.a || 0) - (x.u || x.a || 0)).forEach(ann => {
        const li = document.createElement('li');
        li.className = 'law-item';
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'law-open';
        open.title = `${ann.l || ''}へ移動`;

        const title = document.createElement('span');
        title.className = 'law-title annotation-title';
        const mark = document.createElement('span');
        mark.className = ann.k === 'provision' ? 'annotation-mark is-note' : `annotation-mark is-color-${ann.c || 1}`;
        mark.setAttribute('aria-hidden', 'true');
        title.appendChild(mark);
        title.appendChild(document.createTextNode(ann.k === 'provision' ? `${ann.l || ''}へのメモ` : (ann.q || '')));
        open.appendChild(title);

        const meta = document.createElement('span');
        meta.className = 'law-meta';
        if (orphans.has(ann.id)) {
          const tag = document.createElement('span');
          tag.className = 'law-tag-repealed';
          tag.textContent = orphans.get(ann.id) === 'missing' ? '今の表示に無い' : '本文で見つからない';
          tag.title = orphans.get(ann.id) === 'missing'
            ? 'この条・項・号が今の表示にありません（畳まれた附則・別の時点の表示など）'
            : '覚えておいた語句が本文で見つかりません（改正で文が変わった可能性があります）';
          meta.appendChild(tag);
        }
        const memo = (ann.m || '').replace(/\s+/g, ' ');
        meta.appendChild(document.createTextNode(ann.k === 'provision'
          ? (memo || '（まだ何も書いていません）')
          : `${ann.l || ''}${memo ? '・' + memo : ''}`));
        open.appendChild(meta);

        open.addEventListener('click', async () => {
          try { await chrome.tabs.sendMessage(tab.id, { type: 'EGOV_GOTO_ANNOTATION', id: ann.id }); } catch (e) {}
          window.close();
        });
        li.appendChild(open);
        annotationList.appendChild(li);
      });
      annotationCount.textContent = list.length > 0 ? `（${list.length}）` : '';
      annotationEmpty.hidden = list.length > 0;
      annotationsSection.hidden = !searchSection.hidden;
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
      shown.forEach(item => searchResults.appendChild(buildLawItem(item, { fromSearch: true })));
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

    /** いま見えている一覧（検索結果かお気に入り）の先頭の行へ移る */
    function focusFirstLaw() {
      const first = (searchSection.hidden ? favoriteList : searchResults).querySelector('.law-open');
      if (first) first.focus();
    }

    // ---- 検索の履歴（入力欄の下のドロップダウン） ----
    // 入力欄を押したとき・入力欄で ↓ を押したとき・入力を消して空にしたときに出す

    /**
     * 履歴の1行（語を選ぶボタン＋ゴミ箱）を作る
     * @param {string} query
     * @returns {HTMLLIElement}
     */
    function buildHistoryItem(query) {
      const li = document.createElement('li');
      li.className = 'history-item';

      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'history-pick';
      pick.title = `「${query}」で検索`;
      pick.innerHTML = CLOCK_SVG;
      const text = document.createElement('span');
      text.className = 'history-text';
      text.textContent = query;
      pick.appendChild(text);
      pick.addEventListener('click', () => pickHistory(query));

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'history-delete';
      del.title = '履歴から消す';
      del.setAttribute('aria-label', `「${query}」を履歴から消す`);
      del.innerHTML = TRASH_SVG;
      del.addEventListener('click', () => deleteHistory(query, li));

      li.appendChild(pick);
      li.appendChild(del);
      return li;
    }

    /** 入力欄が空なら履歴を出す（履歴が無ければ出さない） */
    async function showHistory() {
      if (searchInput.value.trim()) {
        hideHistory();
        return;
      }
      const list = await loadSearchHistory();
      // 読み込みの間に入力が始まっていたら出さない
      if (searchInput.value.trim() || list.length === 0) {
        hideHistory();
        return;
      }
      historyList.textContent = '';
      list.forEach(q => historyList.appendChild(buildHistoryItem(q)));
      historyPanel.hidden = false;
      searchInput.setAttribute('aria-expanded', 'true');
      // ポップアップは中身の高さに合わせて開くので、お気に入りが少ないと重ねて出した履歴の下が切れる。
      // 開いている間だけ、履歴の下端まで高さを確保する
      const bottom = historyPanel.getBoundingClientRect().bottom + window.scrollY + 12;
      document.body.style.minHeight = `${Math.ceil(bottom)}px`;
    }

    function hideHistory() {
      historyPanel.hidden = true;
      searchInput.setAttribute('aria-expanded', 'false');
      document.body.style.minHeight = '';
    }

    /**
     * 履歴の語で検索する
     * @param {string} query
     */
    function pickHistory(query) {
      hideHistory();
      searchInput.value = query;
      searchInput.focus();
      addSearchHistory(query);
      runSearch();
    }

    /**
     * 履歴から1件消す。キーボードで操作していたときは、次の行（無ければ入力欄）へ移る
     * @param {string} query
     * @param {HTMLLIElement} li
     */
    async function deleteHistory(query, li) {
      const list = await removeSearchHistory(query);
      if (list.length === 0) {
        hideHistory();
        searchInput.focus();
        return;
      }
      // フォーカスのある行を先に消すと履歴の外へフォーカスが抜けて閉じてしまうので、隣の行へ移してから消す
      if (li.contains(document.activeElement)) {
        const next = li.nextElementSibling || li.previousElementSibling;
        const target = next && next.querySelector('.history-pick');
        (target || searchInput).focus();
      }
      li.remove();
    }

    // 履歴の中を押しても入力欄からフォーカスを外さない（外れると履歴が閉じ、押した操作が届かない）
    historyPanel.addEventListener('mousedown', (e) => e.preventDefault());

    // 履歴の中は ↑↓ で移り、Delete で消し、Esc で入力欄へ戻る
    historyPanel.addEventListener('keydown', (e) => {
      const picks = Array.from(historyList.querySelectorAll('.history-pick'));
      const current = document.activeElement;
      const item = current && current.closest('.history-item');
      const index = item ? picks.indexOf(item.querySelector('.history-pick')) : -1;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        // 最後の履歴で ↓ なら、その下の一覧へ移る（フォーカスが外れるので履歴は閉じる）
        if (index < picks.length - 1) picks[index + 1].focus();
        else focusFirstLaw();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (index > 0) picks[index - 1].focus();
        else searchInput.focus();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && item) {
        e.preventDefault();
        deleteHistory(picks[index].querySelector('.history-text').textContent, item);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        hideHistory();
        searchInput.focus();
      }
    });

    // 検索欄の周り（入力欄と履歴）の外へフォーカスが移ったら閉じる
    searchWrap.addEventListener('focusout', (e) => {
      if (!e.relatedTarget || !searchWrap.contains(e.relatedTarget)) hideHistory();
    });

    searchInput.addEventListener('mousedown', () => {
      if (historyPanel.hidden) showHistory();
    });

    searchInput.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      if (!searchInput.value.trim()) {
        runSearch();
        showHistory();
        return;
      }
      hideHistory();
      debounceTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.isComposing) return; // 変換確定の Enter では検索しない
      if (e.key === 'Enter') {
        e.preventDefault();
        hideHistory();
        if (searchInput.value.trim()) addSearchHistory(searchInput.value);
        runSearch();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!historyPanel.hidden) {
          const firstPick = historyList.querySelector('.history-pick');
          if (firstPick) firstPick.focus();
        } else if (!searchInput.value.trim()) {
          // 空なら先に履歴を出す。履歴が無ければ一覧の先頭へ
          showHistory().then(() => {
            if (historyPanel.hidden) focusFirstLaw();
          });
        } else {
          focusFirstLaw();
        }
      } else if (e.key === 'Escape' && !historyPanel.hidden) {
        e.preventDefault();
        hideHistory();
      }
    });

    // 一覧の中は ↑↓ で行を移れるようにする（先頭で ↑ なら検索欄へ戻る）
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      // 押した場所で判断する（検索欄や履歴で ↓ を押して一覧の先頭へ移った直後に、同じ押下でもう1行進まないように）
      const current = e.target;
      if (!current || !current.classList || !current.classList.contains('law-open')) return;
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
    // 検索欄の上にあるので、開いたままだと検索とお気に入りが下へ押し出される。開閉は覚えず、毎回閉じた状態から始める

    await Promise.all([
      ext.initSettingsUI({ allTabs: false, syncFromStorage: false }),
      renderFavorites(),
      renderAnnotations(),
      renderNotesLink()
    ]);

    const openOptionsBtn = document.getElementById('open-options');
    if (openOptionsBtn) {
      openOptionsBtn.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
      });
    }

    // 条文ページの虫眼鏡から開かれたときは、検索欄にカーソルを入れて最近の検索を出しておく
    if (await consumeFocusSearchRequest()) {
      searchInput.focus();
      showHistory();
    }
  });

  // テスト用に並べ替え・検索の履歴の関数を公開する
  ext._testPopup = { toSearchItem, rankSearchItems, matchScore, loadSearchHistory, addSearchHistory, removeSearchHistory, HISTORY_MAX };

})(window.egovExt);

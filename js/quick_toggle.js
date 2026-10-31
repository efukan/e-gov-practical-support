/**
 * quick_toggle.js
 *
 * 条文ページ右上（お気に入りボタンの左隣）に置く、表示の切り替えボタンの組。
 * 算用数字・括弧の薄字化・接続詞の色分け・定義語の下線と、被引用・同じ法令の中の参照元・マーカー・メモの表示を、
 * 設定画面を開かずにその場でオン・オフする。
 * 設定「切り替えボタン」（quickToggle）でボタンの組ごと出さないようにできる。
 * あわせて、右上の並びの右端に、法令名検索（ツールバーのポップアップ）を開く虫眼鏡と、設定画面を開く歯車を置く
 * （こちらは設定に関わらず、条文ページなら出す）。
 *
 * 押したときは、ポップアップから切り替えたときと同じく設定を保存し、content.js の applySettings() で
 * 全機能を掛け直す（切り替えの経路を2つに分けない）。
 */

window.egovExt = window.egovExt || {};

(function(ext) {

  const GROUP_ID = 'egov-ext-quick-toggles';

  /**
   * 並べる機能。key は DEFAULT_SETTINGS のキー。groupStart の前には細い仕切りを入れる
   * （表示を整える4つ、引用・参照のつながりを見せる2つ、自分で付けたマーカー・メモを分ける）。
   * secondary の付いたもの（と、その前の仕切り）は、画面の幅が足りないときに先に隠す。
   * tertiary の付いたものは、それよりさらに先（少しでも幅が足りないとき）に隠す
   * @type {ReadonlyArray<{key: string, label: string, name: string, groupStart?: boolean, secondary?: boolean, tertiary?: boolean}>}
   */
  ext.QUICK_TOGGLE_ITEMS = Object.freeze([
    { key: 'horizontal', label: '算用数字', name: '横書き数字変換（漢数字を算用数字に）' },
    { key: 'dim', label: '括弧', name: '括弧書きの薄字化' },
    { key: 'conjunction', label: '接続詞', name: '接続詞の色分け' },
    { key: 'definition', label: '定義語', name: '定義語の下線とホバー辞書' },
    { key: 'citation', label: '被引用', name: '被引用（他の法令からの引用）の「引用」ボタン', groupStart: true, secondary: true, tertiary: true },
    { key: 'backref', label: '参照元', name: '同じ法令の中の参照元（番号の横の「↩」）', secondary: true, tertiary: true },
    { key: 'marker', label: 'マーカー', name: 'マーカー・メモの表示（オフにしても保存したものは消えません）', groupStart: true, secondary: true }
  ]);

  /** 幅が足りないときに隠す順の印（CSS の @media で使う） */
  function tierClasses(item) {
    return (item.secondary ? ' egov-ext-quick-secondary' : '') + (item.tertiary ? ' egov-ext-quick-tertiary' : '');
  }

  /**
   * ボタンの見た目（オン・オフ）を今の設定に合わせる
   * @param {HTMLElement} group
   */
  function renderGroup(group) {
    group.querySelectorAll('.egov-ext-quick-btn').forEach(btn => {
      const item = ext.QUICK_TOGGLE_ITEMS.find(i => i.key === btn.dataset.key);
      const on = !!(ext.settings && ext.settings[btn.dataset.key]);
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.title = `${item ? item.name : ''}：${on ? 'オン（押すとオフ）' : 'オフ（押すとオン）'}`;
    });
  }

  /**
   * ボタンが押されたら、その機能を切り替えて保存し、全機能を掛け直す
   * @param {MouseEvent} e
   */
  async function handleClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const key = e.currentTarget.dataset.key;
    if (!key || !ext.settings) return;
    ext.settings = Object.assign({}, ext.settings, { [key]: !ext.settings[key] });
    const group = document.getElementById(GROUP_ID);
    if (group) renderGroup(group);
    if (ext.saveSettings) await ext.saveSettings(ext.settings);
    if (ext.applySettings) ext.applySettings();
  }

  /**
   * 切り替えボタンの組を置く（既にあれば見た目を今の設定に合わせるだけ）。
   * お気に入りボタンか条文ジャンプ検索があれば、その左隣に置く
   */
  ext.setupQuickToggles = function() {
    if (!ext.settings || !ext.settings.global || !ext.settings.quickToggle
        || !(ext.checkIfLawPage && ext.checkIfLawPage())) {
      ext.removeQuickToggles();
      return;
    }

    let group = document.getElementById(GROUP_ID);
    if (!group || !document.body.contains(group)) {
      group = document.createElement('div');
      group.id = GROUP_ID;
      group.className = 'egov-ext-quick-toggles';
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', '表示の切り替え');

      ext.QUICK_TOGGLE_ITEMS.forEach(item => {
        if (item.groupStart) {
          const sep = document.createElement('span');
          sep.className = 'egov-ext-quick-sep' + tierClasses(item);
          group.appendChild(sep);
        }
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'egov-ext-quick-btn' + tierClasses(item);
        btn.dataset.key = item.key;
        const dot = document.createElement('span');
        dot.className = 'egov-ext-quick-dot';
        btn.appendChild(dot);
        btn.appendChild(document.createTextNode(item.label));
        btn.addEventListener('click', handleClick);
        group.appendChild(btn);
      });

      const headerContainer = ext.getOrCreateHeaderContainer();
      const next = document.getElementById('egov-ext-fav-btn') || document.getElementById('egov-ext-jump-container');
      if (next && next.parentNode === headerContainer) {
        headerContainer.insertBefore(group, next);
      } else {
        headerContainer.appendChild(group);
      }
    }
    renderGroup(group);
  };

  const SETTINGS_BUTTON_ID = 'egov-ext-settings-btn';

  // 図には aria-hidden を付けない。e-Gov のページの CSS が [aria-hidden='true'] を display:none !important にするため。
  // 読み上げはボタンの aria-label で足りる
  const GEAR_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false">'
    + '<circle cx="12" cy="12" r="3"/>'
    + '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'
    + '</svg>';

  const SEARCH_BUTTON_ID = 'egov-ext-search-btn';

  const SEARCH_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" focusable="false">'
    + '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';

  const HIMOTOKI_BUTTON_ID = 'egov-ext-himotoki-btn';
  const HIMOTOKI_BASE_URL = 'https://himotoki.efukan.jp';

  // 法令ひもとき（himotoki.efukan.jp）の「法」の朱印アイコン。
  // e-Gov 側の CSS が [aria-hidden='true'] を非表示にするため、aria-hidden は付けない。
  const HIMOTOKI_SEAL_SVG = '<svg class="egov-ext-himotoki-seal" viewBox="0 0 512 512" width="18" height="18" focusable="false">'
    + '<g transform="rotate(-5 256 256)">'
    + '<circle cx="256" cy="256" r="229" fill="#f1e5d8"/>'
    + '<circle cx="256" cy="256" r="215" fill="none" stroke="#b0402c" stroke-width="22"/>'
    + '<path transform="translate(256 256) scale(229)" fill="#b0402c" d="M0.1934 0.0441Q0.1754 0.0441 0.167 0.0599Q0.0803 0.2142 -0.0116 0.3209Q-0.019 0.3305 -0.019 0.3357Q-0.019 0.341 -0.0137 0.3442Q-0.0084 0.3474 0 0.3463L0.26 0.3326Q0.279 0.3305 0.279 0.3167Q0.279 0.3114 0.2758 0.3051Q0.2484 0.2533 0.1987 0.1741Q0.186 0.155 0.1913 0.1519Q0.1924 0.1508 0.1955 0.1508Q0.1998 0.1508 0.2124 0.1561Q0.3012 0.1963 0.3577 0.2454Q0.4143 0.2945 0.4396 0.3426Q0.465 0.3907 0.465 0.4319Q0.465 0.4678 0.4486 0.4895Q0.4322 0.5111 0.4048 0.5111Q0.3847 0.5111 0.3614 0.4974Q0.3498 0.489 0.3445 0.4731Q0.335 0.4351 0.3128 0.3833Q0.3065 0.3685 0.2938 0.3685Q0.2906 0.3685 0.2843 0.3706Q0.13 0.4213 -0.1099 0.4837Q-0.1247 0.4879 -0.1299 0.4942L-0.1352 0.5006Q-0.1405 0.5059 -0.1468 0.5059Q-0.1521 0.5059 -0.1569 0.5016Q-0.1616 0.4974 -0.1638 0.4911L-0.2081 0.3801Q-0.2102 0.3759 -0.2102 0.3696Q-0.2102 0.3632 -0.2055 0.359Q-0.2007 0.3548 -0.1912 0.3548L-0.0961 0.3516Q-0.0771 0.3495 -0.0708 0.3336Q-0.0232 0.2026 0.0085 0.0684L0.0095 0.0621Q0.0095 0.0536 0.0037 0.0488Q-0.0021 0.0441 -0.0116 0.0441H-0.0581Q-0.1109 0.0451 -0.1701 0.0557H-0.1764Q-0.1912 0.0557 -0.1986 0.042L-0.2018 0.0356Q-0.205 0.0293 -0.205 0.023Q-0.205 0.0166 -0.1997 0.0129Q-0.1944 0.0092 -0.1849 0.0103Q-0.149 0.0134 -0.076 0.0156H0.0265Q0.037 0.0156 0.0428 0.0097Q0.0486 0.0039 0.0486 -0.0066V-0.1725Q0.0486 -0.1831 0.0428 -0.1889Q0.037 -0.1947 0.0265 -0.1947H-0.02Q-0.0644 -0.1937 -0.1257 -0.1842Q-0.1278 -0.1831 -0.1331 -0.1831Q-0.1468 -0.1831 -0.1532 -0.1979Q-0.1564 -0.2042 -0.1616 -0.2042Q-0.1712 -0.2042 -0.1775 -0.1852Q-0.2641 0.0864 -0.2789 0.1519Q-0.2969 0.2216 -0.2969 0.2554Q-0.2958 0.2797 -0.28 0.3188Q-0.2673 0.3495 -0.261 0.3759Q-0.2546 0.4023 -0.2557 0.4393Q-0.2567 0.4784 -0.2805 0.5027Q-0.3043 0.527 -0.3423 0.527Q-0.3793 0.527 -0.3941 0.4858Q-0.3983 0.4763 -0.3962 0.4583Q-0.3867 0.3981 -0.3867 0.3495Q-0.3867 0.3104 -0.392 0.285Q-0.3973 0.2597 -0.4079 0.2523Q-0.4216 0.2417 -0.4396 0.2385Q-0.4607 0.2332 -0.4607 0.2248Q-0.4607 0.2206 -0.4549 0.2179Q-0.4491 0.2153 -0.4385 0.2153H-0.4142Q-0.4026 0.2153 -0.3973 0.2116Q-0.392 0.2079 -0.3846 0.1931Q-0.3677 0.1646 -0.3318 0.0853Q-0.2958 0.006 -0.206 -0.1947L-0.1669 -0.2835Q-0.1585 -0.3025 -0.15 -0.3025Q-0.1458 -0.3025 -0.1458 -0.2951Q-0.1458 -0.2856 -0.1479 -0.2793L-0.1553 -0.2571Q-0.1564 -0.2539 -0.1564 -0.2486Q-0.1564 -0.2328 -0.1373 -0.2307Q-0.1025 -0.2275 -0.0317 -0.2254H0.0265Q0.037 -0.2254 0.0428 -0.2307Q0.0486 -0.2359 0.0486 -0.2454Q0.0486 -0.3522 0.0391 -0.4357V-0.4399Q0.0391 -0.4494 0.0455 -0.4541Q0.0518 -0.4589 0.0634 -0.4557Q0.1976 -0.4283 0.1976 -0.4135Q0.1976 -0.4103 0.1892 -0.404L0.185 -0.4008Q0.1712 -0.3902 0.1712 -0.3744V-0.2476Q0.1712 -0.237 0.177 -0.2312Q0.1828 -0.2254 0.1934 -0.2254H0.2547Q0.2716 -0.2254 0.2811 -0.2391L0.3012 -0.2687Q0.3075 -0.2771 0.3155 -0.2888Q0.3234 -0.3004 0.3287 -0.3062Q0.334 -0.312 0.3382 -0.312Q0.3456 -0.312 0.3852 -0.2787Q0.4248 -0.2454 0.4417 -0.2243Q0.447 -0.2169 0.447 -0.2116Q0.447 -0.2053 0.4407 -0.2Q0.4322 -0.1947 0.4195 -0.1947H0.1934Q0.1828 -0.1947 0.177 -0.1889Q0.1712 -0.1831 0.1712 -0.1725V-0.0066Q0.1712 0.0039 0.177 0.0097Q0.1828 0.0156 0.1934 0.0156H0.2779Q0.2949 0.0156 0.3044 0.0018L0.3255 -0.0299Q0.3297 -0.0362 0.3387 -0.0494Q0.3477 -0.0626 0.3535 -0.0695Q0.3593 -0.0764 0.3635 -0.0764Q0.372 -0.0764 0.4121 -0.0415Q0.4523 -0.0066 0.4692 0.0156Q0.4745 0.023 0.4745 0.0282Q0.4745 0.0325 0.4692 0.0377Q0.4618 0.0441 0.4481 0.0441ZM-0.3064 -0.293Q-0.3191 -0.3258 -0.3423 -0.3606Q-0.3656 -0.3955 -0.3931 -0.424Q-0.4079 -0.4399 -0.4036 -0.4441Q-0.4005 -0.4473 -0.3835 -0.4462Q-0.2916 -0.4388 -0.2472 -0.4045Q-0.2029 -0.3701 -0.2029 -0.3289Q-0.2029 -0.3036 -0.2192 -0.2851Q-0.2356 -0.2666 -0.261 -0.2666Q-0.2747 -0.2666 -0.2874 -0.2708Q-0.299 -0.2761 -0.3064 -0.293ZM-0.3772 -0.0447Q-0.3899 -0.05 -0.3952 -0.0669Q-0.4057 -0.0986 -0.4263 -0.1303Q-0.4469 -0.162 -0.4723 -0.1884Q-0.4871 -0.2053 -0.4839 -0.2085Q-0.4797 -0.2127 -0.4628 -0.2116Q-0.3762 -0.2042 -0.3344 -0.172Q-0.2927 -0.1398 -0.2927 -0.1007Q-0.2927 -0.0753 -0.3091 -0.0568Q-0.3254 -0.0383 -0.3497 -0.0383Q-0.3635 -0.0383 -0.3772 -0.0447Z"/>'
    + '</g></svg>';

  /**
   * e-Gov の要素 ID（例: Mp-Ch_1-At_6_2-Pr_1-It_3）を「法令ひもとき」のパスに変換する。
   * 本則（Mp）の条（At_）は /law/{lawId}/{条}（項・号があれば ?p=...&i=...）へ変換し、
   * 附則（Sp）や先頭（IDなし）は法令トップ /law/{lawId} を返す。
   * @param {string} lawId
   * @param {string} [rawId]
   * @returns {string|null}
   */
  ext.egoIdToHimotokiPath = function(lawId, rawId) {
    const cleanLawId = String(lawId || '').trim().toUpperCase();
    if (!cleanLawId) return null;
    const basePath = '/law/' + encodeURIComponent(cleanLawId);
    const id = String(rawId || '').trim().replace(/^#/, '');
    if (!id) return basePath;

    if (/^Mp(?:$|[-_])/i.test(id) && !/(?:^|[-_])Sp(?:$|[-_])/i.test(id)) {
      const atMatch = id.match(/(?:^|[-_])At_(\d+(?:_\d+)*)/i);
      if (atMatch) {
        const articlePath = basePath + '/' + atMatch[1];
        const prMatch = id.match(/(?:^|[-_])Pr_(\d+)(?:$|[-_])/i);
        const itMatch = id.match(/(?:^|[-_])It_(\d+)(?:$|[-_])/i);
        const siMatch = id.match(/(?:^|[-_])Si\d*_(\d+)(?:$|[-_])/i);
        const prNum = prMatch ? prMatch[1] : '';
        const itNum = itMatch ? itMatch[1] : '';
        const siNum = siMatch ? siMatch[1] : '';

        if (itNum) {
          let query = '?p=' + (prNum || '1') + '&i=' + itNum;
          if (siNum) query += '&s=' + siNum;
          return articlePath + query;
        }
        if (prNum && Number(prNum) > 1) {
          return articlePath + '?p=' + prNum;
        }
        return articlePath;
      }
    }
    return basePath;
  };

  /**
   * いま画面で読んでいる条文の e-Gov 要素 ID を求める。
   * - URL のハッシュ（#Mp-...）が指す要素が画面内にあるとき（またはレイアウト計算のないテスト環境）はその ID を優先する。
   * - ページをスクロールして読んでいるときは、画面上部の読み位置にある条（article）の ID を返す。
   * - ページの先頭付近にいてハッシュも無いときは空文字を返す（法令トップを開く）。
   * @returns {string}
   */
  ext.resolveCurrentProvisionId = function() {
    const hasLayout = !!(document.body && document.body.getBoundingClientRect().width > 0);
    const scroller = ext.getLawScrollContainer ? ext.getLawScrollContainer() : null;
    const scrollerTop = (scroller && !(ext.isDocumentScroller && ext.isDocumentScroller(scroller)))
      ? scroller.scrollTop
      : 0;
    const scrollTop = Math.max(window.pageYOffset || window.scrollY || 0, scrollerTop || 0);
    const vh = window.innerHeight || 800;

    const rawHash = (window.location && window.location.hash) ? window.location.hash.slice(1) : '';
    if (rawHash) {
      let hashId = rawHash;
      try { hashId = decodeURIComponent(rawHash).trim(); } catch (e) { hashId = rawHash.trim(); }
      if (hashId) {
        const hashEl = (ext.resolveTargetElement && ext.resolveTargetElement(hashId)) || document.getElementById(hashId);
        if (!hasLayout) {
          return hashEl ? (hashEl.id || hashId) : hashId;
        }
        if (hashEl) {
          const rect = hashEl.getBoundingClientRect();
          if (rect.height > 0 && rect.bottom > 40 && rect.top < vh * 0.9) {
            return hashEl.id || hashId;
          }
        } else if (scrollTop < 40) {
          return hashId;
        }
      }
    }

    if (scrollTop >= 40 && hasLayout) {
      const container = (ext.getLawContainer && ext.getLawContainer()) || document;
      const articles = container.querySelectorAll('article[id], [id^="Mp-"][id*="At_"], [id*="-Sp-"][id*="At_"]');
      const isDocScroller = !scroller || (ext.isDocumentScroller && ext.isDocumentScroller(scroller));
      const viewportTop = (!isDocScroller && scroller)
        ? Math.max(60, scroller.getBoundingClientRect().top)
        : 60;
      const readLine = viewportTop + 24;
      let bestId = '';
      let bestDist = Infinity;
      for (let i = 0; i < articles.length; i++) {
        const el = articles[i];
        const rect = el.getBoundingClientRect();
        if (rect.height <= 0 || rect.bottom <= viewportTop + 8 || rect.top >= vh * 0.8) continue;
        const dist = (rect.top <= readLine && rect.bottom >= readLine)
          ? 0
          : Math.min(Math.abs(rect.top - readLine), Math.abs(rect.bottom - readLine));
        if (dist < bestDist) {
          bestDist = dist;
          bestId = el.id;
          if (dist === 0 && el.tagName === 'ARTICLE') break;
        }
      }
      if (bestId) return bestId;
    }

    if (scrollTop >= 40) {
      const activeToc = document.querySelector('.active-spy[href^="#"]');
      if (activeToc) {
        const href = activeToc.getAttribute('href') || '';
        if (href.length > 1) return href.slice(1);
      }
    }

    return '';
  };

  /**
   * 現在の法令・条文に対応する「法令ひもとき」の URL を組み立てる
   * @param {string} [targetIdOverride] - 明示的に指定する e-Gov 要素 ID（省略時は現在の表示位置から判定）
   * @returns {string|null}
   */
  ext.buildHimotokiUrl = function(targetIdOverride) {
    const lawId = ext.getLawIdFromUrl && ext.getLawIdFromUrl(window.location.href);
    if (!lawId) return null;
    const rawId = typeof targetIdOverride === 'string'
      ? targetIdOverride
      : ext.resolveCurrentProvisionId();
    const path = ext.egoIdToHimotokiPath(lawId, rawId);
    return path ? (HIMOTOKI_BASE_URL + path) : null;
  };

  /**
   * 「法令ひもときで開く」ボタンのリンク先と説明文を今の表示位置に合わせて更新する
   * @param {HTMLAnchorElement} btn
   * @returns {string} 更新後の URL
   */
  function updateHimotokiButton(btn) {
    const lawId = ext.getLawIdFromUrl && ext.getLawIdFromUrl(window.location.href);
    const rawId = ext.resolveCurrentProvisionId();
    const path = lawId ? ext.egoIdToHimotokiPath(lawId, rawId) : null;
    const url = path ? (HIMOTOKI_BASE_URL + path) : HIMOTOKI_BASE_URL;
    btn.href = url;

    let articleLabel = '';
    if (path && /^\/law\/[^/]+\/\d/.test(path)) {
      if (ext.formatPathFromObjectId && rawId) {
        articleLabel = ext.formatPathFromObjectId(rawId);
      }
      if (!articleLabel) {
        const m = rawId.match(/(?:^|[-_])At_(\d+(?:_\d+)*)/i);
        if (m) articleLabel = '第' + m[1].replace(/_/g, '条の') + '条';
      }
    }
    const label = articleLabel
      ? `表示中の条文（${articleLabel}）を「法令ひもとき」で開く（新しいタブ）`
      : 'この法令を「法令ひもとき」で開く（新しいタブ）';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    return url;
  }

  /**
   * 「法令ひもときで開く」ボタンを作る
   * @returns {HTMLAnchorElement}
   */
  function createHimotokiButton() {
    const btn = document.createElement('a');
    btn.id = HIMOTOKI_BUTTON_ID;
    btn.className = 'egov-ext-himotoki-btn';
    btn.target = '_blank';
    btn.rel = 'noopener noreferrer';
    btn.innerHTML = HIMOTOKI_SEAL_SVG + '<span class="egov-ext-himotoki-label">ひもとき</span>';
    updateHimotokiButton(btn);

    btn.addEventListener('mouseenter', () => updateHimotokiButton(btn));
    btn.addEventListener('focus', () => updateHimotokiButton(btn));
    btn.addEventListener('mousedown', () => updateHimotokiButton(btn));
    btn.addEventListener('click', (e) => {
      const url = updateHimotokiButton(btn);
      e.preventDefault();
      e.stopPropagation();
      if (url && typeof window.open === 'function') {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    });
    return btn;
  }

  /**
   * 右上の並びの右端に置く、丸いアイコンのボタンを作る。押すと background.js へ依頼を送る
   * （content script からは設定画面もポップアップも直接開けない）
   * @param {string} id
   * @param {string} className
   * @param {string} label - title と読み上げ用の名前
   * @param {string} svg
   * @param {string} messageType - background.js へ送る依頼の種類
   * @returns {HTMLButtonElement}
   */
  function createRoundButton(id, className, label, svg, messageType) {
    const btn = document.createElement('button');
    btn.id = id;
    btn.type = 'button';
    btn.className = 'egov-ext-round-btn ' + className;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.innerHTML = svg;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        const sent = chrome.runtime.sendMessage({ type: messageType });
        if (sent && sent.catch) sent.catch(() => {});
      } catch (err) {
        console.debug('egov-ext: 依頼を送れませんでした:', messageType, err);
      }
    });
    return btn;
  }

  /**
   * 右上の並びの右端に、「法令ひもとき」で開くボタン・法令名検索（ツールバーのポップアップ）を開く虫眼鏡・設定画面を開く歯車を置く。
   * 並びの右端に来るよう CSS の order で後ろに回すので、DOM の中の位置は問わない。設定に関わらず、条文ページなら出す
   */
  ext.setupSettingsButton = function() {
    if (!ext.settings || !ext.settings.global || !(ext.checkIfLawPage && ext.checkIfLawPage())) {
      ext.removeSettingsButton();
      return;
    }
    const container = ext.getOrCreateHeaderContainer();
    const himotoki = document.getElementById(HIMOTOKI_BUTTON_ID);
    if (!himotoki || !document.body.contains(himotoki)) {
      container.appendChild(createHimotokiButton());
    } else {
      updateHimotokiButton(himotoki);
    }
    const search = document.getElementById(SEARCH_BUTTON_ID);
    if (!search || !document.body.contains(search)) {
      container.appendChild(createRoundButton(SEARCH_BUTTON_ID, 'egov-ext-search-btn',
        '法令名で検索（拡張機能のポップアップを開く）', SEARCH_SVG, 'OPEN_LAW_SEARCH'));
    }
    const gear = document.getElementById(SETTINGS_BUTTON_ID);
    if (!gear || !document.body.contains(gear)) {
      container.appendChild(createRoundButton(SETTINGS_BUTTON_ID, 'egov-ext-settings-btn',
        'e-Gov法令ひもときの設定を開く', GEAR_SVG, 'OPEN_OPTIONS_PAGE'));
    }
  };

  /**
   * 法令ひもとき・虫眼鏡・歯車のボタンをDOMから取り除く
   */
  ext.removeSettingsButton = function() {
    [HIMOTOKI_BUTTON_ID, SEARCH_BUTTON_ID, SETTINGS_BUTTON_ID].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.remove();
    });
    if (ext.checkAndRemoveHeaderContainer) ext.checkAndRemoveHeaderContainer();
  };

  /**
   * 切り替えボタンの組をDOMから取り除く
   */
  ext.removeQuickToggles = function() {
    const group = document.getElementById(GROUP_ID);
    if (group) group.remove();
    if (ext.checkAndRemoveHeaderContainer) ext.checkAndRemoveHeaderContainer();
  };

})(window.egovExt);

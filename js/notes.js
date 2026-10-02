/**
 * notes.js
 *
 * マーカー・メモの一覧（notes.html）。すべての法令のマーカー・メモを法令ごとに並べ、
 * メモ・語句・条項・法令名で検索し、色や種類で絞り込む。各件から法令を開く・メモを直す・削除ができる。
 * 保存は annotation_store.js が受け持ち、ここは読み書きを呼ぶだけ。
 *
 * 法令名はマーカー・メモの中に入れていないので、次の順に探す:
 * この端末で覚えた法令名（ext.getLawTitles）→ お気に入り → 法令IDから組み立てた法令番号（ext.describeLawId）
 */

window.egovExt = window.egovExt || {};

(function(ext) {

  /** 色の番号 → 名前 */
  const COLOR_NAMES = { 1: '黄', 2: '緑', 3: '桃' };

  /**
   * 条・項・号の ID から、並べ順のための数の列を作る（本則が先、附則が後。第7条の2 は [7, 2]）
   * @param {string} id
   * @returns {number[]}
   */
  function provisionOrderKey(id) {
    const key = [/(?:^|[-_])Sp(?:[-_]|$)/.test(id) ? 1 : 0];
    const re = /(?:At|Pr|It|Si\d*)_([0-9]+(?:_[0-9]+)*)/g;
    let m;
    while ((m = re.exec(id))) {
      const nums = m[1].split('_').map(Number);
      key.push(nums[0], nums[1] || 0, nums[2] || 0);
    }
    return key;
  }

  function compareKeys(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] || 0) - (b[i] || 0);
      if (d) return d;
    }
    return 0;
  }

  function formatDate(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  }

  /**
   * 表示する文字の中で、検索語にそのまま当たる所を <mark> で囲む（そろえ方の違う当たり方は印を付けずに表示だけする）
   * @param {HTMLElement} el
   * @param {string} text
   * @param {string} query - 入力そのまま
   */
  function setTextWithMarks(el, text, query) {
    el.textContent = '';
    const q = (query || '').trim();
    if (!q) { el.textContent = text; return; }
    const lower = text.toLowerCase();
    const needle = q.toLowerCase();
    let pos = 0;
    let idx;
    while ((idx = lower.indexOf(needle, pos)) !== -1) {
      if (idx > pos) el.appendChild(document.createTextNode(text.slice(pos, idx)));
      const mark = document.createElement('mark');
      mark.textContent = text.slice(idx, idx + needle.length);
      el.appendChild(mark);
      pos = idx + needle.length;
    }
    if (pos < text.length) el.appendChild(document.createTextNode(text.slice(pos)));
  }

  /**
   * 1件が絞り込み・検索に当たるか
   * @returns {boolean}
   */
  function matches(ann, law, state) {
    if (state.filter === 'provision' && ann.k !== 'provision') return false;
    if (/^c[123]$/.test(state.filter) && (ann.k === 'provision' || String(ann.c || 1) !== state.filter.slice(1))) return false;
    if (state.memoOnly && !(ann.m || '').trim()) return false;
    if (!state.normalizedQuery) return true;
    const haystack = ext.normalizeForSearch([ann.m, ann.q, ann.l, law.title, law.lawNum].join('\n'));
    return haystack.includes(state.normalizedQuery);
  }

  document.addEventListener('DOMContentLoaded', async () => {
    const listEl = document.getElementById('notes-list');
    const emptyEl = document.getElementById('notes-empty');
    const statusEl = document.getElementById('notes-status');
    const summaryEl = document.getElementById('notes-summary');
    const searchInput = document.getElementById('notes-search');
    const memoOnly = document.getElementById('notes-memo-only');
    const chips = Array.from(document.querySelectorAll('.notes-chip'));
    if (!listEl || !ext.loadAllAnnotations) return;

    const state = { query: '', normalizedQuery: '', filter: 'all', memoOnly: false };
    /** @type {Map<string, Object[]>} */
    let byLaw = new Map();
    /** @type {Object<string, {title: string, lawNum: string}>} */
    let laws = {};
    /** 書き直し中の ID（その間は保存の通知で描き直さない） */
    let editingId = null;

    /**
     * お知らせを出す。kind が 'filter' のもの（当てはまる件数）は絞り込みをやめたら消し、
     * 'action' のもの（保存・削除の結果）は次の操作まで残す
     */
    function setStatus(text, isError, kind) {
      statusEl.textContent = text;
      statusEl.classList.toggle('is-error', !!isError);
      statusEl.dataset.kind = kind || 'action';
    }

    async function load() {
      byLaw = await ext.loadAllAnnotations();
      const titles = await ext.getLawTitles();
      const favorites = ext.loadFavorites ? await ext.loadFavorites() : [];
      const favById = new Map(favorites.map(f => [f.lawId, f]));
      laws = {};
      byLaw.forEach((list, lawId) => {
        const known = titles[lawId];
        const fav = favById.get(lawId);
        const favTitle = fav && ext.isUsableLawTitle(fav.title) ? fav.title : '';
        laws[lawId] = {
          title: (known && known.t) || favTitle || ext.describeLawId(lawId),
          lawNum: (known && known.n) || (fav && fav.lawNum) || '',
          named: !!((known && known.t) || favTitle)
        };
      });
    }

    function lawUrl(lawId, provisionId) {
      return `https://laws.e-gov.go.jp/law/${encodeURIComponent(lawId)}${provisionId ? '#' + encodeURIComponent(provisionId) : ''}`;
    }

    function buildItem(lawId, ann) {
      const li = document.createElement('li');
      li.className = 'notes-item';

      const mark = document.createElement('span');
      mark.className = ann.k === 'provision' ? 'notes-mark is-note' : `notes-mark is-color-${ann.c || 1}`;
      mark.title = ann.k === 'provision' ? '項・号へのメモ' : `${COLOR_NAMES[ann.c || 1]}のマーカー`;
      li.appendChild(mark);

      const body = document.createElement('div');
      body.className = 'notes-item-body';

      const head = document.createElement('div');
      head.className = 'notes-item-head';
      const label = document.createElement('span');
      label.className = 'notes-item-label';
      setTextWithMarks(label, ann.l || ann.p, state.query);
      head.appendChild(label);
      if (ann.k !== 'provision' && ann.q) {
        const quote = document.createElement('span');
        quote.className = 'notes-item-quote';
        setTextWithMarks(quote, `「${ann.q}」`, state.query);
        head.appendChild(quote);
      }
      body.appendChild(head);

      const memo = document.createElement('div');
      memo.className = 'notes-item-memo';
      if ((ann.m || '').trim()) setTextWithMarks(memo, ann.m, state.query);
      else { memo.textContent = 'メモなし'; memo.classList.add('is-empty'); }
      body.appendChild(memo);

      const meta = document.createElement('div');
      meta.className = 'notes-item-meta';
      meta.textContent = `更新 ${formatDate(ann.u || ann.a)}`;
      body.appendChild(meta);
      li.appendChild(body);

      const actions = document.createElement('div');
      actions.className = 'notes-item-actions';
      const open = document.createElement('a');
      open.className = 'notes-btn';
      open.href = lawUrl(lawId, ann.p);
      open.target = '_blank';
      open.rel = 'noopener';
      open.textContent = '開く';
      open.title = `${laws[lawId].title} の ${ann.l || ''}を新しいタブで開く`;
      actions.appendChild(open);

      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'notes-btn';
      edit.textContent = 'メモを直す';
      edit.addEventListener('click', () => startEdit(li, memo, lawId, ann));
      actions.appendChild(edit);

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'notes-btn is-danger';
      del.textContent = '削除';
      del.addEventListener('click', async () => {
        const what = ann.k === 'provision' ? 'メモ' : 'マーカーとメモ';
        if (!window.confirm(`${laws[lawId].title} ${ann.l || ''}の${what}を削除します。元に戻せません。よろしいですか？`)) return;
        const result = await ext.removeAnnotation(lawId, ann.id);
        if (result.ok) {
          setStatus('削除しました。');
          await load();
          render();
        } else {
          setStatus('削除できませんでした。もう一度お試しください。', true);
        }
      });
      actions.appendChild(del);
      li.appendChild(actions);
      return li;
    }

    async function startEdit(li, memoEl, lawId, ann) {
      if (editingId) return;
      editingId = ann.id;
      const mode = await ext.getAnnotationMode();
      const max = ext.ANNOTATION_MEMO_MAX[mode];
      const wrap = document.createElement('div');
      wrap.className = 'notes-edit';
      const textarea = document.createElement('textarea');
      textarea.value = ann.m || '';
      textarea.maxLength = max;
      textarea.rows = 4;
      textarea.setAttribute('aria-label', `${ann.l || ''}のメモ`);
      const row = document.createElement('div');
      row.className = 'notes-edit-row';
      const count = document.createElement('span');
      count.className = 'notes-edit-count';
      const update = () => { count.textContent = `${textarea.value.length}/${max}`; };
      update();
      textarea.addEventListener('input', update);
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'notes-btn is-primary';
      save.textContent = '保存';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'notes-btn';
      cancel.textContent = 'やめる';
      row.append(count, cancel, save);
      wrap.append(textarea, row);
      memoEl.replaceWith(wrap);
      textarea.focus();

      const finish = async () => {
        editingId = null;
        await load();
        render();
      };
      cancel.addEventListener('click', finish);
      save.addEventListener('click', async () => {
        const result = await ext.saveAnnotation(lawId, Object.assign({}, ann, { m: textarea.value }));
        if (result.ok) {
          setStatus('メモを保存しました。');
          await finish();
        } else {
          setStatus(ext.describeAnnotationError(result), true);
        }
      });
    }

    function render() {
      state.normalizedQuery = ext.normalizeForSearch(state.query);
      listEl.textContent = '';
      let total = 0;
      let shown = 0;
      const groups = [];
      byLaw.forEach((list, lawId) => {
        total += list.length;
        const law = laws[lawId];
        const items = list.filter(ann => matches(ann, law, state))
          .sort((x, y) => compareKeys(provisionOrderKey(x.p), provisionOrderKey(y.p)) || (x.a || 0) - (y.a || 0));
        if (!items.length) return;
        shown += items.length;
        const latest = Math.max(...list.map(a => a.u || a.a || 0));
        groups.push({ lawId, law, items, latest });
      });
      groups.sort((x, y) => y.latest - x.latest);

      groups.forEach(({ lawId, law, items }) => {
        const section = document.createElement('section');
        section.className = 'notes-law';
        const head = document.createElement('div');
        head.className = 'notes-law-head';
        const h2 = document.createElement('h2');
        h2.className = 'notes-law-title';
        setTextWithMarks(h2, law.title, state.query);
        if (!law.named) h2.title = 'この端末で開いたことのない法令なので、法令名の代わりに法令IDから組み立てた番号を出しています（一度開くと法令名が出ます）';
        head.appendChild(h2);
        if (law.lawNum) {
          const num = document.createElement('span');
          num.className = 'notes-law-num';
          num.textContent = law.lawNum;
          head.appendChild(num);
        }
        const count = document.createElement('span');
        count.className = 'notes-law-count';
        count.textContent = `${items.length}件`;
        head.appendChild(count);
        const open = document.createElement('a');
        open.className = 'notes-btn';
        open.href = lawUrl(lawId);
        open.target = '_blank';
        open.rel = 'noopener';
        open.textContent = '法令を開く';
        head.appendChild(open);
        section.appendChild(head);

        const ul = document.createElement('ul');
        ul.className = 'notes-items';
        items.forEach(ann => ul.appendChild(buildItem(lawId, ann)));
        section.appendChild(ul);
        listEl.appendChild(section);
      });

      const lawCount = Array.from(byLaw.values()).filter(l => l.length).length;
      summaryEl.textContent = total ? `${lawCount} 法令・${total} 件` : '';
      if (total === 0) {
        emptyEl.textContent = 'まだマーカー・メモはありません。条文の語句を選ぶと出る帯から、マーカーを引いたりメモを書いたりできます。';
        emptyEl.hidden = false;
      } else if (shown === 0) {
        emptyEl.textContent = '当てはまるマーカー・メモはありません。検索語や絞り込みを変えてお試しください。';
        emptyEl.hidden = false;
      } else {
        emptyEl.hidden = true;
      }
      if (total && (state.normalizedQuery || state.filter !== 'all' || state.memoOnly)) {
        setStatus(`${shown} 件が当てはまります。`, false, 'filter');
      } else if (statusEl.dataset.kind === 'filter') {
        setStatus('', false, 'filter');
      }
    }

    let searchTimer = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.query = searchInput.value; render(); }, 150);
    });
    chips.forEach(chip => chip.addEventListener('click', () => {
      state.filter = chip.dataset.filter;
      chips.forEach(c => c.setAttribute('aria-pressed', c === chip ? 'true' : 'false'));
      render();
    }));
    memoOnly.addEventListener('change', () => { state.memoOnly = memoOnly.checked; render(); });

    // 条文ページや別の端末（同期）で変わったら描き直す（書き直し中は待つ）
    if (ext.onAnnotationsChanged) {
      ext.onAnnotationsChanged(async () => {
        if (editingId) return;
        await load();
        render();
      });
    }

    const initialQuery = new URLSearchParams(location.search).get('q');
    if (initialQuery) {
      searchInput.value = initialQuery;
      state.query = initialQuery;
    }
    await load();
    render();
  });

  // テスト用
  ext._testNotes = { provisionOrderKey, compareKeys, matches };

})(window.egovExt);

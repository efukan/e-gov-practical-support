/**
 * annotation_store.js
 *
 * マーカー・メモの保存。条文ページ（content script）・ポップアップ・設定画面の3か所から読み込まれる。
 *
 * 保存先は2つから選ぶ（どちらを使うかは端末ごとに chrome.storage.local の egovAnnotationMode に置く）。
 * - 端末の中（初期値）: chrome.storage.local に、法令ごとに1つの配列（egovNotes:<法令ID>）で置く。量の上限はほぼ無い
 * - 同期: chrome.storage.sync に、1件ずつ別の項目（egovMk:<法令ID>:<ID>）で置く。同期ストレージは全体で約100KB・
 *   1項目8KB・最大512項目しかなく、お気に入り（最大300件）と分け合うので、マーカー・メモの枠を
 *   ANNOTATION_SYNC_BUDGET バイト・ANNOTATION_SYNC_MAX_ITEMS 件に決め、メモの長さにも上限を設ける
 *
 * 1件の形（同期の容量を節約するため短い名前にしている）:
 *   { id, k: 'text'|'provision', p: 条・項・号の要素ID, l: 「第6条第1項」のような名前,
 *     q: 選んだ語句, b: その前の数文字, f: その後の数文字, o: 語句の位置の目安, c: 色(1〜3), m: メモ, a: 作った日時, u: 直した日時 }
 */

window.egovExt = window.egovExt || {};

(function(ext) {

  /** 保存先（'local' | 'sync'）を置く chrome.storage.local のキー。端末ごとに選ぶ */
  ext.ANNOTATION_MODE_KEY = 'egovAnnotationMode';

  const LOCAL_PREFIX = 'egovNotes:';
  const SYNC_PREFIX = 'egovMk:';

  /** 同期のときに、マーカー・メモに使ってよい大きさ（バイト）と件数 */
  ext.ANNOTATION_SYNC_BUDGET = 60 * 1024;
  ext.ANNOTATION_SYNC_MAX_ITEMS = 180;

  /** メモの長さの上限（文字）。同期のときは1項目8KBに収まるよう短くする */
  ext.ANNOTATION_MEMO_MAX = Object.freeze({ local: 5000, sync: 500 });

  /** 選んだ語句の長さの上限（文字） */
  ext.ANNOTATION_QUOTE_MAX = 300;

  /** 書き出したファイルの形式名 */
  const EXPORT_FORMAT = 'egov-himotoki-annotations';

  const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

  /**
   * 同期ストレージでの大きさ（キーの長さ＋値を JSON にした長さ。UTF-8 のバイト数で数える）
   * @param {string} key
   * @param {*} value
   * @returns {number}
   */
  function byteSize(key, value) {
    const text = key + JSON.stringify(value);
    return encoder ? encoder.encode(text).length : unescape(encodeURIComponent(text)).length;
  }
  ext.annotationByteSize = byteSize;

  /**
   * 失敗したときの利用者向けの説明
   * @param {{reason?: string}} result
   * @returns {string}
   */
  ext.describeAnnotationError = function(result) {
    switch (result && result.reason) {
      case 'tooLong':
        return `メモが長すぎます（同期しているときは${ext.ANNOTATION_MEMO_MAX.sync}字、していないときは${ext.ANNOTATION_MEMO_MAX.local}字まで）`;
      case 'quoteTooLong':
        return `選んだ範囲が長すぎます（${ext.ANNOTATION_QUOTE_MAX}字まで）`;
      case 'full':
        return '同期できるマーカー・メモの量がいっぱいです。使わないものを消すか、設定画面で保存先を「この端末の中」にしてください';
      case 'quota':
        return 'ブラウザの同期の保存容量がいっぱいで保存できませんでした';
      default:
        return 'マーカー・メモを保存できませんでした。もう一度お試しください';
    }
  };

  /**
   * いまの保存先
   * @returns {Promise<'local'|'sync'>}
   */
  ext.getAnnotationMode = async function() {
    try {
      const result = await chrome.storage.local.get(ext.ANNOTATION_MODE_KEY);
      return result && result[ext.ANNOTATION_MODE_KEY] === 'sync' ? 'sync' : 'local';
    } catch (e) {
      return 'local';
    }
  };

  /** 短い ID（同期の容量を節約するため8文字） */
  ext.newAnnotationId = function() {
    return (Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 6)).slice(0, 8);
  };

  function syncKey(lawId, id) {
    return `${SYNC_PREFIX}${lawId}:${id}`;
  }

  function stripId(ann) {
    const v = Object.assign({}, ann);
    delete v.id;
    return v;
  }

  /**
   * ある保存先から、法令ごとのマーカー・メモをすべて読む
   * @param {'local'|'sync'} mode
   * @returns {Promise<Map<string, Object[]>>} 法令ID → 一覧
   */
  async function readAll(mode) {
    const byLaw = new Map();
    const area = mode === 'sync' ? chrome.storage.sync : chrome.storage.local;
    const all = (await area.get(null)) || {};
    Object.keys(all).forEach(key => {
      if (mode === 'local' && key.startsWith(LOCAL_PREFIX) && Array.isArray(all[key])) {
        byLaw.set(key.slice(LOCAL_PREFIX.length), all[key].filter(a => a && a.id));
      } else if (mode === 'sync' && key.startsWith(SYNC_PREFIX) && all[key]) {
        const rest = key.slice(SYNC_PREFIX.length);
        const sep = rest.lastIndexOf(':');
        if (sep <= 0) return;
        const lawId = rest.slice(0, sep);
        const list = byLaw.get(lawId) || [];
        list.push(Object.assign({ id: rest.slice(sep + 1) }, all[key]));
        byLaw.set(lawId, list);
      }
    });
    byLaw.forEach(list => list.sort((x, y) => (x.a || 0) - (y.a || 0)));
    return byLaw;
  }

  /**
   * 法令のマーカー・メモを読む（作った順）
   * @param {string} lawId
   * @returns {Promise<Object[]>}
   */
  ext.loadAnnotations = async function(lawId) {
    if (!lawId) return [];
    try {
      const mode = await ext.getAnnotationMode();
      if (mode === 'local') {
        const key = LOCAL_PREFIX + lawId;
        const result = await chrome.storage.local.get(key);
        const list = result && result[key];
        return Array.isArray(list) ? list.filter(a => a && a.id) : [];
      }
      return (await readAll('sync')).get(lawId) || [];
    } catch (e) {
      console.error('egov-ext: マーカー・メモの読み込みに失敗しました:', e);
      return [];
    }
  };

  /**
   * すべての法令のマーカー・メモを読む
   * @returns {Promise<Map<string, Object[]>>}
   */
  ext.loadAllAnnotations = async function() {
    try {
      return await readAll(await ext.getAnnotationMode());
    } catch (e) {
      console.error('egov-ext: マーカー・メモの読み込みに失敗しました:', e);
      return new Map();
    }
  };

  /**
   * 同期ストレージでマーカー・メモが使っている量
   * @param {Object} [all] - chrome.storage.sync.get(null) の結果（あれば読み直さない）
   * @returns {Promise<{bytes: number, items: number, budget: number, maxItems: number}>}
   */
  ext.getAnnotationSyncUsage = async function(all) {
    const data = all || (await chrome.storage.sync.get(null)) || {};
    let bytes = 0;
    let items = 0;
    Object.keys(data).forEach(key => {
      if (!key.startsWith(SYNC_PREFIX)) return;
      bytes += byteSize(key, data[key]);
      items++;
    });
    return { bytes, items, budget: ext.ANNOTATION_SYNC_BUDGET, maxItems: ext.ANNOTATION_SYNC_MAX_ITEMS };
  };

  /**
   * 保存できる形か（長さ）を確かめる
   * @param {Object} ann
   * @param {'local'|'sync'} mode
   * @returns {string|null} だめな理由
   */
  function validate(ann, mode) {
    if ((ann.m || '').length > ext.ANNOTATION_MEMO_MAX[mode]) return 'tooLong';
    if ((ann.q || '').length > ext.ANNOTATION_QUOTE_MAX) return 'quoteTooLong';
    return null;
  }

  /**
   * マーカー・メモを1件保存する（同じ ID があれば置き換える）
   * @param {string} lawId
   * @param {Object} ann
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  ext.saveAnnotation = async function(lawId, ann) {
    try {
      const mode = await ext.getAnnotationMode();
      const invalid = validate(ann, mode);
      if (invalid) return { ok: false, reason: invalid };
      const value = Object.assign({}, ann, { u: Date.now() });
      if (!value.a) value.a = value.u;

      if (mode === 'local') {
        const key = LOCAL_PREFIX + lawId;
        const result = await chrome.storage.local.get(key);
        const list = Array.isArray(result && result[key]) ? result[key] : [];
        const index = list.findIndex(a => a.id === value.id);
        if (index >= 0) list[index] = value;
        else list.push(value);
        await chrome.storage.local.set({ [key]: list });
        return { ok: true };
      }

      const key = syncKey(lawId, value.id);
      const all = (await chrome.storage.sync.get(null)) || {};
      const usage = await ext.getAnnotationSyncUsage(all);
      const stored = stripId(value);
      const before = all[key] ? byteSize(key, all[key]) : 0;
      const after = byteSize(key, stored);
      if (!all[key] && usage.items >= ext.ANNOTATION_SYNC_MAX_ITEMS) return { ok: false, reason: 'full' };
      if (usage.bytes - before + after > ext.ANNOTATION_SYNC_BUDGET) return { ok: false, reason: 'full' };
      await chrome.storage.sync.set({ [key]: stored });
      return { ok: true };
    } catch (e) {
      const quota = /quota/i.test(String(e && e.message));
      (quota ? console.debug : console.error)('egov-ext: マーカー・メモの保存に失敗しました:', e);
      return { ok: false, reason: quota ? 'quota' : 'error' };
    }
  };

  /**
   * マーカー・メモを1件消す
   * @param {string} lawId
   * @param {string} id
   * @returns {Promise<{ok: boolean}>}
   */
  ext.removeAnnotation = async function(lawId, id) {
    try {
      const mode = await ext.getAnnotationMode();
      if (mode === 'local') {
        const key = LOCAL_PREFIX + lawId;
        const result = await chrome.storage.local.get(key);
        const list = (Array.isArray(result && result[key]) ? result[key] : []).filter(a => a.id !== id);
        if (list.length > 0) await chrome.storage.local.set({ [key]: list });
        else await chrome.storage.local.remove(key);
      } else {
        await chrome.storage.sync.remove(syncKey(lawId, id));
      }
      return { ok: true };
    } catch (e) {
      console.error('egov-ext: マーカー・メモの削除に失敗しました:', e);
      return { ok: false, reason: 'error' };
    }
  };

  /**
   * 法令ごとの一覧を、指定した保存先へ書く（同期の枠・長さを確かめてから）
   * @param {Map<string, Object[]>} byLaw
   * @param {'local'|'sync'} mode
   * @returns {Promise<{ok: boolean, reason?: string, bytes?: number, items?: number, tooLong?: number}>}
   */
  async function writeAll(byLaw, mode) {
    let tooLong = 0;
    byLaw.forEach(list => list.forEach(a => { if (validate(a, mode)) tooLong++; }));
    if (tooLong > 0) return { ok: false, reason: 'tooLong', tooLong };

    if (mode === 'local') {
      const items = {};
      byLaw.forEach((list, lawId) => { if (list.length) items[LOCAL_PREFIX + lawId] = list; });
      if (Object.keys(items).length) await chrome.storage.local.set(items);
      return { ok: true };
    }
    const items = {};
    let bytes = 0;
    let count = 0;
    byLaw.forEach((list, lawId) => list.forEach(a => {
      const key = syncKey(lawId, a.id);
      const value = stripId(a);
      items[key] = value;
      bytes += byteSize(key, value);
      count++;
    }));
    if (bytes > ext.ANNOTATION_SYNC_BUDGET || count > ext.ANNOTATION_SYNC_MAX_ITEMS) {
      return { ok: false, reason: 'full', bytes, items: count };
    }
    if (count) await chrome.storage.sync.set(items); // まとめて1回の書き込みにする（1分120回の上限）
    return { ok: true, bytes, items: count };
  }

  /**
   * 保存先を切り替え、いまある分をすべて移す。移せないとき（同期の枠を超える・メモが長すぎる）は切り替えない
   * @param {'local'|'sync'} target
   * @returns {Promise<{ok: boolean, reason?: string, bytes?: number, items?: number, tooLong?: number}>}
   */
  ext.setAnnotationMode = async function(target) {
    const current = await ext.getAnnotationMode();
    if (current === target) return { ok: true };
    try {
      const byLaw = await readAll(current);
      const written = await writeAll(byLaw, target);
      if (!written.ok) return written;
      await chrome.storage.local.set({ [ext.ANNOTATION_MODE_KEY]: target });
      // 移し終えてから、元の保存先から消す
      if (current === 'local') {
        const keys = Array.from(byLaw.keys()).map(id => LOCAL_PREFIX + id);
        if (keys.length) await chrome.storage.local.remove(keys);
      } else {
        const keys = [];
        byLaw.forEach((list, lawId) => list.forEach(a => keys.push(syncKey(lawId, a.id))));
        if (keys.length) await chrome.storage.sync.remove(keys);
      }
      return Object.assign({ ok: true }, written);
    } catch (e) {
      console.error('egov-ext: 保存先の切り替えに失敗しました:', e);
      return { ok: false, reason: 'error' };
    }
  };

  /**
   * すべてのマーカー・メモを書き出す形にする
   * @returns {Promise<{format: string, version: number, exportedAt: string, laws: Object<string, Object[]>}>}
   */
  ext.exportAnnotations = async function() {
    const byLaw = await ext.loadAllAnnotations();
    const laws = {};
    byLaw.forEach((list, lawId) => { if (list.length) laws[lawId] = list; });
    return { format: EXPORT_FORMAT, version: 1, exportedAt: new Date().toISOString(), laws };
  };

  /**
   * 書き出したものを読み込む。同じ ID は、直した日時の新しいほうを残す
   * @param {Object} data
   * @returns {Promise<{ok: boolean, reason?: string, added?: number, updated?: number}>}
   */
  ext.importAnnotations = async function(data) {
    if (!data || data.format !== EXPORT_FORMAT || typeof data.laws !== 'object') {
      return { ok: false, reason: 'format' };
    }
    const mode = await ext.getAnnotationMode();
    const byLaw = await readAll(mode);
    let added = 0;
    let updated = 0;
    Object.keys(data.laws).forEach(lawId => {
      if (!/^[0-9A-Za-z_]+$/.test(lawId) || !Array.isArray(data.laws[lawId])) return;
      const list = byLaw.get(lawId) || [];
      data.laws[lawId].forEach(incoming => {
        if (!incoming || typeof incoming.id !== 'string' || typeof incoming.p !== 'string') return;
        const clean = {
          id: incoming.id.slice(0, 16), k: incoming.k === 'provision' ? 'provision' : 'text',
          p: incoming.p, l: String(incoming.l || ''), q: String(incoming.q || ''), b: String(incoming.b || ''),
          f: String(incoming.f || ''), o: Number(incoming.o) || 0, c: [1, 2, 3].includes(incoming.c) ? incoming.c : 1,
          m: String(incoming.m || ''), a: Number(incoming.a) || Date.now(), u: Number(incoming.u) || Date.now()
        };
        const index = list.findIndex(a => a.id === clean.id);
        if (index < 0) { list.push(clean); added++; }
        else if ((list[index].u || 0) < clean.u) { list[index] = clean; updated++; }
      });
      byLaw.set(lawId, list);
    });
    const written = await writeAll(byLaw, mode);
    if (!written.ok) return written;
    return { ok: true, added, updated };
  };

  /**
   * マーカー・メモが（このタブ・別のタブ・同期している別の端末で）変わったら呼ぶ
   * @param {Function} callback
   */
  ext.onAnnotationsChanged = function(callback) {
    if (!chrome.storage || !chrome.storage.onChanged) return;
    chrome.storage.onChanged.addListener((changes, areaName) => {
      const keys = Object.keys(changes || {});
      const hit = keys.some(key =>
        (areaName === 'local' && (key.startsWith(LOCAL_PREFIX) || key === ext.ANNOTATION_MODE_KEY)) ||
        (areaName === 'sync' && key.startsWith(SYNC_PREFIX)));
      if (hit) callback();
    });
  };

})(window.egovExt);

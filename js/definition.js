/**
 * definition.js
 *
 * 定義語ホバー辞書：定義語の抽出、宣言の効く範囲の読み取り、本文への下線付けを受け持つモジュール。
 *
 * 語の見つけ方・語として採るか・範囲の読み方・本文で塗ってよいかの規則は、
 * 法令ひもとき（src/shared/defTerms.ts）から移したもの。そちらで実際の法令を使って確かめた判断
 * （「とは」のあとに読点を求めない、宣言された語は字数で疑わない、「同法」の「法」を塗らない、
 * 範囲を限った宣言は条どまりで読む、読めない範囲は広い方に倒す等）をそのまま引き継ぐ。
 * ここで足しているのは、e-Gov の画面（新旧 2 通りの表示）から条・項・号を読み取る部分。
 */

window.egovExt = window.egovExt || {};

(function(ext) {
  /**
   * 定義語ホバー辞書のツールチップインスタンス（js/tooltip.js の createTooltip の戻り値）
   * @type {Object|null}
   */
  ext.definitionTooltip = null;

  /**
   * 語 → その語の定義の一覧（範囲の違う同じ語を別々に持つ）。
   * ext.definitionMap（utils.js）には語ごとに代表の定義 1 つだけを置き、件数表示などに使う
   * @type {Map<string, Object[]>}
   */
  ext.definitionDefs = new Map();

  /**
   * 抽出した定義の通し番号順の一覧。本文の下線（span）は data-def-index でここを指す
   * @type {Object[]}
   */
  ext.definitionList = [];

  /* ------------------------------------------------------------------ */
  /* 数字                                                                 */
  /* ------------------------------------------------------------------ */

  const KAN_DIGIT = { '〇': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  const KAN_UNIT = { '十': 10, '百': 100, '千': 1000 };

  /**
   * 漢数字（万未満）・算用数字（全角・半角）→ 数値。
   * 本文は横書き表記変換で算用数字に書き換わっていることがあるので、どちらも受ける
   * @param {string} s
   * @returns {number|null}
   */
  function numeralToNumber(s) {
    if (!s) return null;
    const half = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    if (/^[0-9]+$/.test(half)) return Number(half);
    let total = 0;
    let current = 0;
    for (const ch of s) {
      if (ch in KAN_DIGIT) {
        current = current * 10 + KAN_DIGIT[ch];
      } else if (ch in KAN_UNIT) {
        total += (current === 0 ? 1 : current) * KAN_UNIT[ch];
        current = 0;
      } else {
        return null;
      }
    }
    return total + current;
  }

  /**
   * 数値 → 漢数字（万未満）
   * @param {number} n
   * @returns {string}
   */
  function numberToKanji(n) {
    if (!n) return '〇';
    const digits = '〇一二三四五六七八九';
    let out = '';
    let rest = n;
    [[1000, '千'], [100, '百'], [10, '十']].forEach(([u, label]) => {
      const q = Math.floor(rest / u);
      if (q > 0) {
        if (q > 1) out += digits[q];
        out += label;
        rest %= u;
      }
    });
    if (rest > 0) out += digits[rest];
    return out;
  }

  ext.numberToKanji = numberToKanji;

  /* ------------------------------------------------------------------ */
  /* 宣言の見つけ方（法令ひもとき defTerms.ts から）                       */
  /* ------------------------------------------------------------------ */

  /**
   * 定義語の宣言（鉤括弧「」）の形。
   * - 「以下「X」という」（「以下この節において」「以下単に」「と総称する」も）
   * - 「この法律において「X」という」
   * - 「「X」とは、…をいう」
   *
   * 「とは」のあとに読点を求めない。1 つの文で 2 つを定義する形は読点を置かない
   * （「「都市計画区域」とは次条の…区域を、「準都市計画区域」とは…区域をいう」）。
   * 並びは形の順。同じ括弧が 2 つの形に当たるとき、先の形（以下…）として扱う
   */
  const DECL_REGEXPS = [
    { re: /以下(?:この[^「」。]{0,30}?において)?(?:単に)?「([^「」]{1,60}?)」と(?:いう|総称する)/g, hereafter: true },
    { re: /において(?:単に)?「([^「」]{1,60}?)」という/g, hereafter: false },
    { re: /「([^「」]{1,60}?)」とは/g, hereafter: false, needsMeaning: true }
  ];

  /**
   * 文の中の定義語の宣言
   * @param {string} text
   * @returns {{start: number, end: number, term: string, hereafter: boolean}[]}
   */
  function declSpans(text) {
    const out = [];
    const seen = new Set();
    for (const form of DECL_REGEXPS) {
      const re = form.re;
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        const open = m[0].indexOf('「');
        if (open < 0) continue;
        const start = m.index + open;
        const close = text.indexOf('」', start);
        if (close < 0) continue;
        const end = close + 1;
        const key = `${start}:${end}`;
        if (seen.has(key)) continue;
        // 「「X」とは」は、同じ文の中で「…をいう」「…とする」と意味を与えているものに限る。
        // 読替え・引用（「「甲」とは「乙」と読み替える」の類）を定義語にしない
        if (form.needsMeaning) {
          const stop = text.indexOf('。', end);
          const rest = text.slice(end, stop < 0 ? undefined : stop);
          if (!/をい[うい]|とする|を含む|を除く|をいうもの/.test(rest)) continue;
        }
        seen.add(key);
        out.push({ start, end, term: m[1], hereafter: form.hereafter });
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* 語として採るか                                                       */
  /* ------------------------------------------------------------------ */

  /** 号・項の番号やイロハだけの語（号の見出しを誤って語にしない） */
  const ITEM_MARKER_REGEX = /^[()（）0-9０-９a-zA-Zａ-ｚＡ-Ｚ一二三四五六七八九十百イロハニホヘトチリヌルヲの]+$/;

  /**
   * 定義語らしさの判定。
   * 形で疑うのは号の Column（「用語｜意義」の 2 列）だけにする。附則の施行期日表など
   * 2 列の号だが定義でないもの（「第一条中…の改正規定｜公布の日」）を弾くための判定。
   * 「以下「X」という」「「X」とは」の宣言（declared）は、書き手が語を名指ししているので
   * 形では疑わない（「個人識別符号」「第一号被保険者」「建築基準法令の規定」も語になる）。
   * 句読点・括弧を含むものだけは、宣言でも語として扱えないので落とす
   * @param {string} term
   * @param {boolean} [declared=false]
   * @returns {boolean}
   */
  function isDefinitionTerm(term, declared = false) {
    const t = term.trim();
    if (!t || /[、。（）「」\s　]/.test(t)) return false;
    if (ITEM_MARKER_REGEX.test(t)) return false;
    if (declared) return true;
    if (t.length > 20) return false;
    if (/(とき|場合)$/.test(t)) return false;
    if (/^(次|前|附則)/.test(t)) return false;
    // 条・項・号を引く語（「第一条中…の改正規定」「前条」）は定義語ではない。
    // 「第一種低層住居専用地域」のような「第」で始まる名称は通す
    if (/第[〇一二三四五六七八九十百千0-9０-９]+[条項号]|[前次同各][条項号]|規定|附則/.test(t)) return false;
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* 宣言の効く範囲（法令ひもとき defTerms.ts から）                       */
  /* ------------------------------------------------------------------ */

  /*
   * 「以下この条において「指定」という」のように範囲を限った宣言を法令全体に塗ると、
   * 関係の無い条のふつうの言葉が定義語の色になり、乗せると別の条の定義が出る
   * （建築基準法の「指定」は第七十七条の十八から始まる節の中の語なのに、87 か所に色が付いていた）。
   * 条・項・号を限った宣言は条までを範囲にする（同じ条の中で別の意味に使われることはまず無い）。
   * 章・節・款は、要素 id に含まれる段（Mp-Pa_2-Ch_1-Se_1-At_22）から引く。
   *
   * ScopeEnv: { ids: 条 id の並び, cur: 宣言のある条の添字, numToIdx: 条番号（'77_18'）→ 添字,
   *             heads: 宣言のある条を囲む段 [{tag, key}]（外から順）, headIds: 段の key → 条 id の並び,
   *             suppl: 附則の中の宣言か }
   */

  const SCOPE_NUM = '[〇一二三四五六七八九十百千0-9０-９]+';
  const SCOPE_HEAD_TAG = { '編': 'Part', '章': 'Chapter', '節': 'Section', '款': 'Subsection', '目': 'Division' };
  const SCOPE_HEAD_RE = /^(?:この|本)(編|章|節|款|目)/;
  const SCOPE_IROHA = '[イロハニホヘトチリヌルヲワカヨタレソツネナラムウヰノオクヤマケフコエテアサキユメミシヱヒモセス]';
  const SCOPE_CUR_RE = new RegExp(
    `^(?:(?:この|本)(?:条|項|号|表)|前(?:${SCOPE_NUM}|各)?項|次項|前号|次号|第${SCOPE_NUM}項|第${SCOPE_NUM}号(?:の${SCOPE_NUM})*|(?:この)?${SCOPE_IROHA}(?=$|及び|並びに|、|から|まで|${SCOPE_IROHA}))(?:${SCOPE_IROHA})?`
  );
  const SCOPE_ART_RE = new RegExp(`^(附則)?第(${SCOPE_NUM})条((?:の${SCOPE_NUM})*)`);
  const SCOPE_NEAR_RE = new RegExp(`^(?:(次|前)条|前(${SCOPE_NUM})条)`);
  const SCOPE_SUB_RE = new RegExp(`^(?:第${SCOPE_NUM}項)?(?:第${SCOPE_NUM}号(?:の${SCOPE_NUM})*)?(?:各号)?`);
  const SCOPE_BRANCH_RE = new RegExp(`の(${SCOPE_NUM})`, 'g');

  const SCOPE_HEAD_ABBR = { '編': 'Pa', '章': 'Ch', '節': 'Se', '款': 'Ss', '目': 'Di' };
  const SCOPE_HEAD_PARENT = { 'Part': null, 'Chapter': 'Part', 'Section': 'Chapter', 'Subsection': 'Section', 'Division': 'Subsection' };
  const SCOPE_HEADNUM_RE = new RegExp(`^第(${SCOPE_NUM})(編|章|節|款|目)((?:の${SCOPE_NUM})*)`);

  /**
   * 「第三章」「第三章第二節」「第二節」のように番号で名指しした段を、段の key（Mp-Ch_3-Se_2）に直す。
   * 上の段を省いた「第二節」は、宣言のある条と同じ章の中の節として読む
   * （租税特別措置法第二条第二項「第三章において、次の各号に掲げる用語の意義は」）
   * @returns {{len: number, key: string}|null}
   */
  function readHeadByNumber(q, env) {
    let rest = q;
    let key = null;
    let len = 0;
    let m;
    while ((m = rest.match(SCOPE_HEADNUM_RE))) {
      const base = numeralToNumber(m[1]);
      const br = [];
      let b;
      SCOPE_BRANCH_RE.lastIndex = 0;
      while ((b = SCOPE_BRANCH_RE.exec(m[3]))) br.push(numeralToNumber(b[1]));
      if (base === null || br.some(x => x === null)) return null;
      const seg = `${SCOPE_HEAD_ABBR[m[2]]}_${[base, ...br].join('_')}`;
      if (key === null) {
        // 最初の段：宣言のある条の、一つ上の段の中で探す（無ければ本則の直下）
        const tag = SCOPE_HEAD_TAG[m[2]];
        const parentTag = SCOPE_HEAD_PARENT[tag];
        const parent = parentTag ? env.heads.find(h => h.tag === parentTag) : null;
        const candidate = `${parent ? parent.key : env.root}-${seg}`;
        if (env.headIds.has(candidate)) {
          key = candidate;
        } else {
          // 上の段が違う（編をまたいで章を名指しした）ときは、同じ番号の段が一つだけなら採る
          const found = Array.from(env.headIds.keys()).filter(k => k.endsWith(`-${seg}`));
          if (found.length !== 1) return null;
          key = found[0];
        }
      } else {
        key = `${key}-${seg}`;
        if (!env.headIds.has(key)) return null;
      }
      len += m[0].length;
      rest = rest.slice(m[0].length);
    }
    return key === null ? null : { len, key };
  }

  function readScopeItem(q, env, supplCarry) {
    const one = (len, at, bare = false) => {
      if (at < 0 || at >= env.ids.length) return null;
      const subMatch = q.slice(len).match(SCOPE_SUB_RE);
      const sub = subMatch ? subMatch[0].length : 0;
      return { len: len + sub, at, ids: [env.ids[at]], bare };
    };
    let m = q.match(SCOPE_HEAD_RE);
    if (m) {
      const tag = SCOPE_HEAD_TAG[m[1]];
      const h = env.heads.slice().reverse().find((n) => n.tag === tag);
      const ids = h ? env.headIds.get(h.key) : undefined;
      return ids ? { len: m[0].length, at: null, ids, bare: false } : null;
    }
    const head = !env.suppl ? readHeadByNumber(q, env) : null;
    if (head) {
      return { len: head.len, at: null, ids: env.headIds.get(head.key), bare: false };
    }
    m = q.match(SCOPE_ART_RE);
    if (m) {
      if (env.suppl ? !m[1] && !supplCarry : !!m[1]) return null;
      const base = numeralToNumber(m[2]);
      const br = [];
      let b;
      SCOPE_BRANCH_RE.lastIndex = 0;
      while ((b = SCOPE_BRANCH_RE.exec(m[3]))) br.push(numeralToNumber(b[1]));
      if (base === null || br.some((x) => x === null)) return null;
      const at = env.numToIdx.get([base, ...br].join('_'));
      return at === undefined ? null : one(m[0].length, at);
    }
    m = q.match(SCOPE_NEAR_RE);
    if (m) {
      if (m[1] === '次') return one(m[0].length, env.cur + 1);
      if (m[1] === '前') return one(m[0].length, env.cur - 1);
      const n = numeralToNumber(m[2]) || 0;
      if (n < 1 || env.cur - n < 0) return null;
      const subMatch = q.slice(m[0].length).match(SCOPE_SUB_RE);
      const sub = subMatch ? subMatch[0].length : 0;
      return { len: m[0].length + sub, at: null, ids: env.ids.slice(env.cur - n, env.cur), bare: false };
    }
    m = q.match(SCOPE_CUR_RE);
    if (m) return one(m[0].length, env.cur, !/^(?:この|本)条/.test(m[0]));
    return null;
  }

  function readScopeList(q, env, fromHere) {
    const out = new Set();
    let rest = q;
    let from = null;
    let carry = false;
    let first = true;
    while (rest) {
      const it = readScopeItem(rest, env, carry);
      if (!it) return null;
      carry = carry || (env.suppl && rest.startsWith('附則'));
      rest = rest.slice(it.len);
      if (first && fromHere && from === null && rest === 'まで') {
        // 「以下第三項まで」「以下附則第五条まで」：宣言のある条から、その条まで
        const to = it.bare ? env.cur : it.at;
        if (to === null) return null;
        from = env.cur;
        rest = 'まで';
        it.at = to;
        it.bare = false;
      }
      first = false;
      if (from !== null) {
        if (!rest.startsWith('まで')) return null;
        const to = it.bare ? from : it.at;
        if (to === null) return null;
        const a = Math.min(from, to);
        const b = Math.max(from, to);
        for (let k = a; k <= b; k++) out.add(env.ids[k]);
        rest = rest.slice(2);
        from = null;
      } else if (rest.startsWith('から')) {
        if (it.at === null) return null;
        from = it.at;
        rest = rest.slice(2);
        continue;
      } else {
        it.ids.forEach(id => out.add(id));
      }
      if (!rest) break;
      const sep = rest.match(/^(?:、|及び|並びに)/);
      if (!sep || sep[0].length === rest.length) return null;
      rest = rest.slice(sep[0].length);
    }
    return from === null && out.size ? Array.from(out) : null;
  }

  /**
   * 「…において」の「…」から範囲（条 id の並び）を読む。null は既定の範囲
   * （「この法律」、読めない書き方）——本則の宣言なら法令全体、附則ならその附則全体。
   * 読めないものは既定の範囲に倒す（狭く読み違えると、効くはずの条で色が消える）
   * @param {string} phrase
   * @param {Object} env
   * @returns {string[]|null}
   */
  function readDefScope(phrase, env) {
    const p = phrase.replace(/^以下/, '');
    if (/^この(?:法律|法|政令|省令|府令|規則|命令|附則|勅令|条例)$/.test(p)) return null;
    const starts = [0];
    for (let i = 0; i < p.length; i++) if (p[i] === '、') starts.push(i + 1);
    for (const s of starts) {
      const q = s === 0 ? phrase : p.slice(s);
      const r = readScopeList(q.replace(/^以下/, ''), env, q.startsWith('以下'));
      if (r) return r;
    }
    return null;
  }

  /**
   * text の end より前、文や括弧の切れ目までの句（「以下この節において」の「以下この節」）。
   * 空白でも切る。e-Gov の旧表示では条・項の見出し（「第二条　」）が本文と同じ要素に入っており、
   * 切らないと「第二条　第三章」を範囲として読もうとして失敗する（範囲の句に空白は入らない）
   */
  function phraseBefore(text, end) {
    const p = text.slice(Math.max(0, end - 80), end);
    const cut = Math.max(
      p.lastIndexOf('。'), p.lastIndexOf('「'), p.lastIndexOf('」'), p.lastIndexOf('（'), p.lastIndexOf('）'),
      p.lastIndexOf('　'), p.lastIndexOf(' '), p.lastIndexOf('\n'), p.lastIndexOf('\t')
    );
    return p.slice(cut + 1);
  }

  /** 宣言「X」（start は「の位置）の範囲を言う句。「…において」が前に無ければ null */
  function declScopePhrase(text, start) {
    const head = text.slice(Math.max(0, start - 80), start);
    const m = head.match(/において、?(?:単に)?$/);
    return m ? phraseBefore(head, m.index) : null;
  }

  /** 号の Column 定義の前置き（「この条において次の各号に掲げる用語の意義は」）の範囲を言う句 */
  function columnScopePhrase(lead) {
    const m = lead.match(/において、?(?:次の各号|次|同項各号|前項各号|各号)に掲げる用語の意義/);
    return m ? phraseBefore(lead, m.index) : null;
  }

  /* ------------------------------------------------------------------ */
  /* 本文の中で塗ってよいか（法令ひもとき defTerms.ts から）               */
  /* ------------------------------------------------------------------ */

  const KANJI_RE = /[一-鿿々]/;
  const KATAKANA_RE = /[ァ-ヺー]/;

  /**
   * 直前が漢字でもハイライトを許す接頭辞（定義語を修飾するだけで複合語を作らない語）。
   * 「当該建築物」「その他空家等」「各建築物」など
   */
  const DEF_PREFIX_ALLOW = [
    '当該', '同一', '同等', '同種', '共同', '連帯', '第三', '代表', '社外',
    '同', '本', '各', '前', '次', '新', '旧', '元', '全', '現', '根', '他', '等'
  ];

  /**
   * 定義語が法令の種類そのもの（「以下「法」という」の「法」）。
   * これに漢字が前に付いた形（「同法」「旧法」）は、定義の「法」ではなく別の法令を指す
   */
  const LAW_KIND_TERM_RE = /^(?:法|法律|令|政令|省令|府令|勅令|規則|条例)$/;

  /** 直後が漢字でもハイライトを許す接続詞 */
  const DEF_SUFFIX_CONJ = ['若しくは', '並びに', '又は', '及び'];

  /**
   * 直後が条の参照（「第二条」）。略称で呼ぶ法令のあとの条（「番号利用法第二条第五項」）は、
   * 「第」から始まる別の語なので複合語ではない（横書き表記変換後の「第２条」も受ける）
   */
  const DEF_ARTICLE_AFTER_RE = /^第[〇一二三四五六七八九十百千0-9０-９]+条/;

  /**
   * 直後が漢字でもハイライトを許す接尾辞（範囲・位置＋汎用の後続名詞）。
   * これらは「さらに漢字が 2 文字以上続くなら複合名詞」の例外判定を受ける
   */
  const DEF_SUFFIX_ALLOW = [
    '以外', '以上', '以下', '以内', '内', '外', '後', '前', '等',
    '対策', '対応', '活用', '管理', '整備', '設計', '設置', '関係', '行政', '支援', '推進'
  ].sort((a, b) => b.length - a.length);

  /**
   * 定義語の出現 [start,end) をハイライトしてよいか。
   * - 直前が漢字: DEF_PREFIX_ALLOW で終わるときのみ許可（複合名詞の途中を避ける）。
   *   法令の種類そのものの語（「法」）は、前に漢字が付いたら許可しない（「同法」）
   * - 直後が漢字: 接続詞・条の参照・DEF_SUFFIX_ALLOW で始まるときのみ許可。ただしその接尾辞の
   *   さらに後ろに漢字が 2 文字以上続く場合は複合名詞とみなして不許可（「空家等管理活用支援法人」）
   * - カタカナ語の途中（語の端と隣の字がどちらもカタカナ）は不許可（「データ」と「データベース」）
   * @param {string} text
   * @param {number} start
   * @param {number} end
   * @returns {boolean}
   */
  function isDefUseAllowed(text, start, end) {
    const term = text.slice(start, end);
    const before = start > 0 ? text[start - 1] : '';
    const after = text[end] || '';
    if (before && KATAKANA_RE.test(before) && KATAKANA_RE.test(term[0])) return false;
    if (after && KATAKANA_RE.test(after) && KATAKANA_RE.test(term[term.length - 1])) return false;
    if (before && KANJI_RE.test(before)) {
      if (LAW_KIND_TERM_RE.test(term)) return false;
      const head = text.slice(0, start);
      if (!DEF_PREFIX_ALLOW.some((p) => head.endsWith(p))) return false;
    }
    if (!after || !KANJI_RE.test(after)) return true;
    const rest = text.slice(end);
    if (DEF_SUFFIX_CONJ.some((s) => rest.startsWith(s))) return true;
    if (DEF_ARTICLE_AFTER_RE.test(rest)) return true;
    const sfx = DEF_SUFFIX_ALLOW.find((s) => rest.startsWith(s));
    if (!sfx) return false;
    let k = 0;
    while (k < 2 && KANJI_RE.test(rest[sfx.length + k] || '')) k++;
    return k < 2;
  }

  /* ------------------------------------------------------------------ */
  /* e-Gov の画面から条・項・号を読む                                     */
  /* ------------------------------------------------------------------ */

  /*
   * e-Gov の本文には 2 通りの表示がある。
   * - 新しい表示（article.article > div.paragraph > div.item > div.column > p.sentence）。号は項の中に入れ子
   * - 大きな法令の旧表示（section.Article > div._div_ArticleTitle / _div_ParagraphSentence /
   *   _div_ItemSentence）。項と号は兄弟として平らに並び、号の Column は span で並ぶ
   * どちらも要素 id は同じ形（Mp-Pa_1-Ch_1-At_2-Pr_1-It_9_2。附則は「法令番号-Sp-At_1」、
   * 別表は「Mpat_1」）で、号の枝番も id に入っている（It_9_2 が「九の二」）。
   * 位置と見出しは id から読む。
   */

  /** 条・項・号などの単位を表す要素 id */
  const UNIT_ID_RE = /^(?:Mp-|Mpat_|[0-9A-Za-z]+-Sp(?:-|$)|EnactStatement|Preamble)/;

  /** 旧表示で号の細分（イ・ロ）を表す要素（id を持たず、直前の号の後ろに兄弟として並ぶ） */
  const OLD_SUBITEM_RE = /(?:^|\s)_div_Subitem\d*Sentence(?:\s|$)/;

  /**
   * 要素の属する単位（id を持つ条・項・号の要素）を返す
   * @param {Element} el
   * @returns {Element|null}
   */
  function locateUnit(el) {
    let cur = el && el.nodeType === 1 ? el : (el ? el.parentElement : null);
    while (cur && cur !== document.body) {
      if (cur.id && UNIT_ID_RE.test(cur.id)) return cur;
      if (typeof cur.className === 'string' && OLD_SUBITEM_RE.test(cur.className)) {
        let p = cur.previousElementSibling;
        while (p) {
          if (p.id && UNIT_ID_RE.test(p.id)) return p;
          p = p.previousElementSibling;
        }
      }
      cur = cur.parentElement;
    }
    return null;
  }

  /**
   * 単位の id を読む
   * @param {string} id
   * @returns {{group: string, articleId: string|null, articleNum: string|null, para: number|null, items: number[]|null, heads: {tag: string, key: string}[]}}
   */
  function parseUnitId(id) {
    const out = { group: id, articleId: null, articleNum: null, para: null, items: null, heads: [] };
    let rest = '';
    let m;
    if (id.startsWith('Mp-')) {
      out.group = 'Mp';
      rest = id.slice(3);
    } else if ((m = id.match(/^([0-9A-Za-z]+-Sp)(?:-(.*))?$/))) {
      out.group = m[1];
      rest = m[2] || '';
      out.articleId = m[1];
    } else if ((m = id.match(/^(Mpat_[0-9_]+)(?:-(.*))?$/))) {
      out.group = m[1];
      rest = m[2] || '';
    } else {
      return out;
    }
    const HEAD_TAG = { Pa: 'Part', Ch: 'Chapter', Se: 'Section', Ss: 'Subsection', Di: 'Division' };
    const segs = rest ? rest.split('-') : [];
    let prefix = out.group;
    for (const seg of segs) {
      const sm = seg.match(/^([A-Za-z]+\d*)_([0-9_]+)$/);
      prefix += '-' + seg;
      if (!sm) continue;
      const kind = sm[1];
      const nums = sm[2].split('_').map(Number);
      if (HEAD_TAG[kind] && !out.articleNum) {
        out.heads.push({ tag: HEAD_TAG[kind], key: prefix });
      } else if (kind === 'At') {
        out.articleId = prefix;
        out.articleNum = nums.join('_');
      } else if (kind === 'Pr') {
        out.para = nums[0];
      } else if (kind === 'It') {
        out.items = nums;
      }
    }
    return out;
  }

  /**
   * 附則の見出しを短くする（「附　則　（昭和二二年四月一六日法律第六一号）　抄」→「附則（昭和二二年法律第六一号）」）
   * @param {Element} supplEl
   * @returns {string}
   */
  function supplLabelOf(supplEl, groupId) {
    const lawId = ext.getLawIdFromUrl ? ext.getLawIdFromUrl(window.location.href) : '';
    if (!supplEl || (lawId && groupId === `${lawId}-Sp`)) return '附則';
    const labelEl = supplEl.querySelector('.SupplProvisionLabel, ._div_SupplProvisionLabel, .supplprovisionlabel');
    const raw = labelEl ? labelEl.textContent.replace(/[\s　]+/g, '') : '';
    const m = raw.match(/（((?:明治|大正|昭和|平成|令和)[〇一二三四五六七八九十元0-9０-９]+年)[^）]*?((?:法律|政令|勅令|省令|府令|規則|告示|命令)第[^）]+?号)）/);
    return m ? `附則（${m[1]}${m[2]}）` : '附則';
  }

  /**
   * 附則・別表の呼び名（「附則」「附則（平成一五年法律第一三四号）」「別表第二」）
   * @param {string} group - parseUnitId の group
   * @param {Element} [near] - id で引けないときに祖先をたどる起点
   * @returns {string}
   */
  function groupLabel(group, near) {
    if (group.endsWith('-Sp')) {
      return supplLabelOf(document.getElementById(group) || (near ? ext.deepClosest(near, '.SupplProvision, .supplprovision') : null), group);
    }
    if (group.startsWith('Mpat_')) {
      const appdx = document.getElementById(group);
      const title = appdx ? appdx.querySelector('.AppdxTableTitle, ._div_AppdxTableTitle, .appdxtable-title, [class*="AppdxTableTitle"]') : null;
      return title ? title.textContent.trim().split(/[\s　（(]/)[0] : '別表';
    }
    return '';
  }

  /**
   * 条の見出し（「（用語の定義）」）
   * @param {Element|null} article
   * @returns {string}
   */
  function captionOf(article) {
    if (!article) return '';
    const headingEl = article.querySelector('.ArticleCaption, ._div_ArticleCaption, .articleheading, em.articleheading');
    return headingEl ? headingEl.textContent.trim() : '';
  }

  /**
   * 条がいくつの項を持つか（項が一つの条は、引用で「第一項」を書かない）
   * @param {string} articleId
   * @returns {number}
   */
  function paragraphCountOf(articleId) {
    if (paragraphCountCache && paragraphCountCache.has(articleId)) return paragraphCountCache.get(articleId);
    const re = new RegExp(`^${articleId.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}-Pr_\\d+$`);
    // 条の要素の中だけを探す（文書全体を定義の数だけ探すと、大きな法令で数秒止まる）
    const scope = document.getElementById(articleId) || document.body;
    const nodes = scope.querySelectorAll(`[id^="${articleId}-Pr_"]`);
    let n = 0;
    for (let i = 0; i < nodes.length; i++) if (re.test(nodes[i].id)) n++;
    if (paragraphCountCache) paragraphCountCache.set(articleId, n);
    return n;
  }

  /**
   * 抽出の間だけ使う、条ごとの項の数の控え（抽出が終われば捨てる）
   * @type {Map<string, number>|null}
   */
  let paragraphCountCache = null;

  /**
   * 要素の位置を「（見出し）第二条第九号の二」の形で言う（定義語ポップアップの見出し）。
   * 番号は id から作る。号の見出しの文字（横書き変換で「(9の2)」になっていることがある）や
   * 並び順からは作らない（枝番の号があると、並び順と号番号がずれる）
   * @param {Element} element
   * @returns {string}
   */
  function getSourceClauseNumber(element) {
    const unit = locateUnit(element) || element;
    if (!unit || !unit.id) return '';
    const info = parseUnitId(unit.id);

    let base = '';
    if (info.group.endsWith('-Sp') || info.group.startsWith('Mpat_')) {
      base = groupLabel(info.group, unit);
    } else if (/^EnactStatement/.test(info.group)) {
      return '制定文';
    } else if (/^Preamble/.test(info.group)) {
      return '前文';
    }

    let clause = '';
    let article = null;
    if (info.articleNum) {
      const nums = info.articleNum.split('_').map(Number);
      clause += `第${numberToKanji(nums[0])}条` + nums.slice(1).map(n => `の${numberToKanji(n)}`).join('');
      article = document.getElementById(info.articleId) || ext.deepClosest(unit, '.Article, ._div_Article, section.Article, .article, article');
    }
    if (info.para !== null) {
      const scopeId = info.articleNum ? info.articleId : info.group;
      if (info.para > 1 || paragraphCountOf(scopeId) > 1) {
        clause += `第${numberToKanji(info.para)}項`;
      }
    }
    if (info.items) {
      clause += `第${numberToKanji(info.items[0])}号` + info.items.slice(1).map(n => `の${numberToKanji(n)}`).join('');
    }

    const heading = info.articleNum ? captionOf(article) : '';
    return heading + base + clause;
  }

  /* ------------------------------------------------------------------ */
  /* 範囲の手がかり（条の並び・段）                                        */
  /* ------------------------------------------------------------------ */

  /**
   * 本文中の条を、本則・附則ごとに並べる
   * @param {Element} container
   * @returns {Map<string, {ids: string[], numToIdx: Map<string, number>, idToIdx: Map<string, number>, headIds: Map<string, string[]>}>}
   */
  function buildArticleIndex(container) {
    const groups = new Map();
    const getGroup = (key) => {
      let g = groups.get(key);
      if (!g) {
        g = { ids: [], numToIdx: new Map(), idToIdx: new Map(), headIds: new Map() };
        groups.set(key, g);
      }
      return g;
    };
    const nodes = ext.deepQuerySelectorAll(container, '[id*="At_"]');
    for (let i = 0; i < nodes.length; i++) {
      const id = nodes[i].id;
      if (!/-At_[0-9_]+$/.test(id) || !UNIT_ID_RE.test(id)) continue;
      const info = parseUnitId(id);
      const g = getGroup(info.group);
      if (g.idToIdx.has(id)) continue;
      g.idToIdx.set(id, g.ids.length);
      if (!g.numToIdx.has(info.articleNum)) g.numToIdx.set(info.articleNum, g.ids.length);
      g.ids.push(id);
      info.heads.forEach(h => {
        const list = g.headIds.get(h.key);
        if (list) list.push(id); else g.headIds.set(h.key, [id]);
      });
    }
    return groups;
  }

  /**
   * 宣言の範囲を決める
   * @param {string|null} phrase - 範囲を言う句（無ければ null）
   * @param {Object} info - parseUnitId の結果
   * @param {Map} index - buildArticleIndex の結果
   * @returns {{kind: 'global'}|{kind: 'group', group: string}|{kind: 'articles', ids: Set<string>}}
   */
  function resolveScope(phrase, info, index) {
    const suppl = info.group.endsWith('-Sp');
    // 附則・別表の中の宣言は、既定ではその附則・別表の中だけで効く。改正附則は「新法」「施行日」の
    // ようなその改正だけの語を宣言し、別表は他の法令の条を並べる中で語を宣言するので、
    // 法令全体に塗るとふつうの言葉に色が付く（地方自治法の別表第一の「施行日」）
    const fallback = (suppl || info.group.startsWith('Mpat_'))
      ? { kind: 'group', group: info.group, label: groupLabel(info.group) }
      : { kind: 'global' };
    if (phrase === null || !info.articleId) return fallback;
    const g = index.get(info.group);
    const cur = g ? g.idToIdx.get(info.articleId) : undefined;
    if (!g || cur === undefined) return fallback;
    const env = { ids: g.ids, cur, numToIdx: g.numToIdx, heads: info.heads, headIds: g.headIds, suppl, root: info.group };
    const ids = readDefScope(phrase, env);
    if (!ids) return fallback;
    return { kind: 'articles', ids: new Set(ids), label: articlesScopeLabel(ids, g, headKeyOfPhrase(phrase, env), info.group) };
  }

  /**
   * 範囲の句が段（編・章・節・款・目）一つだけを指していれば、その段の key
   * （「以下この節」「第三章」）。条を並べた句なら null
   * @param {string} phrase
   * @param {Object} env
   * @returns {string|null}
   */
  function headKeyOfPhrase(phrase, env) {
    const p = phrase.replace(/^以下/, '');
    const m = p.match(SCOPE_HEAD_RE);
    if (m && m[0] === p) {
      const tag = SCOPE_HEAD_TAG[m[1]];
      const h = env.heads.slice().reverse().find(n => n.tag === tag);
      return h ? h.key : null;
    }
    if (!env.suppl) {
      const head = readHeadByNumber(p, env);
      if (head && head.len === p.length) return head.key;
    }
    return null;
  }

  /**
   * 段の key（Mp-Pa_2-Ch_3-Se_2_2）を「第二編第三章第二節の二」にする
   * @param {string} key
   * @returns {string}
   */
  function headKeyLabel(key) {
    const NAME = { Pa: '編', Ch: '章', Se: '節', Ss: '款', Di: '目' };
    return key.split('-').map(seg => {
      const m = seg.match(/^(Pa|Ch|Se|Ss|Di)_([0-9_]+)$/);
      if (!m) return '';
      const nums = m[2].split('_').map(Number);
      return `第${numberToKanji(nums[0])}${NAME[m[1]]}` + nums.slice(1).map(n => `の${numberToKanji(n)}`).join('');
    }).join('');
  }

  /**
   * 条を限った範囲を、どこから読んでも分かる形で言う。
   * 宣言の文の「この節」「次条」は宣言した条から見た言い方で、別の条で語に乗せた人には
   * どこのことか分からないので、段の名前と条番号に直す
   * （「第三章第二節（第七十七条の十八から第七十七条の三十五まで）」「第三条の二、第四十五条の三」）
   * @param {string[]} ids - 範囲の条 id
   * @param {Object} g - buildArticleIndex のその本則・附則の分
   * @param {string|null} headKey - 範囲が段一つなら、その key
   * @param {string} group
   * @returns {string}
   */
  function articlesScopeLabel(ids, g, headKey, group) {
    const prefix = group.endsWith('-Sp') ? groupLabel(group) : '';
    const articleName = (id) => {
      const num = parseUnitId(id).articleNum;
      if (!num) return '';
      const nums = num.split('_').map(Number);
      return `第${numberToKanji(nums[0])}条` + nums.slice(1).map(n => `の${numberToKanji(n)}`).join('');
    };
    // 並び順で続いている条をまとめる（第十条から第十二条まで）
    const idx = ids.map(id => g.idToIdx.get(id)).filter(n => n !== undefined).sort((a, b) => a - b);
    const runs = [];
    idx.forEach(n => {
      const last = runs[runs.length - 1];
      if (last && n === last[1] + 1) last[1] = n; else runs.push([n, n]);
    });
    const parts = runs.map(([a, b]) => a === b
      ? articleName(g.ids[a])
      : `${articleName(g.ids[a])}から${articleName(g.ids[b])}まで`);
    let list = parts.slice(0, 3).join('、');
    if (parts.length > 3) list += `ほか（${ids.length}か条）`;
    if (headKey) return `${prefix}${headKeyLabel(headKey)}（${list}）`;
    return prefix + list;
  }

  /* ------------------------------------------------------------------ */
  /* 抽出                                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * 定義語抽出処理の進行中 Promise（重複起動防止・共有用）
   * @type {Promise<void>|null}
   */
  ext.definitionExtractionPromise = null;

  /**
   * 定義語抽出が全パターン完走して成功したかどうかのフラグ
   * @type {boolean}
   */
  ext.definitionExtractionCompleted = false;

  /**
   * 抽出完了時の法令ID
   * @type {string}
   */
  ext.extractedLawId = '';

  /**
   * 号の Column 定義の 1 列目（定義される語そのもの）→ その定義。
   * 本文の下線は付けず（乗せても同じ号が出るだけ）、定義している箇所として色を付ける
   * @type {WeakMap<Element, Object>}
   */
  let termCells = new WeakMap();

  /**
   * 鉤括弧で宣言した箇所（「以下「X」という」の X）。ブロック → [{start, end, def}]（ブロックの文字列の中の位置）。
   * 宣言は括弧書きの中にあることが多く、薄字化で灰色になると、どこで定義しているか見つけにくい
   * @type {WeakMap<Element, {start: number, end: number, def: Object}[]>}
   */
  let declSites = new WeakMap();

  /**
   * 括弧書き（入れ子も含む）を取り除く
   * @param {string} text
   * @returns {string}
   */
  function stripParentheticals(text) {
    let out = '';
    let depth = 0;
    for (const ch of text) {
      if (ch === '（') depth++;
      else if (ch === '）') depth = Math.max(0, depth - 1);
      else if (depth === 0) out += ch;
    }
    return out;
  }

  /**
   * 号（Item・Subitem）の要素から、Column の 1 列目と残りを取り出す
   * @param {Element} item
   * @returns {{termEl: Element, term: string, body: string}|null}
   */
  function readColumns(item) {
    // 新しい表示：div.column が 2 つ以上
    let cols = item.querySelectorAll(':scope > .column, :scope > .Column, :scope > ._div_Column');
    if (cols.length < 2) {
      // 旧表示：<span 太字>号番号</span><span>用語</span><span>意義</span>
      cols = Array.from(item.children).filter(c =>
        c.tagName === 'SPAN' &&
        !(c.style && c.style.fontWeight === 'bold') &&
        !/egov-|itemtitle|ItemTitle/.test(c.className || '')
      );
    } else {
      cols = Array.from(cols);
    }
    if (cols.length < 2) return null;
    const term = cols[0].textContent.replace(/[\s　]+/g, '');
    const body = cols.slice(1).map(c => c.textContent).join('').trim();
    return { termEl: cols[0], term, body };
  }

  /**
   * 号の属する項の本文（前置き「次の各号に掲げる用語の意義は…」）
   * @param {Element} item
   * @param {Object} info
   * @returns {string}
   */
  function leadOf(item, info) {
    const base = info.articleId || (info.group.endsWith('-Sp') ? info.group : null);
    const para = (base && info.para !== null) ? document.getElementById(`${base}-Pr_${info.para}`) : null;
    if (para && !para.contains(item) && para.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING && !/item/i.test(para.className)) {
      // 旧表示：項と号が兄弟として平らに並ぶ
      return para.textContent;
    }
    if (para) {
      // 新しい表示では号が項の中に入れ子になっているので、項自身の文だけを読む
      const own = para.querySelectorAll(':scope > .istitle p.sentence, :scope > p.sentence, :scope > .istitle .sentence');
      if (own.length) return Array.from(own).map(p => p.textContent).join('');
    }
    // id で項を引けない形：号より前にある兄弟（条見出し・項の本文）を読む
    let text = '';
    let prev = item.previousElementSibling;
    while (prev) {
      if (!/item|Item/.test(prev.className || '')) text = prev.textContent + text;
      prev = prev.previousElementSibling;
    }
    return text;
  }

  /**
   * e-Govの法令本文から定義語および定義文・出典番号を抽出し、メモリ上に保持する関数（非同期チャンク分割版）
   * @returns {Promise<void>}
   */
  ext.extractDefinitionsAsync = async function() {
    const currentLawId = ext.getLawIdFromUrl ? ext.getLawIdFromUrl(window.location.href) : '';

    // 既に同一法令で抽出が完了している場合は再抽出不要
    if (ext.definitionExtractionCompleted && ext.extractedLawId === currentLawId && ext.definitionMap.size > 0) {
      return;
    }

    // 既に抽出処理が走っている最中であれば、新規タスクを作らず既存の Promise を共有・待機する
    if (ext.definitionExtractionPromise) {
      return ext.definitionExtractionPromise;
    }

    ext.definitionExtractionCompleted = false;
    ext.definitionExtractionPromise = (async () => {
      try {
        // 横書き表記変換（分割して少しずつ進む）が終わってから読む。途中で読むと、変換前の
        // 「第一号被保険者」を語にしてしまい、変換後の本文（「第１号被保険者」）と一致しない。
        // 宣言の位置もずれる。大きな法令では待ちきれないので、下で変換後の形も語として足す
        if (ext.waitForTasks) await ext.waitForTasks(['horizontal_leaf', 'horizontal_item', 'horizontal_para']);

        const defsByTerm = new Map();
        const list = [];
        const newTermCells = new WeakMap();
        const newDeclSites = new WeakMap();
        const seen = new WeakMap();

        const addDefinition = (term, data) => {
          // 同じ箇所・同じ範囲の同じ語は 1 つにまとめる（同じ括弧が 2 つの形に当たる等）
          const key = `${term}\u0000${data.scopeKey}`;
          let keys = seen.get(data.element);
          if (!keys) { keys = new Map(); seen.set(data.element, keys); }
          if (keys.has(key)) return keys.get(key);
          const def = Object.assign({ term, index: -1 }, data);
          keys.set(key, def);
          const arr = defsByTerm.get(term);
          if (arr) arr.push(def); else defsByTerm.set(term, [def]);
          list.push(def);
          return def;
        };

        const container = ext.getLawContainer();
        const index = buildArticleIndex(container);
        paragraphCountCache = new Map();
        const labelCache = new WeakMap();
        const labelOf = (el) => {
          let label = labelCache.get(el);
          if (label === undefined) {
            label = getSourceClauseNumber(el);
            labelCache.set(el, label);
          }
          return label;
        };
        const scopeKeyOf = (scope) => scope.kind === 'articles' ? Array.from(scope.ids).join(',') : scope.kind + ':' + (scope.group || '');

        // 1. 鉤括弧で宣言された語（「以下「X」という」「この法律において「X」という」「「X」とは…をいう」）
        const blocks = ext.collectLeafBlocks(container);
        const state1 = await ext.runTaskInChunksPromise('definitionExtract', blocks, (block) => {
          const text = block.textContent;
          if (!text || text.indexOf('「') < 0) return;
          const spans = declSpans(text);
          if (!spans.length) return;
          const unit = locateUnit(block);
          const info = unit ? parseUnitId(unit.id) : null;
          // 表の中の宣言は、表全体ではなくそのセルを出す
          const cell = block.closest ? block.closest('td, th') : null;
          const element = cell || unit || block;
          for (const d of spans) {
            const term = d.term.replace(/[\s　]+/g, '');
            if (!isDefinitionTerm(term, true)) continue;
            const scope = info ? resolveScope(declScopePhrase(text, d.start), info, index) : { kind: 'global' };
            const def = addDefinition(term, {
              source: labelOf(element),
              element,
              block,
              leadOnly: !!(unit && info && info.para !== null && !info.items),
              scope,
              scopeKey: scopeKeyOf(scope),
              after: d.hereafter ? block : null,
              // 同じブロックの中では、宣言の閉じ括弧より後ろだけ（「者を指定する（以下「指定」という。）」の
              // 前の「指定」は、まだ定義されていない）
              afterOffset: d.hereafter ? d.end : 0,
              pattern: d.hereafter ? 1 : 2
            });
            const sites = newDeclSites.get(block);
            const site = { start: d.start + 1, end: d.end - 1, def };
            if (sites) sites.push(site); else newDeclSites.set(block, [site]);
          }
        }, 500);
        if (state1 && state1.cancelled) {
          ext.definitionExtractionCompleted = false;
          return;
        }

        // 2. 号の 2 列（「用語｜意義」）で定義された語
        const items = ext.deepQuerySelectorAll(container, '.item, .subitem, .Item, ._div_ItemSentence, [class*="_div_Subitem"]')
          .filter(el => el.id ? UNIT_ID_RE.test(el.id) : true);
        const state2 = await ext.runTaskInChunksPromise('definitionExtract', items, (item) => {
          const cols = readColumns(item);
          if (!cols) return;
          const unit = item.id ? item : locateUnit(item);
          const info = unit ? parseUnitId(unit.id) : null;
          const lead = info ? leadOf(unit, info) : '';
          // 施行期日の表・「◯◯に掲げる者」の一覧など、2 列でも定義でない号を弾く。
          // 意義の側の「をいう」は括弧書きの中のもの（「委員（…の委員をいう。）」）を数えない
          const bodyMain = stripParentheticals(cols.body);
          const isSubitem = !(unit && unit === item && /-It_[0-9_]+$/.test(unit.id));
          if (isSubitem) {
            // 号の細分（イ・ロ）は、定義の号の下で区分を並べていることが多い
            // （会社法第二条第二十六号「組織変更」のイ「株式会社｜合名会社…」）。意義を述べるものだけ採る
            if (!/をい[うい]/.test(bodyMain)) return;
          } else if (!/用語の意義|意義は/.test(lead) && !/をい[うい]/.test(bodyMain)) {
            return;
          }

          let terms = [cols.term];
          // 「都市計画区域又は準都市計画区域　それぞれ、…」は並んだ語をそれぞれ定義している
          if (/^それぞれ/.test(cols.body) && /又は|及び|並びに|若しくは|、/.test(cols.term)) {
            terms = cols.term.split(/、|又は|及び|並びに|若しくは/).filter(Boolean);
          }
          const scope = info ? resolveScope(columnScopePhrase(lead), info, index) : { kind: 'global' };
          let firstDef = null;
          for (const term of terms) {
            if (!isDefinitionTerm(term, false)) continue;
            const def = addDefinition(term, {
              source: labelOf(unit || item),
              element: unit || item,
              block: item,
              leadOnly: false,
              scope,
              scopeKey: scopeKeyOf(scope),
              after: null,
              pattern: 4
            });
            if (!firstDef) firstDef = def;
          }
          if (firstDef) newTermCells.set(cols.termEl, firstDef);
        }, 500);
        if (state2 && state2.cancelled) {
          ext.definitionExtractionCompleted = false;
          return;
        }

        // 文書の順に並べる（代表の定義と、同じ範囲で重なったときの優先を決めるため）
        list.sort((a, b) => {
          if (a.element === b.element) return 0;
          return (a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
        });
        list.forEach((def, i) => { def.index = i; });
        defsByTerm.forEach(arr => arr.sort((a, b) => a.index - b.index));

        // 横書き表記変換の前に読んだ語（「第一号被保険者」）は、変換後の本文の形（「第１号被保険者」）でも引けるようにする
        if (ext.settings && ext.settings.horizontal && ext.convertLawTextToHorizontal) {
          Array.from(defsByTerm.keys()).forEach(term => {
            if (!/[〇一二三四五六七八九十百千]/.test(term)) return;
            const variant = ext.convertLawTextToHorizontal(term);
            if (variant && variant !== term && !defsByTerm.has(variant)) defsByTerm.set(variant, defsByTerm.get(term));
          });
        }

        ext.definitionMap.clear();
        defsByTerm.forEach((arr, term) => {
          // 代表：法令全体に効く定義を優先し、なければ最初の定義
          ext.definitionMap.set(term, arr.find(d => d.scope.kind === 'global') || arr[0]);
        });
        ext.definitionDefs = defsByTerm;
        ext.definitionList = list;
        termCells = newTermCells;
        declSites = newDeclSites;

        ext.definitionExtractionCompleted = true;
        ext.extractedLawId = currentLawId;
        ext.log('Extraction complete (async). Total terms extracted:', ext.definitionMap.size, list.length);
      } finally {
        paragraphCountCache = null;
        ext.definitionExtractionPromise = null;
      }
    })();

    return ext.definitionExtractionPromise;
  };

  /* ------------------------------------------------------------------ */
  /* 本文への下線付け                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * 語の定義の一覧（テストや旧形式で definitionMap に直接入れられた定義も受ける）
   * @param {string} term
   * @returns {Object[]}
   */
  function defsOf(term) {
    const arr = ext.definitionDefs.get(term);
    if (arr && arr.length) return arr;
    const single = ext.definitionMap.get(term);
    return single ? [single] : [];
  }

  /**
   * 定義の範囲の広さ（小さいほど狭い＝優先）
   * @param {Object} def
   * @returns {number}
   */
  function scopeRank(def) {
    const scope = def.scope;
    if (!scope || scope.kind === 'global') return 1e9;
    if (scope.kind === 'group') return 1e8;
    return scope.ids.size;
  }

  /**
   * 本文のある場所（block）で、その語がどの定義を指すか。効く定義が無ければ null
   * @param {string} term
   * @param {{group: string|null, articleId: string|null}} ctx
   * @param {Element} block
   * @returns {Object|null}
   */
  function resolveDefAt(term, ctx, block) {
    const defs = defsOf(term);
    let best = null;
    for (let i = 0; i < defs.length; i++) {
      const def = defs[i];
      const scope = def.scope;
      if (scope && scope.kind === 'group' && scope.group !== ctx.group) continue;
      if (scope && scope.kind === 'articles' && !(ctx.articleId && scope.ids.has(ctx.articleId))) continue;
      // 「以下「X」という」は宣言より後ろでだけ効く（旧形式の pattern 1 も同じ扱い）
      const after = def.after || (def.pattern === 1 && !def.scope ? def.element : null);
      if (after && after !== block && !after.contains(block) &&
          !(after.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      if (!best || scopeRank(def) < scopeRank(best)) best = def;
    }
    return best;
  }

  /**
   * 抽出された定義語を安全にハイライト処理する関数（非同期チャンク分割版）
   * @param {HTMLElement|null} [targetContainer=null] - 適用対象のDOMコンテナ
   */
  ext.enableDefinitionHighlighting = function(targetContainer = null) {
    if (!targetContainer) {
      ext.cancelTask('definitionHighlight');
    }
    ext.updateStatusBadge(ext.definitionMap.size);
    if (ext.definitionMap.size === 0) {
      ext.log('no defined terms extracted. Skipping highlighting.');
      return;
    }

    // 語の頭の 1 字ごとに、長い語から順に並べる（同じ位置では長い語を先に試す）
    const buckets = new Map();
    ext.definitionMap.forEach((_, term) => {
      if (!term) return;
      const head = term[0];
      const arr = buckets.get(head);
      if (arr) arr.push(term); else buckets.set(head, [term]);
    });
    buckets.forEach(arr => arr.sort((a, b) => b.length - a.length));

    const container = targetContainer || ext.getLawContainer();
    const blocks = ext.collectLeafBlocks(container, targetContainer);

    let highlightedCount = 0;

    /**
     * ブロックが定義する側の 1 列目（termCells）の中にあれば、その定義を返す。
     * 新しい表示では 1 列目（div.column）の中に p.sentence があり、ブロックより外側にある。
     * 号の要素（id を持つ単位）に着いたら打ち切る
     * @param {Element} block
     * @returns {Object|null}
     */
    const cellDefOfBlock = (block) => {
      let el = block;
      while (el) {
        const def = termCells.get(el);
        if (def) return def;
        if (el.id && UNIT_ID_RE.test(el.id)) break;
        el = el.parentElement;
      }
      return null;
    };

    /**
     * ブロックの中のテキストノードを、文書の順に位置と状態つきで集める。
     * ノードごとに closest() で祖先を調べると、大きな法令では数十万回になり重い
     * @param {Element} block
     * @returns {{node: Text, start: number, skip: boolean, inLink: boolean, cellDef: Object|null}[]}
     */
    const collectTextNodes = (block) => {
      const out = [];
      let offset = 0;
      const visit = (el, inLink, skip, cellDef) => {
        for (let c = el.firstChild; c; c = c.nextSibling) {
          if (c.nodeType === 3) {
            out.push({ node: c, start: offset, skip, inLink, cellDef });
            offset += c.nodeValue.length;
          } else if (c.nodeType === 1) {
            const tag = c.tagName;
            if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA') {
              visit(c, inLink, true, null);
              continue;
            }
            const cls = typeof c.className === 'string' ? c.className : '';
            // 下線・宣言の印を付けた後の要素と、拡張機能自身の UI は触らない
            const childSkip = skip ||
              cls.indexOf('egov-definition-') >= 0 ||
              ((cls.indexOf('egov-ext') >= 0 || (c.id && c.id.indexOf('egov-ext') === 0)) && c.matches(ext.SELF_UI_SELECTOR));
            visit(c, inLink || tag === 'A', childSkip, cellDef || termCells.get(c) || null);
          }
        }
      };
      let startInLink = false;
      for (let p = block.parentElement; p && !(p.id && UNIT_ID_RE.test(p.id)); p = p.parentElement) {
        if (p.tagName === 'A') { startInLink = true; break; }
      }
      visit(block, startInLink, false, cellDefOfBlock(block));
      return out;
    };

    /**
     * 定義している箇所の印（色と太字。下線とポップアップは付けない）
     * @param {string} text
     * @param {Object} def
     * @returns {HTMLSpanElement}
     */
    const makeDeclSpan = (text, def) => {
      const span = document.createElement('span');
      span.className = 'egov-definition-decl';
      span.textContent = text;
      if (def && def.index >= 0) span.dataset.defIndex = String(def.index);
      return span;
    };

    const processHighlight = (block) => {
      const blockText = block.textContent;
      if (!blockText) return;
      // 候補の頭の字が 1 つも無ければ何もしない
      let hasCandidate = false;
      for (let i = 0; i < blockText.length; i++) {
        if (buckets.has(blockText[i])) { hasCandidate = true; break; }
      }
      if (!hasCandidate) return;

      const unit = locateUnit(block);
      const info = unit ? parseUnitId(unit.id) : null;
      const ctx = { group: info ? info.group : null, articleId: info ? info.articleId : null };
      const resolved = new Map();
      const defAt = (term) => {
        if (!resolved.has(term)) resolved.set(term, resolveDefAt(term, ctx, block));
        return resolved.get(term);
      };

      // 前後の字を見るため、ブロック全体の文字列の中での各テキストノードの位置を控える
      const nodes = collectTextNodes(block);
      const full = nodes.map(n => n.node.nodeValue).join('');

      // この中で宣言している箇所。抽出のあとで本文が書き換わって位置がずれていたら使わない
      const sites = [];
      (declSites.get(block) || []).forEach(site => {
        if (full.slice(site.start, site.end).replace(/[\s　]+/g, '') === site.def.term) {
          sites.push(site);
          return;
        }
        const forms = [site.def.term];
        if (ext.convertLawTextToHorizontal) forms.push(ext.convertLawTextToHorizontal(site.def.term));
        for (const form of forms) {
          const at = full.indexOf(`「${form}」`);
          if (at >= 0) {
            sites.push({ start: at + 1, end: at + 1 + form.length, def: site.def });
            break;
          }
        }
      });

      // ブロック全体の文字列の上で、塗る範囲を先に決める。語がテキストノードをまたぐことがある
      // （e-Gov は「第一号被保険者」の「第一号」を号への参照リンクにするので、<a>第１号</a>被保険者 になる）
      const charNode = new Int32Array(full.length);
      nodes.forEach((n, k) => charNode.fill(k, n.start, n.start + n.node.nodeValue.length));
      const usable = (k) => !nodes[k].skip && !nodes[k].cellDef;

      /** @type {{start: number, end: number, def: Object, kind: 'word'|'decl', term: string}[]} */
      const ranges = [];
      let i = 0;
      while (i < full.length) {
        if (!usable(charNode[i])) { i++; continue; }
        // 鉤括弧の宣言の中：定義している箇所の印
        const site = sites.length ? sites.find(x => i >= x.start && i < x.end) : null;
        if (site) {
          ranges.push({ start: i, end: site.end, def: site.def, kind: 'decl', term: site.def.term });
          i = site.end;
          continue;
        }
        const candidates = buckets.get(full[i]);
        let matched = null;
        if (candidates) {
          for (let c = 0; c < candidates.length; c++) {
            const term = candidates[c];
            if (!full.startsWith(term, i)) continue;
            const end = i + term.length;
            let ok = true;
            let inLink = false;
            for (let j = i; j < end; j++) {
              const k = charNode[j];
              if (!usable(k)) { ok = false; break; }
              if (nodes[k].inLink) inLink = true;
            }
            if (!ok) continue;
            // 宣言の括弧の中（「建築物」とは）は語そのものなので塗らない
            if (full[i - 1] === '「' && full[end] === '」') continue;
            // 「法第二条」の「法」はリンクになっており、参照条文のポップアップが受け持つ
            if (inLink && LAW_KIND_TERM_RE.test(term)) continue;
            if (!isDefUseAllowed(full, i, end)) continue;
            const def = defAt(term);
            if (!def) continue;
            if (def.after === block && i < (def.afterOffset || 0)) continue;
            matched = { start: i, end, def, kind: 'word', term };
            break;
          }
        }
        if (matched) {
          ranges.push(matched);
          i = matched.end;
        } else {
          i++;
        }
      }

      let saved = false;
      const ensureSaved = () => {
        if (!saved && ext.saveOriginalHTML) {
          ext.saveOriginalHTML(block);
          saved = true;
        }
      };

      let r = 0;
      nodes.forEach(({ node, start: nodeStart, skip, cellDef }) => {
        if (skip || !node.parentNode) return;
        const text = node.nodeValue;
        if (!text) return;
        const nodeEnd = nodeStart + text.length;

        // 2 列の定義の 1 列目：語そのものに定義している箇所の印を付ける
        if (cellDef) {
          const m = text.match(/^([\s　]*)([\s\S]*?)([\s　]*)$/);
          if (!m || !m[2]) return;
          const frag = document.createDocumentFragment();
          if (m[1]) frag.appendChild(document.createTextNode(m[1]));
          frag.appendChild(makeDeclSpan(m[2], cellDef));
          if (m[3]) frag.appendChild(document.createTextNode(m[3]));
          ensureSaved();
          node.parentNode.replaceChild(frag, node);
          return;
        }

        while (r < ranges.length && ranges[r].end <= nodeStart) r++;
        let frag = null;
        let last = 0;
        for (let q = r; q < ranges.length && ranges[q].start < nodeEnd; q++) {
          const range = ranges[q];
          const a = Math.max(range.start, nodeStart) - nodeStart;
          const b = Math.min(range.end, nodeEnd) - nodeStart;
          if (b <= a) continue;
          if (!frag) frag = document.createDocumentFragment();
          if (a > last) frag.appendChild(document.createTextNode(text.substring(last, a)));
          const piece = text.substring(a, b);
          if (range.kind === 'decl') {
            frag.appendChild(makeDeclSpan(piece, range.def));
          } else {
            const span = document.createElement('span');
            // ノードをまたいだ語（一部がリンクの中）は、リンクの色に引っ張られず 1 語に見えるようにする
            span.className = (range.start < nodeStart || range.end > nodeEnd)
              ? 'egov-definition-word egov-definition-word--joined'
              : 'egov-definition-word';
            span.textContent = piece;
            // 語は定義の側の形で持つ（横書き変換の前後どちらの形で本文に出ていても、同じ定義を指す）
            span.dataset.word = range.def.term || range.term;
            if (range.def.index >= 0) span.dataset.defIndex = String(range.def.index);
            // キーボードのみの利用者も Tab で辿って定義を読めるようにする（ノードをまたいだ語は頭の 1 つだけ）
            if (range.start >= nodeStart) {
              span.tabIndex = 0;
              highlightedCount++;
            }
            frag.appendChild(span);
          }
          last = b;
        }
        if (frag) {
          ensureSaved();
          if (last < text.length) frag.appendChild(document.createTextNode(text.substring(last)));
          node.parentNode.replaceChild(frag, node);
        }
      });
    };

    if (targetContainer) {
      blocks.forEach(processHighlight);
      setupDefinitionTooltipEvents();
    } else {
      ext.runTaskInChunks('definitionHighlight', blocks, processHighlight, 100, (state) => {
        if (state.cancelled) return;
        ext.log('highlighting complete. Highlighted occurrences (async):', highlightedCount);
        setupDefinitionTooltipEvents();
      });
    }
  };

  /**
   * 定義語ハイライトを無効化する。
   * 進行中タスクの停止・ツールチップの非表示・バッジのリセットのみを行い、
   * DOM の巻き戻しは content.js が3機能ぶんをまとめて1回だけ実行する。
   */
  ext.disableDefinitionHighlighting = function() {
    ext.cancelTask('definitionHighlight');
    ext.cancelTask('definitionExtract');
    ext.definitionExtractionCompleted = false;
    ext.definitionExtractionPromise = null;
    if (ext.definitionTooltip) {
      ext.definitionTooltip.hide(true);
    }
    ext.updateStatusBadge(0);
  };

  /**
   * 下線から、それが指す定義を引く
   * @param {HTMLElement} target
   * @returns {Object|null}
   */
  function defForAnchor(target) {
    const idx = target.dataset.defIndex;
    if (idx !== undefined && ext.definitionList[Number(idx)] && ext.definitionList[Number(idx)].term === target.dataset.word) {
      return ext.definitionList[Number(idx)];
    }
    return ext.definitionMap.get(target.dataset.word) || null;
  }

  /**
   * 定義している箇所（宣言のある項・号）。本文から外れていれば null。
   * 文（p.sentence）ではなく項・号を返す。2 列の号の 2 列目の文は行の途中から始まり、
   * そこを上端に置くと号の頭（1 列目）が画面の外に出る
   * @param {Object} def
   * @returns {Element|null}
   */
  function placeOfDefinition(def) {
    if (def.element && def.element.isConnected) return def.element;
    if (def.block && def.block.isConnected) return def.block;
    return null;
  }

  /**
   * 定義している箇所へ移動する（定義語ポップアップの「定義へ」）。
   * 項・号の頭を枠の上端に置き、光らせるのは定義している語だけにする
   * @param {number} index - ext.definitionList の添字
   */
  ext.jumpToDefinition = function(index) {
    const def = ext.definitionList[index];
    if (!def) return;
    const place = placeOfDefinition(def);
    if (!place) return;
    if (ext.definitionTooltip) ext.definitionTooltip.hide(true);
    const mark = place.querySelector(`.egov-definition-decl[data-def-index="${index}"]`);
    ext.fastSmoothScroll(place, { flashTarget: mark || place });
  };

  /**
   * 定義語ホバー辞書のイベントを登録する。
   * ツールチップの生成・配置・表示制御は js/tooltip.js の共通基盤が担当し、
   * ここでは「定義語からポップアップの中身を作る」部分だけを受け持つ。
   */
  function setupDefinitionTooltipEvents() {
    if (!ext.settings.global || !ext.settings.definition) return;
    if (ext.definitionTooltip) return;

    ext.definitionTooltip = ext.createTooltip({ variant: 'definition' });

    ext.bindHoverTooltip({
      selector: '.egov-definition-word',
      tooltip: ext.definitionTooltip,
      isEnabled: () => !!(ext.settings.global && ext.settings.definition && (!ext.checkIfLawPage || ext.checkIfLawPage())),
      resolveContent: (target) => {
        const def = defForAnchor(target);
        if (!def || !def.element) return null;

        const frag = document.createDocumentFragment();

        let sourceText = def.source || '定義語';
        if (ext.settings.horizontal && ext.convertLawTextToHorizontal) {
          sourceText = ext.convertLawTextToHorizontal(sourceText);
        }

        const header = document.createElement('div');
        header.className = 'egov-ext-tip-header';
        const titleWrap = document.createElement('div');
        titleWrap.className = 'egov-ext-tip-header-title';
        titleWrap.textContent = sourceText;
        header.appendChild(titleWrap);

        // 定義している箇所へ移動するボタン（本文の中にあるときだけ）。
        // ツールチップは中身を複製して表示するので、クリックは utils.js の委譲ハンドラが data-def-index で受ける
        if (def.index >= 0 && placeOfDefinition(def) && ext.createTipActionButton && ext.fastSmoothScroll) {
          const jumpBtn = ext.createTipActionButton({
            icon: 'jump',
            label: '定義へ',
            title: '定義している箇所へ移動',
            onClick: () => ext.jumpToDefinition(def.index)
          });
          jumpBtn.dataset.defIndex = String(def.index);
          header.appendChild(jumpBtn);
        }
        frag.appendChild(header);

        // 範囲を限った定義は、どこで効く定義かを見出しの下に出す（法令全体に効くものは出さない）
        const scopeLabel = def.scope && def.scope.kind !== 'global' ? def.scope.label : '';
        if (scopeLabel) {
          const scopeEl = document.createElement('div');
          scopeEl.className = 'egov-ext-tip-scope';
          let text = `${scopeLabel}の中だけの定義`;
          if (ext.settings.horizontal && ext.convertLawTextToHorizontal) {
            text = ext.convertLawTextToHorizontal(text);
          }
          scopeEl.textContent = text;
          frag.appendChild(scopeEl);
        }

        const body = document.createElement('div');
        body.className = 'egov-ext-tip-body';

        const clone = def.element.cloneNode(true);
        // クローンから引用ボタンなどの自作UI要素を除去
        clone.querySelectorAll('.egov-ext-citation-btn, [class*="citation-btn"]').forEach(btn => btn.remove());
        // 項の前置きで宣言された語は、その項の文だけを出す（新しい表示では号が項の中に入れ子で、
        // 残すと第二条の 35 号がまるごと出る）
        if (def.leadOnly) {
          clone.querySelectorAll('.item, .subitem, .Item, ._div_ItemSentence, [class*="_div_Subitem"]').forEach(el => el.remove());
        }
        // 共通成形関数で定義ポップアップDOMをインライン化・クリーンアップ
        ext.formatInlinePreview(clone);
        body.appendChild(clone);

        frag.appendChild(body);

        // 横書き設定が有効ならポップアップDOM全体（body）にも横書き変換を適用
        if (ext.settings.horizontal && ext.applyHorizontalConversion) {
          ext.applyHorizontalConversion(body);
        }

        return frag;
      }
    });
  }

  // テスト用に内部関数をエクスポート
  if (typeof process !== 'undefined' && process.env && process.env.NODE_ENV === 'test') {
    ext._testDefinition = {
      getSourceClauseNumber,
      setupDefinitionTooltipEvents,
      declSpans,
      isDefinitionTerm,
      isDefUseAllowed,
      readDefScope,
      declScopePhrase,
      parseUnitId,
      locateUnit,
      resolveDefAt,
      numeralToNumber,
      numberToKanji
    };
  }

})(window.egovExt);

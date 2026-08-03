/**
 * refer_popup.js
 *
 * 参照条文プレビュー（ホバーで条文の中身を見せるポップアップ）のロジック。
 * ツールチップの生成・配置・表示制御は js/tooltip.js の共通基盤が担当し、
 * このモジュールは「リンクからプレビュー内容を作る」部分だけを受け持つ。
 */

window.egovExt = window.egovExt || {};

(function(ext) {
  /**
   * 参照条文プレビューのツールチップインスタンス
   * @type {Object|null}
   */
  ext.referenceTooltip = null;

  /**
   * リンクの参照先 ID から、実際の対象要素を解決する。
   * e-Gov の法令ページは ID の表記が揺れることがあるため、多段のフォールバックを行う。
   *
   * @param {string} targetId - URL のハッシュ部分
   * @returns {HTMLElement|null} 見つかった要素、なければ null
   */
  function resolveTargetElement(targetId) {
    if (!targetId) return null;

    /**
     * 通常のDOMとShadow DOMの両方から id / name で要素を探す
     * @param {string} id
     * @returns {HTMLElement|null}
     */
    const findById = (id) => document.getElementById(id) ||
                             document.querySelector(`[name="${id}"]`) ||
                             ext.deepQuerySelectorAll(document.body, `[id="${id}"], [name="${id}"]`)[0] ||
                             null;

    const direct = findById(targetId);
    if (direct) return direct;

    // 1. ハイフンとアンダースコアの表記揺れを相互変換して再検索
    let altId = null;
    if (targetId.includes('-')) {
      altId = targetId.replace(/-/g, '_');
    } else if (targetId.includes('_')) {
      altId = targetId.replace(/_/g, '-');
    }
    if (altId) {
      const alt = findById(altId);
      if (alt) return alt;
    }

    // 2. 改正附則などの前方一致・後方一致検索（ハイフン／アンダースコア両対応）
    const match = targetId.match(/^(Mp|Sp|Sp_.*)-(.+)$/);
    if (match) {
      const selector = `[id^="${match[1]}-"][id$="${match[2]}"], [id^="${match[1]}_"][id$="${match[2]}"]`;
      return document.querySelector(selector) ||
             ext.deepQuerySelectorAll(document.body, selector)[0] ||
             null;
    }

    return null;
  }

  /**
   * リンクが「同じ法令内へのリンク」かどうかを判定する。
   * 他法令へのリンクは、その中身がこのページに無いためプレビューしない。
   *
   * @param {HTMLAnchorElement} a - 判定対象のリンク
   * @param {HTMLElement|null} targetEl - 解決済みの参照先要素
   * @returns {boolean}
   */
  function isInternalLink(a, targetEl) {
    const currentLawId = ext.getLawIdFromUrl(window.location.href);
    const targetLawId = ext.getLawIdFromUrl(a.href);
    if (currentLawId && targetLawId && currentLawId !== targetLawId) return false;

    const hrefAttr = a.getAttribute('href');
    const stripSlash = (p) => p.replace(/\/$/, '');

    // ハッシュのみ / パスが一致 / 参照先要素が現在のDOMに存在する、のいずれかを満たせば内部リンク
    return hrefAttr.startsWith('#') ||
           a.pathname === window.location.pathname ||
           stripSlash(a.pathname) === stripSlash(window.location.pathname) ||
           !!targetEl;
  }

  /**
   * 参照先要素からプレビュー用のDOMを組み立てる。
   *
   * 参照先が `<a name="...">` のアンカーの場合、それ自体には中身が無いため、
   * 次の条見出しや章見出しが現れるまでの兄弟要素をかき集める。
   *
   * @param {HTMLElement} targetEl - 参照先要素
   * @returns {HTMLElement} プレビュー内容を格納したDIV
   */
  function buildPreviewContent(targetEl) {
    let clone;

    if (targetEl.tagName.toLowerCase() === 'a' && targetEl.hasAttribute('name')) {
      clone = document.createElement('div');
      let foundTitle = false;

      for (let current = targetEl.nextElementSibling; current; current = current.nextElementSibling) {
        const classList = current.classList;
        if (!classList) break;

        // 次の条タイトルに到達したら、そこが次の条文の始まりなので打ち切る
        const isTitle = classList.contains('_div_ArticleTitle') || classList.contains('ArticleTitle');
        if (isTitle) {
          if (foundTitle) break;
          foundTitle = true;
        }

        // 章・節の見出しに到達した場合も打ち切る
        const isHeader = classList.contains('ChapterTitle') || classList.contains('_div_ChapterTitle') ||
                         classList.contains('SectionTitle') || classList.contains('_div_SectionTitle');
        if (isHeader) break;

        clone.appendChild(current.cloneNode(true));
      }
    } else {
      clone = targetEl.cloneNode(true);
    }

    const content = document.createElement('div');
    content.className = 'egov-ext-tip-body';
    content.appendChild(clone);

    // 共通成形関数でポップアップDOMをインライン化・クリーンアップ
    ext.formatInlinePreview(content);

    return content;
  }

  /**
   * 参照条文プレビューを有効化する。
   */
  ext.enablePopup = function() {
    if (!ext.settings.global || !ext.settings.popup) return;
    if (ext.referenceTooltip) return;

    ext.referenceTooltip = ext.createTooltip({ variant: 'reference' });

    ext.bindHoverTooltip({
      selector: 'a[href*="#"]',
      tooltip: ext.referenceTooltip,
      isEnabled: () => !!(ext.settings.global && ext.settings.popup),
      resolveContent: (a) => {
        // 左カラム（サイドバー、目次）内のリンクはプレビューしない
        if (ext.deepClosest(a, ext.SIDEBAR_SELECTOR)) return null;

        const targetId = a.href.includes('#') ? a.href.split('#')[1] : null;
        const targetEl = resolveTargetElement(targetId);
        if (!targetEl) return null;
        if (!isInternalLink(a, targetEl)) return null;

        const content = buildPreviewContent(targetEl);

        // プレビュー内の漢数字も本文と同じ表記に揃える
        if (ext.settings.horizontal && ext.applyHorizontalConversion) {
          ext.applyHorizontalConversion(content);
        }

        return content;
      }
    });
  };

})(window.egovExt);

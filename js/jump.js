/**
 * jump.js
 * 
 * 条文ジャンプ検索のロジックを管理するモジュール。
 */

window.egovExt = window.egovExt || {};

(function(ext) {

  /**
   * 条文ジャンプ検索ボックスをDOMから削除する関数
   */
  ext.removeJumpSearch = function() {
    const container = document.getElementById('egov-ext-jump-container');
    if (container) {
      container.remove();
    }
    ext.checkAndRemoveHeaderContainer();
  };

  /**
   * 条文ジャンプ検索ボックスをセットアップ（作成およびイベント設定）する関数。
   * 入力された数字（例: 5, 12-2）に基づいて該当する条文要素を特定し、
   * 独自のスムーズスクロールで高速移動させ、一時的にハイライト表示を行います。
   */
  ext.setupJumpSearch = function() {
    if (!ext.settings.global || !ext.settings.jump) {
      ext.removeJumpSearch();
      return;
    }
    
    // すでに存在している場合、SPA遷移等でDOMから消えていなければ何もしない
    let container = document.getElementById('egov-ext-jump-container');
    if (container && document.body.contains(container)) return;

    // コンテナの作成
    container = document.createElement('div');
    container.id = 'egov-ext-jump-container';
    container.className = 'egov-ext-jump-container';
    container.setAttribute('role', 'search');

    // アイコン
    const icon = document.createElement('span');
    icon.className = 'egov-ext-jump-icon';
    icon.textContent = '🔍';
    icon.setAttribute('aria-hidden', 'true');

    // 入力欄
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'egov-ext-jump-input';
    input.placeholder = '条文へジャンプ (例: 5, 12-2)';
    input.setAttribute('aria-label', '条文番号検索');

    // クリアボタン
    const clearBtn = document.createElement('span');
    clearBtn.className = 'egov-ext-jump-clear';
    clearBtn.innerHTML = '&times;';
    clearBtn.setAttribute('role', 'button');
    clearBtn.setAttribute('tabindex', '0');
    clearBtn.setAttribute('aria-label', '検索テキストをクリア');

    container.appendChild(icon);
    container.appendChild(input);
    container.appendChild(clearBtn);

    const headerContainer = ext.getOrCreateHeaderContainer();
    headerContainer.appendChild(container);

    // 入力がある時だけクリアボタンを表示する
    input.addEventListener('input', () => {
      if (input.value.length > 0) {
        clearBtn.classList.add('visible');
      } else {
        clearBtn.classList.remove('visible');
      }
    });

    const handleClear = () => {
      input.value = '';
      clearBtn.classList.remove('visible');
      input.focus();
    };

    // クリアボタンがクリックされたら入力を空にする
    clearBtn.addEventListener('click', handleClear);
    clearBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleClear();
      }
    });

    /**
     * ユーザーの検索入力テキストから、ジャンプ先のDOM要素を探索・解決する
     * @param {string} val - ユーザーの入力文字列（例: "709", "67-15-2", "附則1", "目次" など）
     * @returns {HTMLElement|null}
     */
    function findJumpTarget(val) {
      if (!val) return null;
      const raw = val.trim();

      // 1. 目次・前文の特別キーワード
      if (/^(目次|もくじ|toc)$/i.test(raw)) {
        return document.querySelector('._div_TOC, .TOC, #TOC, .toc, .sidebar') || null;
      }
      if (/^(前文|ぜんぶん)$/i.test(raw)) {
        return document.querySelector('._div_Preamble, .Preamble, #Preamble') || null;
      }

      // 附則かどうかの判定
      const isSuppl = /附|ふそく|付則/.test(raw);
      const prefix = isSuppl ? 'Sp' : 'Mp';

      // 数字部分の正規化（全角→半角）
      let normalized = ext.toHalfWidthArabic ? ext.toHalfWidthArabic(raw) : raw;
      normalized = normalized.replace(/^(附則?|付則?|本則?)/, '');
      normalized = normalized.replace(/[第条條]/g, '');
      normalized = normalized.replace(/(-|の|ー|−|—|_)/g, '_');
      normalized = normalized.trim();

      if (!normalized) return null;

      // 2. IDセレクタ探索（本則・附則、ハイフン・アンダースコア、深層階層対応）
      // prefix (Mp または Sp) を厳密に一致させ、本則と附則の誤爆を防止する
      const candidateSelectors = [
        // 完全一致（ハイフン / アンダースコア）
        `[id="${prefix}-At_${normalized}"]`,
        `[id="${prefix}_At_${normalized}"]`,
        `[name="${prefix}-At_${normalized}"]`,
        `[name="${prefix}_At_${normalized}"]`,
        // ハイフン区切り枝番対応 (例: At_67-15-2)
        `[id="${prefix}-At_${normalized.replace(/_/g, '-')}"]`,
        `[id="${prefix}_At_${normalized.replace(/_/g, '-')}"]`,
        // 単文法令（Paragraph直接型）対応
        `[id="${prefix}-Pr_${normalized}"]`,
        `[id="${prefix}_Pr_${normalized}"]`,
        // 深層階層ID対応（例: Mp-Pa_2-...-At_423 のように prefix で始まり At_X で終わる）
        `[id^="${prefix}-"][id$="-At_${normalized}"]`,
        `[id^="${prefix}_"][id$="_At_${normalized}"]`,
        `[name^="${prefix}-"][name$="-At_${normalized}"]`,
        `[name^="${prefix}_"][name$="_At_${normalized}"]`
      ];

      for (const sel of candidateSelectors) {
        const el = document.querySelector(sel) || (ext.deepQuerySelectorAll ? ext.deepQuerySelectorAll(document.body, sel)[0] : null);
        if (el) return el;
      }

      // 3. 条見出しテキストによるフォールバック探索
      // （IDが特殊な法令や古い形式法令に対応）
      const kanjiNum = ext.toKanjiNumber ? ext.toKanjiNumber(normalized) : '';
      const searchTerms = [
        `第${normalized}条`,
        `第${normalized}條`,
        kanjiNum ? `第${kanjiNum}条` : '',
        kanjiNum ? `第${kanjiNum}條` : '',
        isSuppl ? `附則第${normalized}条` : '',
        isSuppl && kanjiNum ? `附則第${kanjiNum}条` : ''
      ].filter(Boolean);

      const titles = document.querySelectorAll('._div_ArticleTitle, .ArticleTitle, .paragraphtitle');
      for (const title of titles) {
        const txt = title.textContent.replace(/\s+/g, '');
        if (searchTerms.some(term => txt === term || txt.startsWith(term))) {
          return title.closest('._div_Article, Article') || title;
        }
      }

      return null;
    }

    // Enterキーで検索を実行、Escapeキーでクリア＆フォーカス解除
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        input.value = '';
        clearBtn.classList.remove('visible');
        input.blur();
        return;
      }
      if (e.key === 'Enter') {
        const val = input.value.trim();
        if (!val) return;
        
        const targetEl = findJumpTarget(val);

        if (targetEl) {
          if (ext.fastSmoothScroll) {
            ext.fastSmoothScroll(targetEl);
          }
        } else {
          input.select();
        }
      }
    });
  };

})(window.egovExt);

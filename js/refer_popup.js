/**
 * refer_popup.js
 * 
 * 参照条文プレビュー（ポップアップ）のロジックを管理するモジュール。
 */

window.egovExt = window.egovExt || {};

(function(ext) {
  /**
   * URLから法令ID（例: 322AC0000000067）を抽出するヘルパー関数
   * @param {string} urlString - 解析対象のURL
   * @returns {string|null} 抽出された法令ID、見つからない場合はnull
   */
  function getLawIdFromUrl(urlString) {
    if (!urlString) return null;
    try {
      const url = new URL(urlString, window.location.origin);
      // 1. /law/[法令ID] パスから抽出
      const pathMatch = url.pathname.match(/\/law\/([0-9A-Z]+)/i);
      if (pathMatch) return pathMatch[1].toUpperCase();

      // 2. ?lawId=[法令ID] クエリから抽出
      const lawIdParam = url.searchParams.get('lawId');
      if (lawIdParam) return lawIdParam.toUpperCase();
      
      // 3. パス中に含まれる一般的な法令IDパターン (例: /document/322AC0000000067)
      const generalMatch = url.pathname.match(/\/([0-9]{3}[A-Z]{2}[0-9]+)/i);
      if (generalMatch) return generalMatch[1].toUpperCase();
    } catch (e) {
      // 相対パスなどのフォールバック
      const pathMatch = urlString.match(/\/law\/([0-9A-Z]+)/i);
      if (pathMatch) return pathMatch[1].toUpperCase();
    }
    return null;
  }

  /**
   * ポップアップ表示用DIV要素の参照
   * @type {HTMLElement|null}
   */
  ext.tooltipEl = null;

  /**
   * 参照条文プレビューのイベントを有効化し、ポップアップ機能を初期化する関数
   */
  ext.enablePopup = function() {
    if (!ext.settings.global || !ext.settings.popup) return;
    
    // ツールチップが未作成、もしくはSPA遷移などでDOMから消えてしまった場合は再作成・追加する
    if (!ext.tooltipEl || !document.body.contains(ext.tooltipEl)) {
      ext.tooltipEl = document.createElement('div');
      ext.tooltipEl.className = 'egov-ext-tooltip';
      document.body.appendChild(ext.tooltipEl);
    }

    // イベントリスナーは重複登録を防ぐため、bodyに1回だけ設定する
    if (!document.body.dataset.popupListenersAdded) {
      document.body.addEventListener('mouseover', (e) => {
        if (!ext.settings.global || !ext.settings.popup) return;
        
        const a = ext.getComposedTarget(e, 'a');
        if (a && a.getAttribute('href') && a.getAttribute('href').includes('#')) {
          // 左カラム（サイドバー、目次）内のリンクの場合はポップアップを表示しない
          if (ext.deepClosest(a, '.sidebar, #sidebar, .toc')) {
            return;
          }
          
          const hrefAttr = a.getAttribute('href');
          const hasHash = hrefAttr.startsWith('#') || hrefAttr.includes('#');
          const targetId = hasHash ? a.href.split('#')[1] : null;

          let targetEl = null;
          if (targetId) {
            targetEl = document.getElementById(targetId) || 
                       document.querySelector(`[name="${targetId}"]`) || 
                       ext.deepQuerySelectorAll(document.body, `[id="${targetId}"], [name="${targetId}"]`)[0];
          
            if (!targetEl) {
              // 1. ハイフンとアンダースコアの表記揺れを相互変換して検索
              let altId = null;
              if (targetId.includes('-')) {
                altId = targetId.replace(/-/g, '_');
              } else if (targetId.includes('_')) {
                altId = targetId.replace(/_/g, '-');
              }
              if (altId) {
                targetEl = document.getElementById(altId) || 
                           document.querySelector(`[name="${altId}"]`) || 
                           ext.deepQuerySelectorAll(document.body, `[id="${altId}"], [name="${altId}"]`)[0];
              }
            }

            if (!targetEl) {
              // 2. 改正附則などの前方一致・後方一致検索 (ハイフンとアンダースコア両方に対応)
              const match = targetId.match(/^(Mp|Sp|Sp_.*)-(.+)$/);
              if (match) {
                const prefix = match[1];
                const suffix = match[2];
                targetEl = document.querySelector(`[id^="${prefix}-"][id$="${suffix}"], [id^="${prefix}_"][id$="${suffix}"]`) ||
                           ext.deepQuerySelectorAll(document.body, `[id^="${prefix}-"][id$="${suffix}"], [id^="${prefix}_"][id$="${suffix}"]`)[0];
              }
            }
          }

          // 自法令とリンク先法令のIDを比較し、異なる法令（他法令）であるかを検証
          const currentLawId = getLawIdFromUrl(window.location.href);
          const targetLawId = getLawIdFromUrl(a.href);
          const isDifferentLaw = (currentLawId && targetLawId && currentLawId !== targetLawId);

          // 1. ハッシュのみで始まる
          // 2. パス名が完全に一致する
          // 3. パス名が末尾スラッシュの有無を除いて一致する
          // 4. ターゲットIDに対応する要素が現在のDOMに存在する
          // 上記のいずれかを満たし、かつ他法令へのリンクでない場合に内部リンクとしてポップアップを許可する
          const isInternalLink = !isDifferentLaw && (
                                 hrefAttr.startsWith('#') || 
                                 (a.pathname === window.location.pathname) ||
                                 (a.pathname.replace(/\/$/, '') === window.location.pathname.replace(/\/$/, '')) ||
                                 (hasHash && !!targetEl)
                               );

          if (isInternalLink && targetEl) {
            let clone;
            
            if (targetEl.tagName.toLowerCase() === 'a' && targetEl.hasAttribute('name')) {
              clone = document.createElement('div');
              let current = targetEl.nextElementSibling;
              let foundTitle = false;
              
              while (current) {
                const isTitle = current.classList && (current.classList.contains('_div_ArticleTitle') || current.classList.contains('ArticleTitle'));
                if (isTitle) {
                  if (foundTitle) break;
                  foundTitle = true;
                }
                const isHeader = current.classList && (
                  current.classList.contains('ChapterTitle') || current.classList.contains('_div_ChapterTitle') ||
                  current.classList.contains('SectionTitle') || current.classList.contains('_div_SectionTitle')
                );
                if (isHeader) break;
                
                clone.appendChild(current.cloneNode(true));
                current = current.nextElementSibling;
              }
            } else {
              clone = targetEl.cloneNode(true);
            }

            const content = document.createElement('div');
            content.appendChild(clone);

            // 共通成形関数でポップアップDOMをインライン化・クリーンアップ
            ext.formatInlinePreview(content);

            ext.tooltipEl.innerHTML = '';
            ext.tooltipEl.appendChild(content);
            
            const rect = a.getBoundingClientRect();
            
            ext.tooltipEl.style.left = '0px';
            ext.tooltipEl.style.top = `${rect.bottom + window.scrollY + 5}px`;
            ext.tooltipEl.classList.add('visible');

            if (ext.settings.horizontal && ext.applyHorizontalConversion) {
              ext.applyHorizontalConversion(ext.tooltipEl);
            }
            
            const tooltipWidth = ext.tooltipEl.offsetWidth;
            
            if (rect.left > window.innerWidth / 2) {
              let leftPos = rect.right - tooltipWidth;
              if (leftPos < 10) leftPos = 10;
              ext.tooltipEl.style.left = `${leftPos + window.scrollX}px`;
            } else {
              ext.tooltipEl.style.left = `${rect.left + window.scrollX}px`;
            }
          }
        }
      });

      // リンクからマウスが外れたらツールチップを消す
      document.body.addEventListener('mouseout', (e) => {
        if (!ext.tooltipEl) return;
        
        const related = e.relatedTarget;
        if (!related) {
          ext.tooltipEl.classList.remove('visible');
          return;
        }
        
        const toA = related.closest ? related.closest('a') : null;
        const toTooltip = (related === ext.tooltipEl) || (ext.tooltipEl.contains && ext.tooltipEl.contains(related));
        
        if (!toA && !toTooltip) {
          ext.tooltipEl.classList.remove('visible');
        }
      });

      document.body.dataset.popupListenersAdded = 'true';
    }
  };

})(window.egovExt);

/**
 * scrollspy.js
 * 
 * 目次ハイライト（ScrollSpy）のロジックを管理するモジュール。
 */

window.egovExt = window.egovExt || {};

(function(ext) {
  /**
   * 目次ハイライト監視用Observerの格納先
   * @type {IntersectionObserver|null}
   */
  ext.scrollSpyObserver = null;

  /**
   * ScrollSpyのセットアップを行う関数。
   * 本文のスクロール位置に応じて、目次（サイドバー）の対応要素を自動ハイライトおよび追従スクロールさせます。
   */
  ext.setupScrollSpy = function() {
    // すでに監視中なら一旦解除する（二重登録防止）
    if (ext.scrollSpyObserver) {
      ext.scrollSpyObserver.disconnect();
    }

    // 条文の本文エリアと目次エリアを取得
    const mainContent = document.querySelector('.main-content, .provisiontext') || ext.deepQuerySelectorAll(document.body, '.main-content, .provisiontext')[0];
    const sidebar = document.querySelector('.sidebar, #sidebar, .toc') || ext.deepQuerySelectorAll(document.body, '.sidebar, #sidebar, .toc')[0];
    if (!mainContent || !sidebar) return;

    // 目次の中にあるリンクを全て取得して、目印（id）ごとに整理する
    const tocLinks = Array.from(ext.deepQuerySelectorAll(sidebar, 'a')).filter(a => a.getAttribute('href') && a.getAttribute('href').startsWith('#'));
    const tocMap = new Map();
    tocLinks.forEach(link => {
      const id = link.getAttribute('href').substring(1);
      tocMap.set(id, link);
    });

    if (tocMap.size === 0) return;

    // 目次再生成による再登録時、マウスが目次上にある場合は自動スクロールをサスペンドする
    if (sidebar.matches(':hover')) {
      ext.isTOCInteracting = true;
      if (ext.tocInteractionTimeout) clearTimeout(ext.tocInteractionTimeout);
    }

    // ユーザーが目次を操作中かどうかを判定するロジック（リスナーの重複登録を防ぐため、1回だけ登録する）
    if (!sidebar.dataset.scrollSpyEventsAdded) {
      const suspendAutoScroll = () => {
        ext.isTOCInteracting = true;
        if (ext.tocInteractionTimeout) clearTimeout(ext.tocInteractionTimeout);
      };
      
      const resumeAutoScroll = () => {
        if (ext.tocInteractionTimeout) clearTimeout(ext.tocInteractionTimeout);
        ext.tocInteractionTimeout = setTimeout(() => {
          ext.isTOCInteracting = false;
        }, 2000);
      };

      sidebar.addEventListener('mouseenter', suspendAutoScroll);
      sidebar.addEventListener('mouseleave', resumeAutoScroll);
      
      // マウスホイールやタッチでのスクロール操作時も一時停止し、2秒後に再開する
      sidebar.addEventListener('wheel', () => {
        suspendAutoScroll();
        resumeAutoScroll();
      }, { passive: true });
      sidebar.addEventListener('touchmove', () => {
        suspendAutoScroll();
        resumeAutoScroll();
      }, { passive: true });
      
      sidebar.dataset.scrollSpyEventsAdded = 'true';
    }

    // 画面に入っている要素を管理するセット
    const activeElements = new Set();

    /**
     * ID名から目次要素の階層レベル（深さ優先度）を取得する内部関数
     * @param {string} id - HTML要素のID
     * @returns {number} 優先度レベル数値（高いほど優先）
     */
    const getLevel = (id) => {
      if (id.includes('At_')) return 5;
      if (id.includes('Ss_')) return 4;
      if (id.includes('Se_')) return 3;
      if (id.includes('Ch_')) return 2;
      if (id.includes('Pa_')) return 1;
      return 0;
    };

    // IntersectionObserverで監視
    ext.scrollSpyObserver = new IntersectionObserver((entries) => {
      if (!ext.settings.global || !ext.settings.scrollspy) return;
      
      let changed = false;
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          activeElements.add(entry.target);
          changed = true;
        } else {
          activeElements.delete(entry.target);
          changed = true;
        }
      });
      
      if (!changed || activeElements.size === 0) return;

      // 優先度の判定
      let bestTarget = null;
      let bestLevel = -1;
      let bestVisibleHeight = -1;
      let bestTop = Infinity;

      const zoneTop = window.innerHeight * 0.1;
      const zoneBottom = window.innerHeight * 0.5;

      activeElements.forEach(el => {
        const id = el.id || el.name;
        if (id && tocMap.has(id)) {
          const level = getLevel(id);
          const rect = el.getBoundingClientRect();
          
          const top = Math.max(rect.top, zoneTop);
          const bottom = Math.min(rect.bottom, zoneBottom);
          const visibleHeight = Math.max(0, bottom - top);
          
          if (level > bestLevel) {
            bestLevel = level;
            bestTarget = el;
            bestVisibleHeight = visibleHeight;
            bestTop = rect.top;
          } 
          else if (level === bestLevel) {
            if (visibleHeight > bestVisibleHeight) {
              bestTarget = el;
              bestVisibleHeight = visibleHeight;
              bestTop = rect.top;
            } 
            else if (visibleHeight === bestVisibleHeight) {
              if (rect.top < bestTop) {
                bestTarget = el;
                bestTop = rect.top;
              }
            }
          }
        }
      });

      if (bestTarget) {
        const id = bestTarget.id || bestTarget.name;
        document.querySelectorAll('.active-spy').forEach(el => el.classList.remove('active-spy'));
        document.querySelectorAll('.active-spy-parent').forEach(el => el.classList.remove('active-spy-parent'));
        
        const activeLink = tocMap.get(id);
        activeLink.classList.add('active-spy');
        const parent = ext.deepClosest(activeLink, '.tocitem');
        if (parent) parent.classList.add('active-spy-parent');
        
        if (!ext.isTOCInteracting) {
          activeLink.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }
    }, {
      rootMargin: "-10% 0px -50% 0px"
    });

    const elementsToTrack = Array.from(ext.deepQuerySelectorAll(mainContent, '[id], a[name]')).filter(el => {
      const id = el.id || el.name;
      return id && tocMap.has(id);
    });
    elementsToTrack.forEach(el => ext.scrollSpyObserver.observe(el));
  };

})(window.egovExt);

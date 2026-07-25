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

    // Enterキーで検索を実行
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const val = input.value.trim();
        if (!val) return;
        
        let normalized = val.replace(/[０-９]/g, function(s) {
          return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
        });
        
        normalized = normalized.replace(/[第条]/g, '');
        normalized = normalized.replace(/(-|の|ー|−|—|_)/g, '_');

        const selector = `[id="Mp-At_${normalized}"], [id$="-At_${normalized}"], [name="Mp-At_${normalized}"], [name$="-At_${normalized}"]`;
        const targetEl = document.querySelector(selector);

        if (targetEl) {
          ext.fastSmoothScroll(targetEl, 250);
          
          targetEl.classList.remove('egov-ext-jump-target');
          
          setTimeout(() => {
            targetEl.classList.add('egov-ext-jump-target');
            
            setTimeout(() => {
              targetEl.classList.remove('egov-ext-jump-target');
            }, 3000);
          }, 10);
        } else {
          input.select();
        }
      }
    });
  };

})(window.egovExt);

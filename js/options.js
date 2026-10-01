/**
 * options.js
 *
 * 詳細設定画面（options.html）のスクリプト。
 * トグルUIの実体は js/settings.js の initSettingsUI() が担い、
 * ここでは詳細設定固有の振る舞い（全タブへの通知、他画面からの変更の逆同期）と、
 * マーカー・メモの保存先の切り替え・使用量の表示・書き出し・読み込み（js/annotation_store.js）を扱う。
 */

/**
 * マーカー・メモの欄を初期化する
 */
async function setupAnnotationPanel() {
  const ext = window.egovExt;
  const radios = Array.from(document.querySelectorAll('input[name="annotation-mode"]'));
  const usage = document.getElementById('annotation-usage');
  const status = document.getElementById('annotation-status');
  const exportBtn = document.getElementById('annotation-export');
  const importInput = document.getElementById('annotation-import');
  if (!radios.length || !usage || !ext.getAnnotationMode) return;

  function setStatus(text, isError) {
    status.textContent = text;
    status.classList.toggle('is-error', !!isError);
  }

  /** 保存先と、いま保存している量を表示し直す */
  async function refresh() {
    const mode = await ext.getAnnotationMode();
    radios.forEach(r => { r.checked = r.value === mode; });
    const all = await ext.loadAllAnnotations();
    let count = 0;
    all.forEach(list => { count += list.length; });
    const laws = Array.from(all.values()).filter(list => list.length > 0).length;
    if (mode === 'sync') {
      const u = await ext.getAnnotationSyncUsage();
      usage.textContent = `いま ${laws} 法令・${count} 件を同期しています。同期の枠のうち ${(u.bytes / 1024).toFixed(1)}KB／${Math.round(u.budget / 1024)}KB、${u.items}／${u.maxItems} 件を使っています。`;
    } else {
      usage.textContent = `いま ${laws} 法令・${count} 件を、この端末の中に保存しています。`;
    }
  }

  radios.forEach(radio => {
    radio.addEventListener('change', async () => {
      if (!radio.checked) return;
      const target = radio.value;
      setStatus('切り替えています…');
      const result = await ext.setAnnotationMode(target);
      if (!result.ok) {
        if (result.reason === 'full') {
          setStatus(`同期の枠（約${Math.round(ext.ANNOTATION_SYNC_BUDGET / 1024)}KB・${ext.ANNOTATION_SYNC_MAX_ITEMS}件）に入りきらないので、切り替えませんでした（いまの分は ${(result.bytes / 1024).toFixed(1)}KB・${result.items}件）。使わないマーカー・メモを消してからお試しください。`, true);
        } else if (result.reason === 'tooLong') {
          setStatus(`メモが${ext.ANNOTATION_MEMO_MAX.sync}字を超えているものが ${result.tooLong} 件あるので、切り替えませんでした。短くしてからお試しください。`, true);
        } else {
          setStatus('切り替えられませんでした。もう一度お試しください。', true);
        }
      } else {
        setStatus(target === 'sync'
          ? `保存先を「ブラウザの同期」にし、${result.items || 0} 件を移しました。`
          : '保存先を「この端末の中だけ」にし、同期していた分をこの端末へ移しました。');
      }
      await refresh();
    });
  });

  exportBtn.addEventListener('click', async () => {
    const data = await ext.exportAnnotations();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    a.href = url;
    a.download = `egov-himotoki-markers-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    let count = 0;
    Object.values(data.laws).forEach(list => { count += list.length; });
    setStatus(`${Object.keys(data.laws).length} 法令・${count} 件を書き出しました。`);
  });

  importInput.addEventListener('change', async () => {
    const file = importInput.files && importInput.files[0];
    importInput.value = '';
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (e) {
      setStatus('ファイルを読めませんでした（JSON の形ではありません）。', true);
      return;
    }
    const result = await ext.importAnnotations(data);
    if (result.ok) {
      setStatus(`読み込みました（新しく ${result.added} 件、更新 ${result.updated} 件）。`);
    } else if (result.reason === 'format') {
      setStatus('この拡張機能で書き出したマーカー・メモのファイルではありません。', true);
    } else if (result.reason === 'full') {
      setStatus('同期の枠に入りきらないので読み込みませんでした。保存先を「この端末の中だけ」にしてからお試しください。', true);
    } else if (result.reason === 'tooLong') {
      setStatus(`同期のときのメモの上限（${ext.ANNOTATION_MEMO_MAX.sync}字）を超えるものが ${result.tooLong} 件あるので読み込みませんでした。保存先を「この端末の中だけ」にしてからお試しください。`, true);
    } else {
      setStatus('読み込めませんでした。もう一度お試しください。', true);
    }
    await refresh();
  });

  if (ext.onAnnotationsChanged) ext.onAnnotationsChanged(refresh);
  await refresh();
}

document.addEventListener('DOMContentLoaded', async () => {
  await window.egovExt.initSettingsUI({ allTabs: true, syncFromStorage: true });
  await setupAnnotationPanel();
});

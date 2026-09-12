/**
 * ツールチップの配置ロジック（上下フリップ・左右クランプ・矢印位置）の検証。
 *
 * jsdom はレイアウトを持たないため、アンカーの矩形とツールチップの実寸を
 * 明示的にスタブして、position() の計算結果だけを確かめる。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const VIEWPORT_W = 1000;
const VIEWPORT_H = 800;

const dom = new JSDOM('<!DOCTYPE html><body></body>', { url: 'https://laws.e-gov.go.jp/law/X' });
const { window } = dom;
global.window = window;
global.document = window.document;
global.Node = window.Node;
global.NodeFilter = window.NodeFilter;

// ビューポート寸法を固定する
Object.defineProperty(window.document.documentElement, 'clientWidth', { value: VIEWPORT_W });
Object.defineProperty(window.document.documentElement, 'clientHeight', { value: VIEWPORT_H });

for (const src of ['js/settings.js', 'js/utils.js', 'js/tooltip.js']) {
  window.eval(fs.readFileSync(path.join(ROOT, src), 'utf8'));
}
const ext = window.egovExt;

const TIP_W = 400;
const TIP_H = 200;

/**
 * 指定した位置・サイズのアンカーに対してツールチップを配置し、結果を返す
 * @param {{left:number, top:number, width:number, height:number}} rect
 * @returns {{left:number, top:number, flipped:boolean, arrowX:number}}
 */
function place(rect) {
  const tooltip = ext.createTooltip({ variant: 'test', showDelay: 0, hideDelay: 0 });
  document.body.appendChild(tooltip.el);

  // ツールチップの実寸をスタブ
  Object.defineProperty(tooltip.el, 'offsetWidth', { value: TIP_W, configurable: true });
  Object.defineProperty(tooltip.el, 'offsetHeight', { value: TIP_H, configurable: true });

  const anchor = document.createElement('span');
  document.body.appendChild(anchor);
  anchor.getBoundingClientRect = () => ({
    left: rect.left, top: rect.top,
    right: rect.left + rect.width, bottom: rect.top + rect.height,
    width: rect.width, height: rect.height, x: rect.left, y: rect.top
  });

  tooltip.show(anchor, document.createTextNode('内容'), true);

  const result = {
    left: parseFloat(tooltip.el.style.left),
    top: parseFloat(tooltip.el.style.top),
    flipped: tooltip.el.classList.contains('is-flipped'),
    arrowX: parseFloat(tooltip.el.style.getPropertyValue('--egov-arrow-x'))
  };
  tooltip.destroy();
  anchor.remove();
  return result;
}

let failures = 0;
function check(name, fn) {
  try {
    const r = fn();
    if (r === false) throw new Error('assertion returned false');
    console.log(`✓ ${name}${typeof r === 'string' ? ` → ${r}` : ''}`);
  } catch (e) {
    failures++;
    console.error(`✗ ${name}: ${e.message}`);
  }
}

console.log('--- ツールチップ配置 ---');

check('十分な余白があればアンカーの下に出る', () => {
  const r = place({ left: 100, top: 100, width: 120, height: 20 });
  if (r.flipped) throw new Error('不要なフリップが起きた');
  if (r.top !== 128) throw new Error(`top=${r.top} (期待 128 = 120 + gap 8)`);
  if (r.left !== 100) throw new Error(`left=${r.left} (期待 100)`);
  return `top=${r.top} left=${r.left}`;
});

check('下に入らなければ上へフリップする', () => {
  // アンカー下端 720、残り 800-720-8=72 < 200 なので上へ
  const r = place({ left: 100, top: 700, width: 120, height: 20 });
  if (!r.flipped) throw new Error('フリップしていない');
  if (r.top !== 700 - 8 - TIP_H) throw new Error(`top=${r.top} (期待 ${700 - 8 - TIP_H})`);
  return `top=${r.top} flipped`;
});

check('上下どちらにも入らない場合はビューポート内に収める', () => {
  const r = place({ left: 100, top: 300, width: 120, height: 300 });
  if (r.top < 10) throw new Error(`上にはみ出した: top=${r.top}`);
  if (r.top + TIP_H > VIEWPORT_H - 10) throw new Error(`下にはみ出した: bottom=${r.top + TIP_H}`);
  return `top=${r.top}`;
});

check('右端で右にはみ出さない', () => {
  const r = place({ left: 900, top: 100, width: 80, height: 20 });
  const right = r.left + TIP_W;
  if (right > VIEWPORT_W - 10) throw new Error(`右にはみ出した: right=${right}`);
  if (r.left !== VIEWPORT_W - TIP_W - 10) throw new Error(`left=${r.left} (期待 ${VIEWPORT_W - TIP_W - 10})`);
  return `left=${r.left} right=${right}`;
});

check('左端で左にはみ出さない', () => {
  const r = place({ left: -50, top: 100, width: 80, height: 20 });
  if (r.left < 10) throw new Error(`左にはみ出した: left=${r.left}`);
  return `left=${r.left}`;
});

check('矢印がアンカー中心を指す', () => {
  const r = place({ left: 100, top: 100, width: 120, height: 20 });
  // アンカー中心 160、ツールチップ左端 100 → 相対 60
  if (r.arrowX !== 60) throw new Error(`arrowX=${r.arrowX} (期待 60)`);
  return `arrowX=${r.arrowX}`;
});

check('クランプ時も矢印はツールチップ内に収まる', () => {
  const r = place({ left: 900, top: 100, width: 80, height: 20 });
  if (r.arrowX < 14 || r.arrowX > TIP_W - 14) {
    throw new Error(`arrowX=${r.arrowX} が範囲外`);
  }
  return `arrowX=${r.arrowX} (left=${r.left})`;
});

check('スクロール量が座標に加算される', () => {
  Object.defineProperty(window, 'scrollY', { value: 500, configurable: true });
  Object.defineProperty(window, 'scrollX', { value: 30, configurable: true });
  const r = place({ left: 100, top: 100, width: 120, height: 20 });
  Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
  Object.defineProperty(window, 'scrollX', { value: 0, configurable: true });
  if (r.top !== 128 + 500) throw new Error(`top=${r.top} (期待 628)`);
  if (r.left !== 100 + 30) throw new Error(`left=${r.left} (期待 130)`);
  return `top=${r.top} left=${r.left}`;
});

function placeSide(rect) {
  const tooltip = ext.createTooltip({ variant: 'preview', placement: 'side', showDelay: 0, hideDelay: 0 });
  document.body.appendChild(tooltip.el);
  Object.defineProperty(tooltip.el, 'offsetWidth', { value: TIP_W, configurable: true });
  Object.defineProperty(tooltip.el, 'offsetHeight', { value: TIP_H, configurable: true });

  const anchor = document.createElement('span');
  document.body.appendChild(anchor);
  anchor.getBoundingClientRect = () => ({
    left: rect.left, top: rect.top,
    right: rect.left + rect.width, bottom: rect.top + rect.height,
    width: rect.width, height: rect.height, x: rect.left, y: rect.top
  });

  tooltip.show(anchor, document.createTextNode('内容'), true);

  const result = {
    left: parseFloat(tooltip.el.style.left),
    top: parseFloat(tooltip.el.style.top),
    flippedLeft: tooltip.el.classList.contains('is-flipped-left')
  };
  tooltip.destroy();
  anchor.remove();
  return result;
}

check('サイド配置: 右側に余白があれば右側に出る', () => {
  const r = placeSide({ left: 100, top: 100, width: 120, height: 20 });
  // right = 220, gap = 8 → left = 228
  if (r.flippedLeft) throw new Error('不要な左フリップが起きた');
  if (r.left !== 228) throw new Error(`left=${r.left} (期待 228)`);
  if (r.top !== 100) throw new Error(`top=${r.top} (期待 100)`);
  return `left=${r.left} top=${r.top}`;
});

check('サイド配置: 右側に入らなければ左側へフリップする', () => {
  // left = 700, width = 100 → right = 800. 残り 1000 - 800 - 8 = 192 < 400 なので左へ
  // left = 700 - 8 - 400 = 292
  const r = placeSide({ left: 700, top: 100, width: 100, height: 20 });
  if (!r.flippedLeft) throw new Error('左フリップしていない');
  if (r.left !== 292) throw new Error(`left=${r.left} (期待 292)`);
  return `left=${r.left} flippedLeft`;
});

console.log(failures === 0 ? '\n✅ 全て成功' : `\n❌ ${failures} 件失敗`);
process.exit(failures ? 1 : 0);

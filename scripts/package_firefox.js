/**
 * Firefox用パッケージングスクリプト
 * manifest.firefox.json を manifest.json として含めた e-gov-layout-changes-firefox.zip を生成します。
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const FIREFOX_ZIP = path.join(PROJECT_ROOT, 'e-gov-layout-changes-firefox.zip');
const TEMP_DIR = path.join(PROJECT_ROOT, '.firefox_package_tmp');

// 含めるファイル・ディレクトリ
const ASSETS_TO_COPY = [
  'options.html',
  'popup.html',
  'LICENSE',
  '_locales',
  'css',
  'js',
  'icons'
];

function cleanup() {
  if (fs.existsSync(TEMP_DIR)) {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  }
}

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const file of fs.readdirSync(src)) {
      if (file === '.DS_Store') continue;
      copyRecursive(path.join(src, file), path.join(dest, file));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

function main() {
  console.log('🦊 Firefox用アドオンパッケージの生成を開始します...');

  // 1. 既存ZIPと一時ディレクトリのクリーンアップ
  if (fs.existsSync(FIREFOX_ZIP)) {
    fs.unlinkSync(FIREFOX_ZIP);
    console.log('   既存の e-gov-layout-changes-firefox.zip を削除しました。');
  }
  cleanup();

  try {
    // 2. 一時ディレクトリの作成
    fs.mkdirSync(TEMP_DIR, { recursive: true });

    // 3. manifest.firefox.json を manifest.json としてコピー
    const firefoxManifestSrc = path.join(PROJECT_ROOT, 'manifest.firefox.json');
    const firefoxManifestDest = path.join(TEMP_DIR, 'manifest.json');
    if (!fs.existsSync(firefoxManifestSrc)) {
      throw new Error(`manifest.firefox.json が見つかりません: ${firefoxManifestSrc}`);
    }
    fs.copyFileSync(firefoxManifestSrc, firefoxManifestDest);
    console.log('   manifest.firefox.json -> manifest.json として配置完了。');

    // 4. アセットのコピー
    for (const asset of ASSETS_TO_COPY) {
      const srcPath = path.join(PROJECT_ROOT, asset);
      const destPath = path.join(TEMP_DIR, asset);
      if (fs.existsSync(srcPath)) {
        copyRecursive(srcPath, destPath);
        console.log(`   ${asset} をコピーしました。`);
      } else {
        console.warn(`   ⚠️ 警告: ${asset} が見つかりません。`);
      }
    }

    // 5. ZIP圧縮の実行
    console.log('   ZIPアーカイブを作成中...');
    execSync(`cd "${TEMP_DIR}" && zip -r "${FIREFOX_ZIP}" . -x "*.DS_Store*"`, { stdio: 'pipe' });

    const zipStat = fs.statSync(FIREFOX_ZIP);
    console.log(`\n🎉 Firefox用パッケージ作成完了: e-gov-layout-changes-firefox.zip (${(zipStat.size / 1024).toFixed(1)} KB)`);

    // 6. パッケージ内容の検証表示
    const zipList = execSync(`unzip -l "${FIREFOX_ZIP}"`, { encoding: 'utf8' });
    console.log('   含まれるファイル数:', zipList.trim().split('\n').length - 4);

  } catch (err) {
    console.error('❌ エラーが発生しました:', err);
    process.exit(1);
  } finally {
    // 7. 一時ディレクトリの削除
    cleanup();
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };

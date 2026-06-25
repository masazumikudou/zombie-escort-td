// ゲームファイルをwww/にコピーする（Capacitor用ビルドスクリプト）
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WWW  = path.join(ROOT, 'www');

const COPY_TARGETS = [
  'index.html',
  'balance.json',
  'js',
  'assets',
  'stages',
];

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    for (const child of fs.readdirSync(src)) {
      copyRecursive(path.join(src, child), path.join(dest, child));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

if (!fs.existsSync(WWW)) fs.mkdirSync(WWW);

for (const target of COPY_TARGETS) {
  const src  = path.join(ROOT, target);
  const dest = path.join(WWW, target);
  if (!fs.existsSync(src)) { console.log(`skip: ${target}`); continue; }
  copyRecursive(src, dest);
  console.log(`copied: ${target}`);
}

console.log('build done → www/');

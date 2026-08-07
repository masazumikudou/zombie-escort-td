'use strict';
// R-6: ステージJSON静的検証スクリプト（1便目：座標・ルール突き合わせ系・9項目）
// シムを一切動かさず、座標とルールの整合性だけを機械的にチェックする。
// 「JSONの書き損じがエラーなく素通りし、実行結果から逆算しないと発覚しない」事故の再発防止。
//
// 使い方: node validate_stage.js stages/xxx.json
//
// 判定は2段階:
//   ERROR: 量産に進めない致命的な不整合
//   WARN : 動くが小松の確認が要る
//
// 2便目（未実装・別発注）: 枠外spawnの侵入所要時間 vs segment猶予の計算、猶予マップ出力モード

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.resolve(__dirname);

// ─── config.js から GROUND_BLOCK_DEFS / PROP_DEFS を取得 ─────────────────────
// config.jsは他ファイルに依存しないため、vmコンテキストへの単独読み込みで足りる
// （run_sim.jsと同じくvm.runInContext経由で取得。トップレベルconst/letの
//  ctx.NAMEプロパティ露出はNode vmの既知の癖で不安定なため、この方式に統一する）
const ctx = vm.createContext({ console, Math, JSON });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/config.js'), 'utf8'), ctx);
const GROUND_BLOCK_DEFS = vm.runInContext('GROUND_BLOCK_DEFS', ctx);
const PROP_DEFS         = vm.runInContext('PROP_DEFS', ctx);

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ground_cells登録セルを、ブロック型タイル（blockW/blockH・blockCells）分だけ展開して
// 「道路として歩行可能」なセル集合を作る。GameScene.js（87-109行目）と同一ロジック。
function buildRoadSet(groundCells) {
  const roadSet = new Set();
  for (const cell of groundCells ?? []) {
    const bdef = GROUND_BLOCK_DEFS[cell.type];
    const bw = bdef ? (bdef.blockW ?? bdef.blockCells ?? 1) : 1;
    const bh = bdef ? (bdef.blockH ?? bdef.blockCells ?? 1) : 1;
    for (let dc = 0; dc < bw; dc++) {
      for (let dr = 0; dr < bh; dr++) {
        roadSet.add(`${cell.col + dc},${cell.row + dr}`);
      }
    }
  }
  return roadSet;
}

// propフットプリント（col,rowを左上原点として cols×rows 展開）。run_sim.jsのcomputePropBlockedと同一ロジック。
// 【注意】発注文の「3×3フットプリント範囲（中心座標±1マス）」という記述は実装と異なる。
// 実際のPROP_DEFSはprop種別ごとにサイズが違い（1×1〜15×3まで）、col/rowは中心ではなく
// 左上原点として扱われる（run_sim.js computePropBlocked・GameScene.js _propBlocked構築ロジックと同一）。
// シム/実機と食い違うと「シムが衝突の最終ゲートキーパー」の前提が崩れるため、実装に合わせた。
function propFootprintCells(prop) {
  const pdef = PROP_DEFS[prop.type];
  const cells = [];
  if (!pdef) return cells;
  for (let dc = 0; dc < (pdef.cols ?? 1); dc++) {
    for (let dr = 0; dr < (pdef.rows ?? 1); dr++) {
      cells.push({ col: prop.col + dc, row: prop.row + dr });
    }
  }
  return cells;
}

function collectPathCells(escorts) {
  const set = new Set();
  for (const e of escorts ?? []) {
    for (const p of e.path ?? []) set.add(`${p.col},${p.row}`);
  }
  return set;
}

// escort variant名 -> そのescort自身のpathセル集合
function collectPathCellsByEscort(escorts) {
  const map = new Map();
  for (const e of escorts ?? []) {
    map.set(e.variant, new Set((e.path ?? []).map(p => `${p.col},${p.row}`)));
  }
  return map;
}

// spawn名 -> それを実際に使用しているescort variantの集合
// 「ゼロ距離接触」はそのspawnを使うescort自身のpathとの重複でのみ発生する
// （異なるescortのpathとたまたま座標が重なっていても、そのescortがまだ登場していない
//  時点の話なので無害——本セッションでstage_確定ABAステージの検証時に実例で確認済み）
function collectSpawnOwners(escorts) {
  const owners = new Map();  // name -> Set<variant>
  for (const e of escorts ?? []) {
    for (const seg of e.segments ?? []) {
      for (const entry of [...(seg.initial ?? []), ...(seg.triggers ?? [])]) {
        if (!entry.spawn) continue;
        if (!owners.has(entry.spawn)) owners.set(entry.spawn, new Set());
        owners.get(entry.spawn).add(e.variant);
      }
    }
  }
  return owners;
}

function inGrid(col, row, cols, rows) {
  return col >= 0 && col < cols && row >= 0 && row < rows;
}

// ─── メイン検証 ──────────────────────────────────────────────────────────
function validateStage(stage) {
  const results = [];  // { item, level: 'ERROR'|'WARN', message }
  const add = (item, level, message) => results.push({ item, level, message });

  const cols = stage.grid?.cols;
  const rows = stage.grid?.rows;
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) {
    add(0, 'ERROR', `stage.gridが不正です（cols=${cols}, rows=${rows}）。以降の検証を中止します`);
    return results;
  }

  const groundCells   = stage.ground_cells ?? [];
  const hasRoadDef     = groundCells.length > 0;
  const roadSet         = buildRoadSet(groundCells);
  const pathCells       = collectPathCells(stage.escorts);           // 全escort合算（項目6用）
  const pathCellsByEscort = collectPathCellsByEscort(stage.escorts);   // escort別（項目2・5用）
  const spawnOwners     = collectSpawnOwners(stage.escorts);
  const spawns          = stage.spawns ?? {};

  // spawn名 -> それを使うescortたちの自身pathセルの和集合（未使用spawnは全escort合算にフォールバック）
  function ownerPathCellsFor(name) {
    const owners = spawnOwners.get(name);
    if (!owners || owners.size === 0) return pathCells;  // どのescortも使わないなら安全側に全合算で判定
    const merged = new Set();
    for (const variant of owners) {
      for (const cell of pathCellsByEscort.get(variant) ?? []) merged.add(cell);
    }
    return merged;
  }

  // spawnsをグリッド内／外で分類（グリッド外は「枠外spawn」として項目5で別途検証）
  const inGridSpawns  = [];
  const offGridSpawns = [];
  for (const [name, coord] of Object.entries(spawns)) {
    if (!coord || typeof coord.col !== 'number' || typeof coord.row !== 'number') {
      add(7, 'ERROR', `spawns.${name} の座標が不正です: ${JSON.stringify(coord)}`);
      continue;
    }
    if (inGrid(coord.col, coord.row, cols, rows)) inGridSpawns.push([name, coord]);
    else offGridSpawns.push([name, coord]);
  }

  // ── 項目1: 敵spawnが道路セル上か ──────────────────────────────────────
  if (!hasRoadDef) {
    add(1, 'WARN', `ground_cellsが未定義のためスキップ（road-only制約が発動しないステージ。意図的なら問題なし）`);
  } else {
    for (const [name, coord] of inGridSpawns) {
      if (!roadSet.has(`${coord.col},${coord.row}`)) {
        add(1, 'ERROR', `spawns.${name}(${coord.col},${coord.row}) は道路セル（ground_cells）上にありません`);
      }
    }
  }

  // ── 項目2: 敵spawnが護衛pathの真上でないか ────────────────────────────
  // 判定は「そのspawnを実際に使うescort自身のpath」に限定する（他escortのpathとの
  // 偶然の重なりは、そのescortがまだ登場していない時点の話なので無害）
  for (const [name, coord] of inGridSpawns) {
    if (ownerPathCellsFor(name).has(`${coord.col},${coord.row}`)) {
      add(2, 'ERROR', `spawns.${name}(${coord.col},${coord.row}) が使用escort自身の護衛pathの座標と重複しています（ゼロ距離接触の事故）`);
    }
  }

  // ── 項目3: 1交戦地の初期敵が4体以内か ─────────────────────────────────
  for (const escort of stage.escorts ?? []) {
    for (const seg of escort.segments ?? []) {
      const n = (seg.initial ?? []).length;
      if (n >= 5) {
        add(3, 'ERROR', `escort=${escort.variant} segment=${seg.segmentId} のinitial敵数が${n}体です（4体以内推奨）`);
      }
    }
  }

  // ── 項目4: propの足元が道路を侵食していないか ─────────────────────────
  if (!hasRoadDef) {
    add(4, 'WARN', `ground_cellsが未定義のためスキップ（road-only制約が発動しないステージ）`);
  } else {
    for (const prop of stage.props ?? []) {
      const cells = propFootprintCells(prop);
      const hitCells = cells.filter(c => roadSet.has(`${c.col},${c.row}`));
      if (hitCells.length > 0) {
        add(4, 'ERROR', `props ${prop.type}@(${prop.col},${prop.row}) のフットプリントが道路セルと重複: ${hitCells.map(c => `(${c.col},${c.row})`).join(' ')}`);
      }
    }
  }

  // ── 項目5: 枠外spawnの着地先が道路かつpath外か ────────────────────────
  for (const [name, coord] of offGridSpawns) {
    // bird等circleAt使用の枠外spawnは、盤内最寄りセルへの直進クランプではなく
    // 旋回地点(circleAt)周辺への進入になるため、この幾何とは無関係。対象外として明示する。
    const usedByBird = (stage.escorts ?? []).some(e =>
      (e.segments ?? []).some(seg =>
        (seg.triggers ?? []).some(t => t.spawn === name && (t.enemy?.circleAt || t.circleAt))
      )
    );
    if (usedByBird) {
      add(5, 'WARN', `spawns.${name}(${coord.col},${coord.row}) はcircleAt使用（鳥系）のためクランプ判定の対象外`);
      continue;
    }
    const cCol = clamp(coord.col, 0, cols - 1);
    const cRow = clamp(coord.row, 0, rows - 1);
    if (hasRoadDef && !roadSet.has(`${cCol},${cRow}`)) {
      add(5, 'ERROR', `spawns.${name}(${coord.col},${coord.row}) のクランプ後着地先(${cCol},${cRow})が道路セル上にありません`);
    }
    if (ownerPathCellsFor(name).has(`${cCol},${cRow}`)) {
      add(5, 'ERROR', `spawns.${name}(${coord.col},${coord.row}) のクランプ後着地先(${cCol},${cRow})が使用escort自身の護衛pathの座標と重複しています`);
    }
  }

  // ── 項目6: buildSpotが道路セル上・path外か ────────────────────────────
  for (const bs of stage.buildSpots ?? []) {
    if (!inGrid(bs.col, bs.row, cols, rows)) {
      add(6, 'ERROR', `buildSpots(${bs.col},${bs.row}) がグリッド範囲外です`);
      continue;
    }
    if (hasRoadDef && !roadSet.has(`${bs.col},${bs.row}`)) {
      add(6, 'ERROR', `buildSpots(${bs.col},${bs.row}) は道路セル上にありません`);
    }
    if (pathCells.has(`${bs.col},${bs.row}`)) {
      add(6, 'ERROR', `buildSpots(${bs.col},${bs.row}) が護衛pathの座標と重複しています`);
    }
  }

  // ── 項目7: 全座標がグリッド範囲内か（buildSpots/ground_cells/props/path/盤内spawns） ──
  for (const bs of stage.buildSpots ?? []) {
    if (!inGrid(bs.col, bs.row, cols, rows)) {
      add(7, 'ERROR', `buildSpots(${bs.col},${bs.row}) がグリッド範囲外です（項目6と重複報告）`);
    }
  }
  for (const cell of groundCells) {
    if (!inGrid(cell.col, cell.row, cols, rows)) {
      add(7, 'ERROR', `ground_cells(${cell.col},${cell.row}) type=${cell.type} がグリッド範囲外です`);
    }
  }
  for (const prop of stage.props ?? []) {
    const cells = propFootprintCells(prop);
    const outOfRange = cells.filter(c => !inGrid(c.col, c.row, cols, rows));
    if (outOfRange.length > 0) {
      add(7, 'ERROR', `props ${prop.type}@(${prop.col},${prop.row}) のフットプリントがグリッド範囲外にはみ出しています: ${outOfRange.map(c => `(${c.col},${c.row})`).join(' ')}`);
    }
  }
  for (const escort of stage.escorts ?? []) {
    for (const p of escort.path ?? []) {
      if (!inGrid(p.col, p.row, cols, rows)) {
        add(7, 'ERROR', `escort=${escort.variant} のpath座標(${p.col},${p.row})がグリッド範囲外です`);
      }
    }
  }
  // 盤内spawnsは項目1classifyの時点で既にグリッド範囲内であることが保証されているため
  // （グリッド外を意図した座標=offGridSpawnsは項目5で別途検証済み）、ここでの追加チェックは不要。

  // ── 項目8: 資金の供給元ゼロ検出 ───────────────────────────────────────
  const stageMoney = stage.startMoney;
  const escortMoneys = (stage.escorts ?? []).map(e => e.startMoney);
  const allZeroOrUndefined = (!stageMoney) && escortMoneys.every(m => !m);
  if (allZeroOrUndefined) {
    add(8, 'ERROR', `stage.startMoneyと全escortのstartMoneyが全て0または未定義です。資金がどこからも供給されません`);
  }

  // ── 項目9: enemyへのhp直書き検出（v2.8ルール） ────────────────────────
  for (const escort of stage.escorts ?? []) {
    for (const seg of escort.segments ?? []) {
      const hasSegComment = Object.keys(seg).some(k => k.startsWith('_comment'));
      const enemyEntries = [
        ...(seg.initial ?? []).map(x => ({ src: 'initial', spawn: x.spawn, enemy: x.enemy ?? x })),
        ...(seg.triggers ?? []).map(x => ({ src: 'trigger', spawn: x.spawn, enemy: x.enemy ?? x })),
      ];
      for (const { src, spawn, enemy } of enemyEntries) {
        if (enemy && enemy.hp !== undefined && !hasSegComment) {
          add(9, 'WARN', `escort=${escort.variant} segment=${seg.segmentId} の${src}(spawn=${spawn}) にenemy.hp明示指定(${enemy.hp})があり_comment系キーがありません（balance.json値を上書きする意図的な変更か確認要）`);
        }
      }
    }
  }

  return results;
}

// ─── 出力 ────────────────────────────────────────────────────────────────
const ITEM_LABELS = {
  0: 'grid定義',
  1: '敵spawnが道路セル上か',
  2: '敵spawnが護衛pathの真上でないか',
  3: '1交戦地の初期敵が4体以内か',
  4: 'propの足元が道路を侵食していないか',
  5: '枠外spawnの着地先が道路かつpath外か',
  6: 'buildSpotが道路セル上・path外か',
  7: '全座標がグリッド範囲内か',
  8: '資金の供給元ゼロ検出',
  9: 'enemyへのhp直書き検出',
};

function printReport(stageFile, results) {
  console.log(`=== validate_stage.js: ${stageFile} ===`);
  let errorCount = 0, warnCount = 0;
  for (let item = 0; item <= 9; item++) {
    if (item === 0) continue;
    const itemResults = results.filter(r => r.item === item);
    const errs  = itemResults.filter(r => r.level === 'ERROR');
    const warns = itemResults.filter(r => r.level === 'WARN');
    if (itemResults.length === 0) {
      console.log(`[${item}] ${ITEM_LABELS[item]} ... OK`);
      continue;
    }
    const label = errs.length > 0 ? `NG (ERROR ${errs.length}件)` : `OK (WARN ${warns.length}件)`;
    console.log(`[${item}] ${ITEM_LABELS[item]} ... ${label}`);
    for (const r of itemResults) {
      console.log(`    ${r.level === 'ERROR' ? '[ERROR]' : '[WARN] '} ${r.message}`);
    }
  }
  errorCount = results.filter(r => r.level === 'ERROR').length;
  warnCount  = results.filter(r => r.level === 'WARN').length;
  console.log('');
  console.log(`=== 判定: ${errorCount > 0 ? 'NG' : 'OK'} (ERROR ${errorCount}件 / WARN ${warnCount}件) ===`);
  return errorCount === 0;
}

function main() {
  const stageFile = process.argv[2];
  if (!stageFile) {
    console.error('使い方: node validate_stage.js <stageFile>');
    process.exit(1);
  }
  const stage = JSON.parse(fs.readFileSync(path.join(ROOT, stageFile), 'utf8'));
  const results = validateStage(stage);
  const ok = printReport(stageFile, results);
  process.exit(ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = { validateStage };

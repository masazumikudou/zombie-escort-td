# ステージ設計ガイド（統合版）
## 僕・Claude・CC 共同作業用 確定ルールと知見

> このドキュメント1本 + `stages/stage_01_meander_verified.json` を渡せばステージ設計に入れる。  
> 設計前に必ず通読すること。

---

## 1. 絶対ルール（破ると実機で壊れる）

### 1-1. prop フットプリント上にタワー・buildSpot を置かない

prop の footprint = ステージ JSON の `col,row` を左上として `cols × rows` 分のセル全部。

```
例: ハンバーガー(5,10) / cols:3, rows:3
    → col5-7, row10-12 が全部ブロック
```

**木2（1×1）も prop なので衝突する。** 視覚的に小さいが footprint は 1 セル占有している。

### 1-2. シムが衝突の最終ゲートキーパー

`run_sim.js` はタワー配置時に `pf.isWalkable()` でチェックし、prop フットプリント内なら **`process.exit(1)` で強制停止**する。  
シムを通れば実機でも問題ない。シムを通らないパターンは実機に持ち込まない。

```
[ERROR] prop衝突: sniper@(5,10) はpropフットプリント内です。配置不可。
```

---

## 2. PROP_DEFS フットプリント早見表

`config.js` の `PROP_DEFS` 定義値。ステージ JSON の type 名と完全一致。

| type | cols | rows | 備考 |
|---|---|---|---|
| 家青 | 3 | 3 | |
| 家緑 | 3 | 3 | |
| アイスクリーム | 3 | 3 | |
| ハンバーガー | 3 | 3 | |
| shop_front | 3 | 3 | |
| 駐車場 | 4 | 2 | |
| 駐車場車有り | 4 | 2 | |
| 木2 | 1 | 1 | 小さく見えても要注意 |

---

## 3. 経済設計（ステージ難易度の根拠）

### コインの流れ
- **収入**：初期資金（`startMoney`）＋撃破報酬（enemy.reward）
- **支出**：タワー建設（即時 or `@ms` 遅延）
- 時間ベースの自動収入なし（足止め金策が最適解化するのを防ぐため）

### タワーコスト（現行 balance.json 準拠）

| type | コスト | 射程（セル） | 備考 |
|---|---|---|---|
| basic | 100 | 2.5 | 汎用 |
| rapid | 150 | 2.0 | 速射 |
| sniper | 200 | 4.5 | 長射程・遅射 |
| laser | 350 | 999 | 全射程 |
| punch | 120 | 1 | 近接 |
| bat | 180 | 1 | 近接 |

> **数値の正典は `balance.json`。** ステージ検討時はここの数値を参照。コードに数値を書かない。

### startMoney 設計の目安
- 開幕即置き 3 タワーが限界になる程度が中級難易度
- 例：sniper(200)×3 = 600。startMoney:900 なら残り300のバッファ

---

## 4. シミュレーター（run_sim.js）の使い方

### 実行
```
node scratchpad/run_sim.js
```

### タワーパターン書式
```
type:col,row          # 即時配置（startMoney から購入）
type:col,row@ms       # ms ミリ秒後に配置（その時点の所持金から購入）
```

### 3パターンテストの目安

| ラベル | 意味 | 期待結果 |
|---|---|---|
| 良 | 最善配置（模範解答） | HP100% CLEAR |
| 並 | 普通のプレイ | HP60% CLEAR |
| 雑 | 最低限だけ置く | HP0% GAMEOVER |

---

## 5. 確定ステージ — stage_01_meander_verified.json

### 基本パラメーター

| 項目 | 値 |
|---|---|
| id | stage_custom |
| name | 確定中級ステージ |
| grid | 20×20 |
| startMoney | 900 |
| minSurvivors | 1 |

### 交戦地（spawnEvents 時系列）

| 交戦地 | spawn座標 | 出現時刻 | leashTo | 備考 |
|---|---|---|---|---|
| A | (19,3) | 15.3s | (14,3) | count:2, interval:1000ms |
| B | (14,14) | 30.3s | (14,9) | |
| C | (0,9) | 64.5s | (3,9) | |
| D | (0,15) | 79.5s | (3,15) | |
| E | (9,19) | 98.2s | (7,15) | |
| F1 | (3,19) | 105s | なし | 演出、speed:45 |
| F2 | (8,19) | 108s | なし | 演出、speed:45 |
| F3 | (13,19) | 111s | なし | 演出、speed:45 |

**F系（F1/F2/F3）:** `leashTo` なしの演出スポーン。墓デカールは表示する。

### buildSpots 確定 14 箇所

```
(12,4) (15,4) (4,8)  (16,8) (15,9) (4,10)
(4,14) (1,16) (13,2) (16,4) (16,9) (5,8)
(2,16) (6,16)
```

除外済みの理由：
- `(12,10)` → shop_front(10,10) 衝突
- `(2,10)` → アイスクリーム(0,10) 衝突

### 確定テストパターン（シム検証済み）

```
良: sniper:16,4 sniper:15,9 sniper:4,10 sniper:4,14@76000 basic:6,16@0
並: sniper:12,4 sniper:15,9 sniper:4,10 sniper:4,14@76000 basic:6,16@0
雑: basic:12,4 basic:16,8@20000
```

**過去に使っていたが prop 衝突で NG だった座標（使用禁止）:**
- `sniper:5,10` → ハンバーガー(5,10) 衝突
- `sniper:2,14` → 木2(2,14) 衝突

---

## 6. ステージ JSON テンプレート構造

実物は `stages/stage_01_meander_verified.json` を参照。構造の骨格は以下の通り。

```json
{
  "id": "stage_XX",
  "name": "ステージ名",
  "grid": { "cols": 20, "rows": 20 },
  "startMoney": 900,
  "minSurvivors": 1,
  "escorts": [{
    "variant": "dad",
    "startTrigger": "afterPrevious",
    "start": { "col": 0, "row": 3 },
    "goal":  { "col": 19, "row": 15 },
    "path": [ { "col": 0, "row": 3 }, ... ],
    "hp": 100,
    "speed": 40
  }],
  "obstacles": [],
  "spawns": {
    "A": { "col": 19, "row": 3 }
  },
  "spawnEvents": [{
    "time": 15.3,
    "spawn": "A",
    "enemy": { "type": "salaryman", "hp": 200, "speed": 30, "damage": 10, "reward": 20 },
    "count": 2,
    "interval": 1000,
    "leashTo": { "col": 14, "row": 3 }
  }],
  "buildSpots": [
    { "col": 12, "row": 4 }
  ],
  "encounterHints": [
    { "col": 14, "row": 3, "note": "交戦地A（角）" }
  ],
  "ground_cells": [ ... ],
  "props": [
    { "type": "家青", "col": 0, "row": 5 }
  ]
}
```

**spawnEvents キー:**
- `time` : 秒単位（例: 15.3 = 15300ms）
- `leashTo` : エスコートの経路上の追跡開始地点。省略すると演出スポーン扱い
- `count` : 出現数。複数のとき `interval`（ms）で間隔指定

---

## 7. ステージ追加・更新手順

1. JSON 作成 → `stages/` に配置
2. `run_sim.js` のパスを変更して 3 パターン実行
   - `process.exit(1)` で止まったらパターン修正してから続ける
3. `stages/index.json` に追加（title も設定）
4. 旧ステージは削除ではなく `stages/_archive/` に移動

---

## 8. 落とし穴・既知の罠

**スプライトが footprint 外に視覚的にはみ出すことがある**  
画像が footprint より大きく見える場合がある。目視ではなくコードで機械的にチェックすること（`check_collisions.js`）。

**`木2` は視覚的に小さいが衝突する**  
1×1 の木でも `pf.blocked` に入るため タワーもスポーンも配置不可。シムが検出する。

**ブラウザキャッシュ**  
JSON 変更後に画面が変わらない場合は `Ctrl+Shift+R` で強制リロード。

---

*最終更新: 2026-07-09*

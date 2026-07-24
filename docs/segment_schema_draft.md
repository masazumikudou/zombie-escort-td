# 区間スキーマ（segments）仕様 v1.0

**この文書の役割**: 新文法（区間制・位置トリガー）のJSONスキーマの正確な形を記録する。工程表の必読リストに参照だけあって実体が無かったため、2026-07-24にCCがコード（`SegmentManager`/`SpawnEventManager`）と実ステージ（`stage_本番テスト（読める盤面）.json`）から逆算して作成した。

**正典はコード**: この文書とコード（`js/SpawnEventManager.js`のSegmentManagerクラス）が食い違った場合はコードを正とする。仕様変更時はこの文書の更新を忘れないこと。

## escort.segments（護衛ごとの配列）

`segments`は**stage直下ではなく各escortオブジェクト直下**のフィールド。escortごとに別々のsegments配列を持てる（例: dadとmomで別の敵配置にする等）。

```json
{
  "escorts": [
    {
      "variant": "dad",
      "path": [ { "col": 0, "row": 3 }, /* ... */ ],
      "segments": [ /* ← ここ */ ]
    }
  ]
}
```

## segments配列の各要素

```json
{
  "segmentId": "seg1_yomi_to_zouen",
  "range": { "fromWp": 0, "toWp": 20 },
  "initial": [ /* 下記参照 */ ],
  "triggers": [ /* 下記参照 */ ],
  "onExit": "retreat"
}
```

| キー | 必須/任意 | 内容 |
|---|---|---|
| `segmentId` | 任意 | ログ・デバッグ用のラベル。ゲームロジックには使われない |
| `range.fromWp` / `range.toWp` | 必須 | 護衛`path`配列のwaypointインデックス範囲。この区間の生存期間 |
| `initial` | 必須（空配列可） | 開幕から見えている脅威のリスト |
| `triggers` | 必須（空配列可） | 護衛の進行に応じて発火する侵入のリスト |
| `onExit` | 必須 | 区間終了時の処理。現状`"retreat"`のみ実装済み（区間内の残敵を退場させる） |

区間は`fromWp`の小さい順に処理され、護衛の`wpIdx`が`toWp`を超えると次区間へ遷移する。

## initial（見える脅威）

```json
{ "spawn": "I1A", "enemy": { "type": "salaryman", "hp": 200, "speed": 30, "damage": 10, "reward": 20 } }
```

- `spawn`: `spawns`辞書（stage直下）のキー名を参照
- `enemy`: 省略可。省略時は`spawn`と同じオブジェクト直下にhp/speed等をフラットに書いても動く（`_buildEnemyDef(def.enemy ?? def)`）
- 開幕時に護衛範囲円ゲート付きで一括スポーンされる（`_engageGate = true`）

## triggers（盤外侵入）

```json
{
  "type": "progress",
  "atWpIdx": 6,
  "spawn": "R8",
  "count": 2,
  "interval": 1200,
  "enemy": { "type": "salaryman", "hp": 200, "speed": 30, "damage": 10, "reward": 20, "leashTo": { "col": 14, "row": 9 } }
}
```

| キー | 必須/任意 | 内容 |
|---|---|---|
| `type` | 必須 | 現状`"progress"`のみ実装済み（護衛のwpIdxが`atWpIdx`以上になった時点で発火） |
| `atWpIdx` | 必須（type:"progress"時） | 発火する護衛waypointインデックス |
| `spawn` | 必須 | `spawns`辞書のキー名 |
| `count` | 任意（既定1） | **enemyの外、triggerの直下**。同時に何体出すか |
| `interval` | 任意（既定0） | **enemyの外、triggerの直下**。count>1時の発生間隔(ms) |
| `enemy` | 必須 | 下記参照 |

## enemy定義（initial/triggers共通）

| キー | 必須/任意 | 内容 |
|---|---|---|
| `type` | 必須 | `salaryman`/`worker`/`police`/`kickboard`/`burger`/`bird`/`debu` |
| `hp` / `speed` / `damage` / `reward` | 任意 | 省略時は`ZOMBIE_BASE`（`balance.json`）の値 |
| `leashTo` | 任意 | `{col,row}`。到達後、護衛が近づくまで待機 |
| `circleAt` | 任意（鳥専用） | `{col,row}` 旋回中心 |
| `circleRadius` | 任意（鳥専用） | px、既定150（見た目の円サイズ） |
| `circleDurationMs` | 任意（鳥専用） | ms、既定6000（旋回してからホーミングへ移行するまでの時間） |
| `circleLoops` | 任意（鳥専用） | 既定2.5（circleDurationMs内に何周するか。半径とは独立） |

`circleRadius`/`circleDurationMs`のどちらかを0にすると旋回スキップで侵入直後に即ホーミングになる。

## spawns（stage直下）

```json
"spawns": {
  "R3": { "col": 21, "row": 3 },
  "L8": { "col": -2, "row": 8 }
}
```

名前付きスポーン地点の辞書。盤外座標（負のcol/rowや`grid.cols`/`grid.rows`以上）を指定すると、盤外スポーン（歩き込み侵入）として扱われる。`initial`/`triggers`の`spawn`キーがここのキー名を参照する。

## A/B導線（lanes）との関係

`lanes`フィールド（editor.htmlが出力する`{A:[...], B:[...]}`）は**エディター専用メタデータで、ゲームエンジンは一切読まない**。`lane:"A"`のような参照キーは存在しない。各escortは`lanes.A`または`lanes.B`の内容を**そのまま自分の`path`に実体コピー**する必要がある。

## 実例

完全な動作例は`stages/stage_本番テスト（読める盤面）.json`（dad/mom 2護衛、区間4つ、initial/triggers/leashTo全部入り）を参照。

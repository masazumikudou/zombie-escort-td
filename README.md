# Zombie Escort TD — グレーボックスビルド

## 概要
ファミリーを1人ずつ順番に護衛しながら右端まで連れて行くタワーディフェンス。
グレーボックス（単色図形）でコアループを検証しつつ、
**素材ファイルを置くだけでコード変更ゼロで本素材に切り替わる**仕組み済み。

---

## アセット差し替え手順（コード変更不要）

### ゾンビスプライト
```
assets/sprites/zombie/{type}/walk_{dir}_{frame:02d}.png
  type  : normal | normal_helmet | normal_cap | alt | alt_helmet | alt_cap
  dir   : down | up | left | right
  frame : 01, 02, 03, 04, 05, 06
```
例: `assets/sprites/zombie/normal/walk_down_01.png`

typeは stageデータの `escorts[].waves[].enemy.type` と一致させること。

### 護衛スプライト
```
assets/sprites/escort/{variant}/walk_{dir}_{frame:02d}.png
  variant : dad | mom | grandma
  dir     : down | up | left | right
  frame   : 01, 02, 03, 04, 05, 06
```
例: `assets/sprites/escort/dad/walk_right_01.png`

### タワースプライト（1枚画像）
```
assets/sprites/tower/{type}.png
  type : basic | rapid | sniper
```

### 遮蔽物スプライト
```
assets/sprites/obstacle/building.png
```

### 音声ファイル
```
assets/audio/shoot.wav      … タワー発射音
assets/audio/hit.wav        … ゾンビ被弾音
assets/audio/escort_hit.wav … 護衛被ダメージ音
assets/audio/groan.wav      … ゾンビ呻き声
assets/audio/coin.wav       … タワー設置/売却音
assets/audio/clear.wav      … ステージクリア音
assets/audio/gameover.wav   … ゲームオーバー音
```

**ファイルが存在しない場合は自動的に単色図形 / Web Audio 合成にフォールバックする。**

---

## ディレクトリ構成

```
zombie-escort-td/
├── index.html          # ゲーム本体
├── editor.html         # マップエディタ（Phaser不使用）
├── stages/
│   └── stage_01.json   # ステージデータ（escorts配列形式）
├── assets/
│   ├── sprites/        # ← スプライット配置ポイント（上記規約通り）
│   └── audio/          # ← 音声配置ポイント（上記規約通り）
└── js/
    ├── config.js       # 定数・スプライット規約定数・ユーティリティ
    ├── pathfinder.js   # A* 経路探索（4方向・遮蔽物のみブロック）
    ├── audio.js        # 音声（ファイル優先 → Web Audio 合成フォールバック）
    ├── Escort.js       # 護衛（スプライット優先 → 青丸フォールバック）
    ├── Zombie.js       # ゾンビ（スプライット優先 → 緑丸フォールバック）
    ├── Tower.js        # タワー（スプライット優先 → 色付き四角フォールバック）
    ├── WaveManager.js  # ウェーブ管理・スポーン制御
    ├── BootScene.js    # ステージJSON読み込み + スプライット試し読み込み
    ├── GameScene.js    # メインゲームシーン（全システム統合）
    └── main.js         # Phaser初期化
```

---

## システム仕様

### ファミリーリレーシステム
1. 護衛者は `escorts` 配列の順番に1人ずつ出発
2. 護衛者がゴール到達 or 脱落したら **約4秒のインターバル**（タワー設置・売却可能、時間は流れ続ける）
3. インターバル中は「{名前}、出発！」バナーを表示
4. 残存ゾンビは消えず持ち越し。次の護衛者出発後に自動でターゲットを切り替える
5. 全員消化後：`生還数 >= minSurvivors` → クリア、未満 → ゲームオーバー

#### 脱落演出
- HP0 になった護衛者は「脱落」状態に移行（グレーボックス：灰色点滅）
- 脱落から2秒後に消える。ゾンビは脱落者を無視して次のターゲットへ移行

#### リザルト画面
- 星評価（生還者数ぶんの ★）
- 生還数 / 総数 + 撃破数

### ステージJSON スキーマ（escorts 形式）
```json
{
  "id": "stage_01",
  "startMoney": 500,
  "minSurvivors": 1,
  "escorts": [
    {
      "variant": "dad",
      "start": { "col": 0, "row": 7 },
      "goal":  { "col": 19, "row": 7 },
      "hp": 100,
      "speed": 80,
      "waves": [
        { "startDelay": 6000, "spawnInterval": 2500, "count": 4,
          "enemy": { "type": "normal", "hp": 30, "speed": 55, "damage": 10, "reward": 20 } }
      ]
    }
  ],
  "obstacles": [...],
  "zombieSpawns": [...],
  "buildSpots": [...]
}
```

> **後方互換**：`buildSpots` が空の場合は全通行可能セルに設置可能。

### タワー設置 UI（タップ → ポップアップ方式）
1. 空き**設置点（黄丸マーカー）をタップ** → タワー選択メニューがその場にポップアップ
2. タイプをタップ → 即建設・メニュー閉じる（所持金不足はグレーアウトで選択不可）
3. メニュー外をタップ / `Escape` キー → キャンセル
4. **既存タワーをタップ** → 売却メニューをポップアップ

### 設置点（buildSpots）
- ステージJSONの `buildSpots` 配列で指定したセルにのみタワーを設置可能
- `buildSpots` が空の場合は制限なし（後方互換）
- 空き設置点は常時**黄色の小円マーカー**で表示
- アクティブな設置点（メニュー表示中）はマーカーが**パルスアニメーションで強調**
- タワー設置済みのセルはマーカー非表示

### 経路探索
- **A* 4方向**（斜め移動なし）
- ブロック対象：`obstacles` 配列のセルのみ
- **タワーは通過可能**（パスをブロックしない）

### カメラ
- ドラッグでパン、ホイール / ピンチでズーム（0.5〜2.0倍）
- ピンチ終了時に最も近い `ZOOM_LEVELS` にスナップ
- `⌂ 護衛` ボタンで現在の護衛者へカメラ復帰
- ポップアップ表示中は自動復帰タイマーを停止
- 無操作 3秒後に自動復帰
- キーボード `H` で即時復帰

### タイムコントロール
- HUD右端のタイム表示をクリック or スペースキーでサイクル
- ⏸ 停止 → 🐢 スロー(0.25x) → ▶ 通常(1.0x)

### キーボードショートカット
| キー | 機能 |
|------|------|
| Space | タイムモード切替 |
| H | 護衛へカメラ復帰 |
| G | グリッド表示 ON/OFF |
| P | デバッグパス表示 |
| D | デバッグパネル開閉 |
| Escape | ポップアップメニューを閉じる |

---

## ロードマップ
- [x] Phase 1: グレーボックスでコアループ検証
- [x] Phase 2: 設置点システム・タップポップアップUI・ファミリーリレー
- [ ] Phase 3: ゾンビ移動見た目改善（8方向化 or パス平滑化）、一斉再計算スパイク対策
- [ ] Phase 4: waypoints による寄り道システム（強制寄り道の予兆演出含む）
- [ ] Phase 5: 実スプライト・音声差し替え（ファイル配置のみ・コード変更不要）
  - 起動時の試し読み込み（170+ リクエスト発生）を `manifest.json` 列挙方式に変更予定
- [ ] Phase 6: お母さんバリアント追加（`ESCORT_VARIANTS` に mom 追加、JSON 更新のみ）
- [ ] Phase 7: ステージ追加・バランス調整

---

## デプロイ（Netlify）
1. GitHubにプッシュ
2. Netlifyで `zombie-escort-td` リポジトリを接続
3. Publish directory: `.`（ビルドコマンド不要）

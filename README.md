# Zombie Escort TD — グレーボックスビルド

## 概要
1人の護衛（お父さん）を安全に右端まで護衛するタワーディフェンス。
グレーボックス（単色図形）でコアループを検証しつつ、
**素材ファイルを置くだけでコード変更ゼロで本素材に切り替わる**仕組み済み。

---

## アセット差し替え手順（コード変更不要）

### ゾンビスプライト
```
assets/sprites/zombie/{type}/walk_{dir}_{frame:02d}.png
  type  : normal | normal_helmet | normal_cap | alt | alt_helmet | alt_cap
  dir   : down | up | left | right
  frame : 01, 02, 03, 04
```
例: `assets/sprites/zombie/normal/walk_down_01.png`

typeは stageデータの `waves[].enemy.type` と一致させること。

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
assets/audio/shoot.wav     … タワー発射音
assets/audio/hit.wav       … ゾンビ被弾音
assets/audio/escort_hit.wav … 護衛被ダメージ音
assets/audio/groan.wav     … ゾンビ呻き声
assets/audio/coin.wav      … タワー設置/売却音
assets/audio/clear.wav     … ステージクリア音
assets/audio/gameover.wav  … ゲームオーバー音
```

**ファイルが存在しない場合は自動的に単色図形 / Web Audio 合成にフォールバックする。**

---

## ディレクトリ構成

```
zombie-escort-td/
├── index.html          # ゲーム本体
├── editor.html         # マップエディタ（Phaser不使用）
├── stages/
│   └── stage_01.json   # ステージデータ
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

### 設置点（buildSpots）
- ステージJSONの `buildSpots` 配列で指定したセルにのみタワーを設置可能
- `buildSpots` が空の場合は制限なし（後方互換）
- 空き設置点は常時**黄色の小円マーカー**で表示
- タワータイプ選択中はマーカーが**パルスアニメーションで強調**（どこに置けるか誘導）
- タワー設置済みのセルはマーカー非表示

### 経路探索
- **A* 4方向**（斜め移動なし）
- ブロック対象：`obstacles` 配列のセルのみ
- **タワーは通過可能**（パスをブロックしない）

### ゾンビ経路再計算
- 500ms ごと、または護衛が新セルに移動したとき再計算
- 護衛の現在セルをゴールとして A* を実行
- **Phase 2 予定改善**：一斉再計算スパイク対策（分散・近距離直線追尾）

### waypoints 拡張について
- Escort.js はウェイポイント配列をそのまま受け取る構造のため **変更不要**
- stageJSON に `escort.waypoints: [{col, row}, ...]` を追加 + GameScene.js の
  パス構築 10 行を修正するだけで寄り道経路に対応可能（Phase 3 予定）

### カメラ
- ドラッグでパン、ホイール / ピンチでズーム（0.5〜2.0倍）
- `⌂ 護衛` ボタンで護衛へカメラ復帰
- 無操作 3秒後に自動復帰
- キーボード `H` で即時復帰

### タイムコントロール
- HUD右上のタイム表示をクリック or スペースキーでサイクル
- ⏸ 停止 → 🐢 スロー(0.25x) → ▶ 通常(1.0x)

### キーボードショートカット
| キー | 機能 |
|------|------|
| Space | タイムモード切替 |
| H | 護衛へカメラ復帰 |
| G | グリッド表示 ON/OFF |
| P | デバッグパス表示 |
| D | デバッグパネル開閉 |
| Escape | タワー選択解除 |

---

## ロードマップ
- [x] Phase 1: グレーボックスでコアループ検証
- [ ] Phase 2: ゾンビ移動の見た目改善（8方向化 or パス平滑化）、一斉再計算スパイク対策
- [ ] Phase 3: waypoints による寄り道システム（強制寄り道の予兆演出含む）
- [ ] Phase 4: 実スプライト・音声差し替え（ファイル配置のみ・コード変更不要）
  - 起動時の試し読み込み（170+ リクエスト発生）を `manifest.json` 列挙方式に変更予定
- [ ] Phase 5: ファミリーリレー（お母さん → おばあちゃん追加）
- [ ] Phase 6: ステージ追加・バランス調整

---

## デプロイ（Netlify）
1. GitHubにプッシュ
2. Netlifyで `zombie-escort-td` リポジトリを接続
3. Publish directory: `.`（ビルドコマンド不要）

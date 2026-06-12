# Zombie Escort TD — グレーボックスビルド

## 概要
家族を1人ずつ順番に護衛しながら右端まで連れて行くタワーディフェンス。
グレーボックス（単色図形）でコアループを検証しつつ、
**素材ファイルを置くだけでコード変更ゼロで本素材に切り替わる**仕組み済み。

確定設計仕様書は [`docs/`](docs/) フォルダを参照。

---

## アセット差し替え手順（コード変更不要）

### ゾンビスプライト
```
assets/sprites/zombie/{type}/walk_{dir}_{frame:02d}.png
  type  : normal | normal_helmet | normal_cap | alt | alt_helmet | alt_cap
  dir   : down | up | left | right
  frame : 01 〜 06
```

### 護衛スプライト
```
assets/sprites/escort/{variant}/walk_{dir}_{frame:02d}.png
  variant : dad | mom | grandma
  dir     : down | up | left | right
  frame   : 01 〜 06
```

### タワースプライト
```
assets/sprites/tower/{type}_base.png  ← 土台（将来用、現在は {type}.png）
assets/sprites/tower/{type}.png       ← グレーボックスフォールバック用
  type : basic | rapid | sniper
```

### 音声ファイル
```
assets/audio/shoot.wav / hit.wav / escort_hit.wav / groan.wav
assets/audio/coin.wav / clear.wav / gameover.wav
```

**ファイルが存在しない場合は自動的に単色図形 / Web Audio 合成にフォールバック。**

---

## バランス調整
**[`balance.json`](balance.json) のみを編集する。コードに数値を書かない。**

```
balance.json
├── sellRate          … 売却還元率（初期 0.70）
├── towers.*          … タワーごとの cost / range / fireRate / damage / durability
├── zombies.*         … ゾンビ種ごとの hp / speed / damage / reward / flags
├── economy           … 初期資金デフォルト・星ボーナスジェム数
└── items             … 看板コスト等
```

---

## ディレクトリ構成

```
zombie-escort-td/
├── index.html
├── editor.html         # マップエディタ
├── CLAUDE.md           # AI作業ガイドライン
├── balance.json        # 全ゲーム数値の一元管理
├── stages/
│   └── stage_01.json   # ステージデータ（escorts配列形式）
├── docs/               # 確定設計仕様書
│   ├── spec01_detour.md
│   ├── spec02_roster.md
│   ├── spec03_economy_towers.md
│   └── spec04_enemies.md
├── assets/
│   ├── sprites/
│   └── audio/
└── js/
    ├── config.js       # 定数・applyBalance()
    ├── pathfinder.js
    ├── audio.js
    ├── Escort.js
    ├── Zombie.js
    ├── Tower.js
    ├── WaveManager.js
    ├── BootScene.js    # balance.json + stageData ロード
    ├── GameScene.js
    └── main.js
```

---

## システム仕様

### ファミリーリレーシステム（実装済み）
1. 護衛者は `escorts` 配列の順番に1人ずつ出発
2. 護衛者がゴール到達 or 脱落したら **約4秒のインターバル**（タワー操作可、時間継続）
3. インターバル中は「{名前}、出発！」バナー表示
4. 残存ゾンビは持ち越し。次の護衛者出発後に自動でターゲット切替
5. 全員消化後：`生還数 >= minSurvivors` → クリア
6. 即敗北：`現生還数 ＋ 未出発人数 < minSurvivors` の瞬間に敗北
7. リザルト：星評価（★/☆）＋生還数/撃破数

### ステージ JSON スキーマ（escorts 形式）
```json
{
  "startMoney": 500,
  "minSurvivors": 1,
  "escorts": [
    {
      "variant": "dad",
      "startTrigger": "afterPrevious",
      "start": { "col": 0, "row": 7 },
      "goal":  { "col": 19, "row": 7 },
      "hp": 100, "speed": 80,
      "waves": [ ... ]
    }
  ],
  "obstacles": [...],
  "zombieSpawns": [...],
  "buildSpots": [...]
}
```

### タワー設置 UI（タップ → ポップアップ）
- 空き設置点（黄丸マーカー）をタップ → タワー種選択メニュー
- 既存タワーをタップ → 売却メニュー
- Escape / メニュー外タップ → キャンセル

### カメラ
- ドラッグでパン、ホイール/ピンチでズーム（0.5〜2.0倍）
- ピンチ終了時に最も近い `ZOOM_LEVELS` にスナップ
- ポップアップ表示中は自動帰還タイマーを停止
- 無操作 3秒後に護衛者へ自動帰還

### キーボードショートカット
| キー | 機能 |
|------|------|
| Space | タイムモード切替 |
| H | 護衛へカメラ復帰 |
| G | グリッド表示 ON/OFF |
| P | デバッグパス表示 |
| D | デバッグパネル開閉 |
| Escape | ポップアップを閉じる |

---

## ロードマップ
- [x] Phase 1: グレーボックスでコアループ検証
- [x] Phase 2: 設置点システム・タップポップアップUI
- [x] Phase 3: ファミリーリレーシステム（escorts配列・即敗北判定・星評価）
- [x] Phase 4: balance.json 数値一元管理・布石フィールド
- [ ] Phase 5: 寄り道・誘導システム（仕様書01）
  - 強制寄り道・lureable寄り道・タイムセール看板・滞在ラッシュ
- [ ] Phase 6: タワーリテーマ＋新タワー（仕様書03）
  - テニスボールマシン・ゴムパチンコ・BBQグリル・ぐるぐるバット（初期4種）
  - スプリンクラー・漫画ラック（ジェム解放）
- [ ] Phase 7: 特殊ゾンビ第1陣（仕様書04）
  - おでぶゾンビ（タンク）・電動キックボードゾンビ（俊足）
- [ ] Phase 8: ロースター拡張（仕様書02）
  - 母・息子・猫バリアント追加（ESCORT_VARIANTS と スプライト）
- [ ] Phase 9: 特殊ゾンビ第2〜4陣・ボス（仕様書04）

---

## デプロイ（Netlify）
1. GitHubにプッシュ
2. Netlifyで `zombie-escort-td` リポジトリを接続
3. Publish directory: `.`（ビルドコマンド不要）

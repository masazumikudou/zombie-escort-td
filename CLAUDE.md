# CLAUDE.md — Zombie Escort TD

## プロジェクト概要
家族を1人ずつ順番に護衛するタワーディフェンス。Phaser.js（CDN）のみ使用、ビルドなし。

## 設計仕様書
`docs/` フォルダに確定設計図があります。設計に関わる作業の前に**必ず該当仕様書を読むこと**。

| ファイル | 内容 |
|---|---|
| [docs/spec01_detour.md](docs/spec01_detour.md) | 寄り道・誘導システム（強制寄り道・看板誘導・滞在ラッシュ） |
| [docs/spec02_roster.md](docs/spec02_roster.md) | 家族リレー・ロースター（5名・startTrigger・即敗北判定） |
| [docs/spec03_economy_towers.md](docs/spec03_economy_towers.md) | 経済設計・タワー6種・balance.json設計 |
| [docs/spec04_enemies.md](docs/spec04_enemies.md) | 特殊ゾンビ・敵ロードマップ（第1〜4陣） |

## 数値調整ルール
**`balance.json` のみを編集すること。コードに数値を書かない。**
- タワー価格・攻撃力・射程・売却率
- ゾンビ基準値（HP/速度/ダメージ/報酬）
- 経済定数（初期資金・星ボーナス）

## 実装順のルール
**READMEのロードマップに従い、先のフェーズを勝手に実装しない。**

実装順：
1. リレーシステム（完了）
2. 寄り道システム（仕様書01）
3. タワーリテーマ＋新タワー（仕様書03）
4. 特殊ゾンビ第1陣（仕様書04）
5. 以降は仕様書のロードマップ順

## マップ・バランスの変更禁止
マップ構造（obstacles・buildSpots・escorts配置）およびバランス数値の変更は、
**指示なしに行わないこと。**

# ファイル構成レビュー結果 v1.0（2026-07-17）

**この文書の役割**: 19日以降の軽量モデル＋CC体制に向けた、コードベース構造の俯瞰と改修計画。CCへの実装発注時に「どこに何を書くべきか」の判断根拠として参照する。行数調査（2026-07-17時点）に基づく。

**総評**: アーキテクチャは健康。クラス1ファイル原則（Zombie/Escort/Tower/FlowField/pathfinder）が守られており、_archiveによる旧ステージ隔離の習慣もある。危険は3箇所（GameScene肥大・シム2系統重複・遺物コード）に集中しており、いずれも対処タイミングが明確。

---

## 実行タイミング一覧（この順に着手）

| タイミング | 作業 | 対象 | 状態 |
|---|---|---|---|
| 今すぐ（1-4.5と並行可・害ゼロ） | R-2: WaveManager生死確認 | WaveManager.js | ✅ 完了（2026-07-17。js/_legacy/へ移動＋index.htmlのscriptタグ削除＋GameScene.jsのwaves分岐除去まで実施） |
| 今すぐ（1-4.5と並行可・害ゼロ） | R-5: 小物掃除 | preview_mom.html他 | ✅ 完了（2026-07-17。preview_mom.html・Sprite Lab (standalone) (3).htmlをtools/へ移動。stage_y_tutorial.jsonの_archive移動のみ1-4着手時に保留） |
| 1-4.5 GO判定後・1-7前 | R-1: GameScene分割 | GameScene.js | 未着手 |
| 1-4.5クローズ後 | R-3: シム共通コア統合 | simulator.html / run_sim.js | 未着手 |
| P4着手時（発注文に都度記載） | R-4: 新規ファイル配置ルール適用 | 新規実装全般 | 未着手 |
| **1-4.5クローズ後に着手可・P3開始前必須** | **R-6: ステージJSON検証スクリプト新設** | `validate_stage.js`（新規） | 未着手・**量産の門番** |

---

## R-1: GameScene.js の分割【GO判定後・1-7前】

**現状**: 1361行。区間遷移・retreat呼び出し・CLOSE_CALL集計・売却/アップグレードUI・デカール描画・カメラ制御の吸着点になっている。

**問題**: P4（リザルト連携）・P5（ヒットストップ等ゲームフィール）の実装が全てここに乗る予定で、放置すると2000行超は確実。軽量モデル体制での改修事故率が上がる。

**方針**: 2塊を切り出す（合計300〜400行の削減見込み）:
1. **戦闘ログ/集計系** → `js/PlayLogger.js`（新規）: PLAY LOG出力・CLOSE_CALL判定/集計・RESULT行生成
2. **建設UI系** → `js/BuildMenu.js`（新規）: _openSellMenu・_upgradeTower・建設フロー

**禁止事項**: 1-4.5の検証中は分割に着手しない（構造変更とバグ切り分けが混ざるため）。GO判定が出て、1-7の全部載せ検証に入る前の窓で実施する。分割後は既存3ステージ（meander_verified / segment_test / behavior_test）のシム基準値との完全一致を回帰基準とする。

## R-2: WaveManager.js の生死確認【今すぐ・害ゼロ】✅ 完了

**現状（実施前）**: 136行。SpawnEventManager（時間駆動）とSegmentManager（新文法）が現行世代であり、WaveManagerはさらに前の世代の遺物である可能性が高かった。

**調査結果**: `index.html`の`<script src>`と`GameScene.js`の3段フォールバック（segments→spawnEvents→waves）に配線は現存していたが、`waves`形式を使うステージは`stages/_archive/stage_02.json`のみで、実働4ステージ（`stages/index.json`）はどれも通らない「配線は生きているがデータが来ない」状態だった。

**判断（小松）**: v2.1で1-7が新文法（segments）ベース確定・脅威の文法が2種（initial待機＋盤外侵入）に確定済みのため、waves形式が復活する可能性はゼロ。「配線は生きてるがデータが来ない」状態こそ誤参照事故の典型的な火種（軽量モデルが3段フォールバックを見て新ステージをwaves形式で書いてくるリスク）と判断し、移動を実施。

**実施内容（2026-07-17）**:
- `js/WaveManager.js` → `js/_legacy/WaveManager.js`（削除はせずgit mvで退避）
- `index.html`から`<script src="js/WaveManager.js">`を削除
- `GameScene.js`の`_startEscort`のフォールバックをsegments→spawnEventsの2段に整理し、waves分岐とWaveManager呼び出しを完全除去

**回帰確認**: 実働3ステージ（meander_verified/segment_test/behavior_test）のシム基準値と完全一致を確認済み。

## R-3: シム共通コアの統合【1-4.5クローズ後】

**現状**: simulator.html（613行）とrun_sim.js（262行）に、SimTower・スタブ・実行ループ・RESULT生成が別実装で存在。simStub.js（31行）という共通化の芽はある。

**実績**: 片側修正事故が既に2回発生（Phaserスタブ漏れによるブラウザクラッシュ／vm束縛バグ）。リスク登記簿7番の実体。

**方針**: `js/SimCore.js`（新規）に実行ループ・RESULT行生成・スタブ・SimTowerを統合し、simulator.htmlとrun_sim.jsは「入出力のガワ」だけにする。統合後の回帰基準はR-1と同じく既存3ステージのシム基準値完全一致。

**タイミング**: 1-4.5クローズ後、1-7前が理想（1-7の全部載せ検証を統合済みシムで回せば、統合の正しさと1-7検証が同時に担保される）。

## R-4: P4/P5実装の配置ルール【発注文に都度記載】

**原則**: 「新規シーンは新規ファイル、マネージャは1責務1ファイル。GameSceneには足さない」

| タスク | 配置先 | 備考 |
|---|---|---|
| セーブ（4-1） | `js/SaveManager.js` 新規 | localStorage読み書きの唯一の窓口にする |
| ステージ選択（4-2） | `js/StageSelectScene.js` 拡張 | 既存84行を土台に |
| ショップ（4-3） | `js/ShopScene.js` 新規 | |
| リザルト（4-5） | `js/ResultScene.js` 新規 | 採点思想はspec05_game_identity.md参照 |
| BGM（5-1） | `js/bgm.js` 新規 | audio.js（69行・SE専用）には触らない。ループ/フェードは別責務 |
| ゲームフィール（5-4） | 要検討 | ヒットストップ等はGameScene改修が不可避。R-1分割後の痩せた状態で乗せる |

## R-5: 小物掃除【今すぐ・害ゼロ】✅ 完了

- ~~preview_mom.html（379行）・Sprite Lab (standalone) (3).html（163行）→ tools/ へ移動~~ ✅ 完了（2026-07-17）
- ~~Sprite Lab (standalone) (3).html はファイル名に(3)が付いておりコピー残骸の疑い~~ → 調査済み: リポジトリ内に(1)/(2)や無番号版は存在せず単独ファイルだった（統合対象なし）
- `stages/stage_y_tutorial.json`（149行）→ 旧Y実装（setSpawnMultiplier方式）前提のため、Y再設計（1-4）着手時に `stages/_archive/` へ **【保留中・未実施】**

## R-6: ステージJSON検証スクリプト新設【1-4.5クローズ後着手可・P3開始前必須】

**発端（2026-07-18）**: 本番segment_test再設計（stage_behavior_test.json）で、buildSpots 42箇所中11箇所（26%）がpropフットプリントと衝突しているのを機械チェックで発見。ステージ本体の`_comment_buildspots`には「prop占有セルは除外」と明記されていたにもかかわらず素通りしていた。さらに調査の過程で、**シム（run_sim.js/simulator.html）・実機（GameScene.js）のどちらにもタワー配置時の`pf.isWalkable()`衝突チェックが実装されていない**ことが判明（buildSpots定義ステージでは`_canPlace`がbuildSpotsの記載を最優先し、walkable判定自体をスキップする設計のため）。`spec05_stage_design.md`の「シムが衝突の最終ゲートキーパー」という記述は現状のコードと食い違っている。

**問題の性質**: この日踏んだ地雷（buildSpots×propフットプリント衝突・initial書式の黙殺・leash間に合わない問題・spawn座標の歩行不能セル）はどれも同じパターン——**JSONの書き損じがエラーなく素通りし、実行結果から逆算しないと発覚しない**。P3で20本量産する際、この検証をシム実行前に機械化する価値は極めて高い。

**方針**: `node validate_stage.js <stageFile>` の単体スクリプト（新規・実装規模100行前後）として、以下をシム実行前に静的チェックする:

1. buildSpots vs propフットプリント衝突（今回発見した件）
2. buildSpots vs 道路セル(ground_cells)衝突（旧`(5,8)`の件と同種。**本ステージにも未修正の`(13,2)`・`(16,8)`が残存確認済み**）
3. initial/triggersの`spawn`キーが`spawns`に未定義の場合、黙殺せず即エラー
4. スポーン座標・leashTo座標の歩行可能性（`ground_cells`定義時のroad-only判定と整合）
5. トリガーの時間整合性——発火時点の護衛位置から敵の到達時刻を逆算し、護衛がすでに通過済み（間に合わない）なら警告。計算式は小松から提供予定

**優先度**: P3量産の門番（量産開始前に必須）。着手タイミングは1-4.5クローズ後でよい（今は検証の手を止めない）。

---

## 参考: 現状の健康な部分（変更不要）

- クラス1ファイル原則: Zombie(428)/Escort(405)/Tower(368)/FlowField(61)/pathfinder(60)
- stages/_archive/ による旧ステージ隔離の運用
- balance.json（46行）による数値の一元管理
- scripts/build.js（31行）のシンプルなsync構成

## 更新ルール

この文書はR-1〜R-5の実施時に該当項目へ完了日を追記する。構成に関わる新しい決定（ファイル新設・分割・統合）が発生した場合はここに追記し、工程表からは参照のみとする。

**セッション引き継ぎ**: この文書は工程表の「セッション引き継ぎ（5点セット）」の1つ。新しいセッション・CCインスタンスは、工程表の「現在地」を読んだ際に本文書の実行タイミング一覧と照合し、条件が満たされたタスク（1-4.5 GO判定・1-4.5クローズ・P4着手など）がないか必ず確認すること。

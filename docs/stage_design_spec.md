# ゾンビエスコートTD ステージ設計仕様書

**最終更新**: 2026-07-02（初版ドラフト）
**基準会話**: このドキュメントは小松さん・Claude・CCの壁打ちで確定した内容をまとめたもの。

## 0. このドキュメントについて

- **目的**: 新しいステージJSONを作る際、このドキュメントのA章だけ読めば事故らず作れる状態にする
- **構成**: A(確定事実) / B(未確認・要注意) / C(未実装の設計方針・ロードマップ) を厳密に分離している
- **重要な原則**: A章はコード引用で確認済みの事実のみ。C章は「こうしたい」という設計思想であり、現在のエンジンの挙動ではない。この2つを混同すると、読んだ人（未来のClaudeインスタンス含む）が「実装済み」と誤読する事故が起きる

---

## A. エンジン確定事実（CC確認済み）

### A-1. 座標・サイズ

- **CELL = 100px**（`config.js:2`）※旧メモに「64px」とあるのは廃止済み仕様。今後は100px基準で統一
- **grid（cols/rows）は完全自由**。`GameScene.js`でJSONの値を直接`COLS/ROWS`に代入しているだけで、推奨値（例: 25×8）は目安に過ぎず制約ではない
- 護衛の移動時間の計算式：
  ```
  距離(px) = (pathの区間数) × 100
  到達時間(ms) = 距離(px) ÷ speed(px/秒) × 1000
  ```

### A-2. escorts / path

- `path`は隣接セルを1マスずつ移動するウェイポイント配列。**対角移動不可**
- `goal`は必ず`path`の最後の要素と同じ座標にすること（一致しないと護衛がゴールしない）
- `start`は`path`の最初の要素と一致させる

### A-3. startTrigger（複数護衛のリレー）

- **`startTrigger: "afterPrevious"`は現状未実装。JSONに書いても無視される**
- 実際の挙動：**前の護衛がゴール到達 or 死亡した瞬間から固定4秒（`RELAY_INTERVAL = 4000ms`）後に次の護衛が自動スタート**。タップでスキップ可能
- ⚠️ 「前の護衛の生死によって次のリリース条件が変わる」といった設計は**現状不可能**。複数護衛ステージの難易度設計はこの制約を前提にすること

### A-4. waves（最重要・計算ミスが起きやすい箇所）

各waveのフィールド：

| フィールド | 説明 |
|---|---|
| `startDelay` | wave開始からの待機時間(ms) |
| `duration` | このwaveの継続時間（**秒**単位、必須。省略厳禁） |
| `spawnInterval` | グループ間の間隔(ms) |
| `groupSize` | 1グループの人数。**省略時デフォルト1**（`wave.groupSize ?? 1`） |
| `groupInterval` | グループ内の個体間隔(ms) |
| `enemy` | `{type, hp, speed, damage, reward}` |

**やってはいけないこと**：
- `count`フィールドは使わない → 実際のスポーン数を制御しない。durationの自動計算にのみ影響し、`groupSize`未指定だと1体ずつのグループになってしまう
- `duration`の省略 → 後半グループが出ない、または（wave内で）護衛到達まで無制限スポーンし続ける不安定な状態になる

**時間軸の計算式（★最重要・計算ミスが起きやすい箇所）**

1. **`spawnInterval`の起点**：「あるグループの全個体スポーン完了 → 次グループ開始」の間隔（グループ開始〜開始ではない）。`WaveManager.js`で確認済み

2. **`duration`と`startDelay`は直列**（同じ基準点からの並行カウントではない）：
   ```
   wave開始（前waveの終了 or ステージ開始）
     → startDelay 待機
     → elapsed = 0 スタート
     → duration 秒後、このwaveは終了
   ```
   ⚠️ **重要**: wave[1]以降のstartDelayは「そのwave内の最初のグループ出現を遅らせる」だけであり、
   waveの終了タイミング（elapsed基準のdurationカウント）には影響しない。
   startDelay が duration に近い値だと、wave内でほとんどゾンビが出ない可能性がある。

3. **wave内、numGroups（グループ数）を指定するフィールドは存在しない**。設計者が「何グループ出したいか」を決めたら、以下の式で必要な`duration`を逆算する：
   ```
   最終個体スポーン完了時刻（elapsed=0基準, ms）
     = (groupSize-1)×groupInterval
       + (numGroups-1)×(spawnInterval + (groupSize-1)×groupInterval)

   duration(秒) ≧ 上記の値 ÷ 1000　（小さめのバッファを持たせる）
   ```
   ⚠️ **wave[1]以降は startDelay_n を加算してから ÷1000 すること**：
   ```
   duration_n(秒) ≧ (startDelay_n + 上記の値) ÷ 1000
   ```
   wave[0]のみ startDelay が elapsed=0基準に含まれるため加算不要。wave[1]以降は startDelay が
   波の窓内の最初の発火遅延として消費されるため、duration に含めて計算する必要がある。

   duration が大きすぎると意図しない追加グループが湧くリスクがあるため、次グループの想定開始時刻より小さい値に収めること

4. **wave全体の絶対終了時刻（wave indexが切り替わる時刻）**：
   ```
   ゲーム開始を t=0 として、

   wave[0] が終了する絶対時刻 = startDelay₀ + duration₀×1000
   wave[1] が終了する絶対時刻 = startDelay₀ + (duration₀ + duration₁)×1000
   wave[n] が終了する絶対時刻 = startDelay₀ + Σduration[0..n]×1000
   ```
   ※startDelay は wave[0] のものだけが累積に含まれる。wave[1]以降の startDelay は
   あくまで「そのwave内で最初のグループが出るまでの待機」であり、wave終了タイミングには加算されない。

5. **護衛到達前に全waveが湧き終わるかの検算は必須**：
   ```
   startDelay₀ + Σduration[全wave]×1000 < 護衛到達時間(ms)
   ```
   これを満たさないと、後半の敵（特に最終waveの終盤）が出現しないまま切り捨てられる

6. **現状の難易度設計方針（Plan A）**：wave内の敵は全員同じ強さ。escalation（強くなる）はwave間の敵種切り替えでのみ行う。wave内で敵を強くする設計（Plan B）は現状シミュレーターなしでは危険（C-3参照）

### A-5. zombieSpawns

- グループ発火のたびに**「護衛から最も近いspawn地点」がFlowField距離（壁・プロップを考慮した実歩行距離）で自動選択**される（ランダムでも順番でもない）
- 1グループの敵は全員同じ1箇所から連続して湧く
- **制約**：ゴール地点・path上のセルに置かない

### A-6. buildSpots

- **必須**。空配列だとタワーを1基も設置できずゲームとして成立しない
- path・props(footprint)のセルと重複しないこと

### A-7. props（当たり判定あり・footprint注意）

- **propsは自動的に`obstacles`と同等の当たり判定を持つ**。`obstacles`配列への二重登録は不要
- タワー設置時も同様にブロックされる
- **footprint**：JSON上は左上1座標のみ指定。実際のブロック範囲は`PROP_DEFS`の`cols × rows`分、全セルが自動的に塞がれる

  | type | cols×rows |
  |---|---|
  | shop | 4×4 |
  | shop_front / shop_back / house_front / house_back / 家青 / 家緑 / アイスクリーム / ハンバーガー | 3×3 |
  | guardrail_h / guardrail_v / tree / 木1 / 木2 / ベンチ | 1×1 |
  | 公園 | 6×6 |
  | 駐車場 / 駐車場車有り | 4×2 |
  | スーパーマーケット | 6×3 |
  | 商店街 / house5_front / house5_back | 15×3 |

  ※新しいtypeが追加された場合は都度CCに`PROP_DEFS`の値を確認すること

- **⚠️既知の事故パターン**：**props配置に対するバリデーション（衝突警告）は一切ない**。path上やbuildSpots上にpropsのfootprintが被っても無警告でそのまま動く → 護衛が経路上でブロックされてフリーズ、buildSpotsが使用不可になる等のバグが発生する。**propsを置く際は必ずpath全座標・buildSpots全座標とのfootprint衝突を手動（または計算で）確認すること**

### A-8. ground_cells

- 道路などのテクスチャ指定のみ。**当たり判定には一切影響しない**（見た目だけ）

### A-9. minSurvivors / クリア・敗北判定

- 全護衛の移動が終了した時点で、`survivors（ゴール到達数） >= minSurvivors` ならクリア
- **即敗北判定あり**：道中で「残っている護衛が今後全員ゴールしても`minSurvivors`に届かない」と判明した瞬間、即座に敗北になる（ゲームが最後まで進行しない）

---

## B. 未確認事項（要CC確認・判明するまで注意して運用）

- **`decals`の当たり判定**：pixel座標(x, y)で指定する装飾レイヤー。`ground_cells`と同様に見た目だけと推測されるが、**CCに明示的な確認は取れていない**。大量に配置する前に確認推奨
- **★スコア・HP%記録の実装有無**：C-1の評価式はあくまで設計方針であり、実際にゲーム側でHP%や生存数を記録・スコア化する仕組みが存在するかは未確認

---

## C. 未実装の設計方針（ロードマップ・現在の実装ではない）

### C-1. ★スコア式（ドラフト、未実装）

- 複数護衛ステージ：`(生存者数÷全体人数)×10点 + (生存者の平均HP%)×10点`（0〜20点）
- 単独護衛ステージ（チュートリアル想定）：残HP%のみで判定
  - 70%以上 → ★3 / 30〜70% → ★2 / 30%未満(生存)〜ギリギリクリア → ★1

### C-2. 難易度カーブ目標（ドラフト）

| ステージ帯 | ★3到達率の目標 | 狙い |
|---|---|---|
| 1〜5 | 80〜90% | 成功体験優先 |
| 6〜10 | 50〜60% | 適度な歯応え |
| 11〜15 | 25〜35% | 上級者向け |
| 16〜20 | 10%以下 | ガチ勢向け・周回要素 |

### C-3. wave内escalation（Plan B、保留中）

- 現状（Plan A）：wave内は均一、wave間でのみ強くなる。切り捨てが起きても「数が減る」だけで質的崩壊は起きない
- Plan B（wave内で敵を差し替えて強くする）へ移行する場合、「締めの強敵だけ丸ごと消える」事故が致命的になるため、**移行前に切り捨て検出シミュレーターの実装が必須条件**

### C-4. プレイテストのバイアス問題

- 現在のテストプレイは小松さん本人（TDジャンル熟練者）のみで行われている。効率配置を即座に見抜けるため、**このテスト結果は「上級者にとっての難易度」であり、初心者の難易度感とは乖離しうる**
- 対策候補：意図的な非効率配置でのテスト、外部プレイテスターの活用、Claudeによる「初心者ならどう置くか」の予測シミュレーション

---

## D. 作業フロー

### D-1. 推奨フロー（今日確立した型）

1. **小松さんが道路込みで街を整形**（`ground_cells` + `props`）。道路レイアウトがそのまま護衛の経路の骨格になる
2. Claudeに渡す
3. Claudeが道路レイアウトから`path`座標を書き出す
4. Claudeが`zombieSpawns`・`buildSpots`をpath/props全footprintとの衝突チェック込みで計算
5. Claudeが護衛到達時間を逆算し、A-4の式に従ってwave設計（数値の逆算・検算）
6. 小松さんがプレイテストしてHP%・被弾数などをフィードバック
7. 必要に応じて数値だけ再調整（街の形は基本触らない）

※逆に「Claudeが先にpath/buildSpots/spawnを決めて、後から街を当てはめる」フローは、街のためのスペース計画が存在しないため窮屈になりやすい（stage_01で実証済みの失敗パターン）

### D-2. 役割分担

| 役割 | 担当 |
|---|---|
| エンジンの実際の挙動（コード事実） | CC |
| 数値検証（時間逆算・衝突チェック・構造的副作用の指摘） | Claude |
| 街のデザイン・「面白いかどうか」の最終判断 | 小松さん |
| プレイテスト・体感フィードバック | 小松さん |

- Claudeは「このprops配置だとspawnがここに偏る」等の構造的指摘はできるが、「それが面白いかどうか」は判断できない領域として明確に線引きする
- 街の形の維持そのものが目的ではなく、**ゲームの面白さが最優先**。props配置について「外した方が良くなる」等の提案は双方向で行ってよい（最終判断は小松さん）

### D-3. 新規ステージ作成チェックリスト

- [ ] grid・道路・props配置（街）を先に確定
- [ ] pathを道路レイアウトから書き出し、goal=path[-1]を確認
- [ ] 護衛到達時間を計算（pathの区間数 × 100px ÷ speed）
- [ ] zombieSpawnsをpath/props footprintと衝突チェックして配置
- [ ] buildSpotsをpath/props footprintと衝突チェックして配置（空配列にしない）
- [ ] wave設計：A-4の式で全wave終了時刻を積み上げ計算し、護衛到達時間を超えないか検算
- [ ] `count`ではなく`groupSize`+`duration`で明示的に書く
- [ ] 複数護衛の場合、`afterPrevious`は無視される前提（実際は死亡/到達+4秒固定）で設計
- [ ] プレイテスト（可能なら熟練者以外の視点も意識）してHP%・被弾数を記録

---

## E. 既知の落とし穴（今日発生した実例ログ）

1. **セルサイズの旧仕様混在**：メモリ上「CELL=64px」が残っていたが実際は100px。数値計算前に必ずconfig.jsの現在値を疑うこと
2. **`count`フィールドの罠**：wave定義に`count`があっても実スポーン数を制御しない。`groupSize`なしだと1体ずつの弱いグループになる、またはduration次第で無制限スポーンになる
3. **`spawnInterval`の意味誤読**：グループ開始〜開始の間隔だと誤解しやすいが、正しくは「前グループの湧き終わり→次グループ開始」
4. **`duration`と`startDelay`の関係誤読**：同じ基準点から並行カウントだと誤解しやすいが、正しくは直列（startDelay消化後にelapsed=0）。さらにwave[1]以降のstartDelayはwave終了タイミングに影響しない点に注意
5. **grid10×8で街が窮屈になった事例**：チュートリアルステージでも街としての説得力を求めるなら15×10クラスが実質的なミニマムサイズだった（stage_01の反省）
6. **propsの無警告衝突リスク**：footprintの概念を知らずに配置すると、経路ブロック等の重大バグが無警告で発生する
7. **path区間数の数え間違い**：長いpath（40区間超）を目視でフェーズごとに数えると1区間分ズレやすい（43区間と数えたが実際は44区間だった例あり）。護衛到達時間がズレるとwave設計全体の検算が狂うため、区間数は`path.length - 1`で機械的に数えること（目視カウントに頼らない）

---

## F. 実例（動作確認済み・プレイテスト合格）

以下は2026-07-02にプレイテストで確認済みのステージ（護衛1人、15×10グリッド）。  
**結果**: 生還1/1、撃破23、被弾ゼロ、タワー3基で余裕クリア。  
A-4の計算式を実際の数値に当てはめた例として、新しいステージを作る前にこのJSONで自己検算すること。

### 検算の手順（この実例で辿ってみる）

1. **護衛到達時間の計算**
   - path区間数: 44区間（`path.length - 1`で機械的に算出。目視の43区間は誤り）
   - 距離 = 44 × 100px = 4400px
   - 到達時間 = 4400 ÷ 80 × 1000 = **55000ms**

2. **wave0の検算**（groupSize=1のため、group-formula = (numGroups-1) × spawnInterval）
   - group-formula = (4-1) × 2500 = 7500ms
   - duration₀ ≧ 7500 ÷ 1000 = 7.5秒 → **8秒**に設定（バッファ500ms）
   - wave0終了(絶対) = startDelay₀ + duration₀×1000 = 6000 + 8000 = **14000ms**

3. **wave1の検算**（wave[1]以降はstartDelay_nも加算してからdurationを逆算）
   - group-formula = (7-1) × 2000 = 12000ms
   - duration₁ ≧ (startDelay₁ + group-formula) ÷ 1000 = (4000+12000) ÷ 1000 = 16秒 → **17秒**に設定（バッファ1000ms）
   - wave1終了(絶対) = startDelay₀ + (duration₀+duration₁)×1000 = 6000 + 25000 = **31000ms**

4. **wave2の検算**
   - group-formula = (12-1) × 1500 = 16500ms
   - duration₂ ≧ (4000+16500) ÷ 1000 = 20.5秒 → **21秒**に設定（バッファ500ms）
   - wave2終了(絶対) = startDelay₀ + (duration₀+duration₁+duration₂)×1000 = 6000 + 46000 = **52000ms**

5. **最終検算**：wave2終了(52000ms) < 護衛到達(55000ms) → **3秒のバッファで全23体スポーン保証**（実際のプレイ結果「撃破23」と一致）

### この実例から読み取れること

- タワー3基で撃破23・ノーダメだったのは、**弱すぎるwave設計ではなく、経路交差点での効率配置が強力に機能したため**（C-4のバイアス問題と合わせて解釈すること）
- `count`を使った元の非公式版と、`groupSize`+`duration`で組み直したこの版は、意図する敵数（4/7/12体）は同一。違うのは「確実に全部湧き切る」保証があるかどうか

```json
{
  "id": "stage_custom",
  "name": "カスタムステージ",
  "grid": { "cols": 15, "rows": 10 },
  "ground_base": "grass",
  "startMoney": 500,
  "minSurvivors": 1,
  "escorts": [
    {
      "variant": "dad",
      "startTrigger": "immediate",
      "start": { "col": 0, "row": 5 },
      "goal": { "col": 14, "row": 7 },
      "path": [
        { "col": 0, "row": 5 }, { "col": 1, "row": 5 }, { "col": 2, "row": 5 }, { "col": 3, "row": 5 },
        { "col": 3, "row": 4 }, { "col": 3, "row": 3 }, { "col": 3, "row": 2 }, { "col": 3, "row": 1 },
        { "col": 3, "row": 0 }, { "col": 4, "row": 0 }, { "col": 5, "row": 0 }, { "col": 6, "row": 0 },
        { "col": 7, "row": 0 }, { "col": 7, "row": 1 }, { "col": 7, "row": 2 }, { "col": 7, "row": 3 },
        { "col": 7, "row": 4 }, { "col": 7, "row": 5 }, { "col": 7, "row": 6 }, { "col": 7, "row": 7 },
        { "col": 7, "row": 8 }, { "col": 7, "row": 9 }, { "col": 8, "row": 9 }, { "col": 9, "row": 9 },
        { "col": 10, "row": 9 }, { "col": 11, "row": 9 }, { "col": 11, "row": 8 }, { "col": 11, "row": 7 },
        { "col": 11, "row": 6 }, { "col": 11, "row": 5 }, { "col": 11, "row": 4 }, { "col": 11, "row": 3 },
        { "col": 11, "row": 2 }, { "col": 11, "row": 1 }, { "col": 11, "row": 0 }, { "col": 12, "row": 0 },
        { "col": 13, "row": 0 }, { "col": 14, "row": 0 }, { "col": 14, "row": 1 }, { "col": 14, "row": 2 },
        { "col": 14, "row": 3 }, { "col": 14, "row": 4 }, { "col": 14, "row": 5 }, { "col": 14, "row": 6 },
        { "col": 14, "row": 7 }
      ],
      "hp": 100,
      "speed": 80,
      "waves": [
        {
          "startDelay": 6000,
          "duration": 8,
          "spawnInterval": 2500,
          "groupSize": 1,
          "groupInterval": 0,
          "enemy": { "type": "normal", "hp": 30, "speed": 55, "damage": 10, "reward": 20 }
        },
        {
          "startDelay": 4000,
          "duration": 17,
          "spawnInterval": 2000,
          "groupSize": 1,
          "groupInterval": 0,
          "enemy": { "type": "normal_cap", "hp": 45, "speed": 62, "damage": 13, "reward": 25 }
        },
        {
          "startDelay": 4000,
          "duration": 21,
          "spawnInterval": 1500,
          "groupSize": 1,
          "groupInterval": 0,
          "enemy": { "type": "normal_helmet", "hp": 60, "speed": 70, "damage": 18, "reward": 30 }
        }
      ]
    }
  ],
  "obstacles": [],
  "zombieSpawns": [
    { "col": 0, "row": 0 }, { "col": 9, "row": 0 }, { "col": 5, "row": 9 }, { "col": 14, "row": 9 }
  ],
  "buildSpots": [
    { "col": 1, "row": 0 }, { "col": 2, "row": 0 }, { "col": 0, "row": 1 }, { "col": 1, "row": 1 },
    { "col": 2, "row": 1 }, { "col": 4, "row": 1 }, { "col": 5, "row": 1 }, { "col": 6, "row": 1 },
    { "col": 8, "row": 0 }, { "col": 10, "row": 0 }, { "col": 8, "row": 1 }, { "col": 10, "row": 1 },
    { "col": 12, "row": 1 }, { "col": 13, "row": 1 }, { "col": 3, "row": 6 }, { "col": 3, "row": 7 },
    { "col": 3, "row": 8 }, { "col": 12, "row": 2 }, { "col": 13, "row": 4 }, { "col": 12, "row": 6 },
    { "col": 13, "row": 7 }
  ],
  "ground_cells": [
    { "col": 3, "row": 0, "type": "道路横" }, { "col": 4, "row": 0, "type": "道路横" },
    { "col": 5, "row": 0, "type": "道路横" }, { "col": 6, "row": 0, "type": "道路横" },
    { "col": 7, "row": 0, "type": "road_vertical" }, { "col": 11, "row": 0, "type": "road_vertical" },
    { "col": 12, "row": 0, "type": "道路横" }, { "col": 13, "row": 0, "type": "道路横" },
    { "col": 14, "row": 0, "type": "road_vertical" }, { "col": 3, "row": 1, "type": "road_vertical" },
    { "col": 7, "row": 1, "type": "road_vertical" }, { "col": 11, "row": 1, "type": "road_vertical" },
    { "col": 14, "row": 1, "type": "road_vertical" }, { "col": 3, "row": 2, "type": "road_vertical" },
    { "col": 7, "row": 2, "type": "road_vertical" }, { "col": 11, "row": 2, "type": "road_vertical" },
    { "col": 14, "row": 2, "type": "road_vertical" }, { "col": 3, "row": 3, "type": "road_vertical" },
    { "col": 7, "row": 3, "type": "road_vertical" }, { "col": 11, "row": 3, "type": "road_vertical" },
    { "col": 14, "row": 3, "type": "road_vertical" }, { "col": 3, "row": 4, "type": "road_vertical" },
    { "col": 7, "row": 4, "type": "road_vertical" }, { "col": 11, "row": 4, "type": "road_vertical" },
    { "col": 14, "row": 4, "type": "road_vertical" }, { "col": 0, "row": 5, "type": "道路横" },
    { "col": 1, "row": 5, "type": "道路横" }, { "col": 2, "row": 5, "type": "道路横" },
    { "col": 3, "row": 5, "type": "道路横" }, { "col": 4, "row": 5, "type": "道路横" },
    { "col": 5, "row": 5, "type": "道路横" }, { "col": 6, "row": 5, "type": "道路横" },
    { "col": 7, "row": 5, "type": "道路横" }, { "col": 8, "row": 5, "type": "道路横" },
    { "col": 9, "row": 5, "type": "道路横" }, { "col": 10, "row": 5, "type": "道路横" },
    { "col": 11, "row": 5, "type": "道路横" }, { "col": 12, "row": 5, "type": "道路横" },
    { "col": 13, "row": 5, "type": "道路横" }, { "col": 14, "row": 5, "type": "道路横" },
    { "col": 3, "row": 6, "type": "road_vertical" }, { "col": 7, "row": 6, "type": "road_vertical" },
    { "col": 11, "row": 6, "type": "road_vertical" }, { "col": 14, "row": 6, "type": "road_vertical" },
    { "col": 3, "row": 7, "type": "road_vertical" }, { "col": 7, "row": 7, "type": "road_vertical" },
    { "col": 11, "row": 7, "type": "road_vertical" }, { "col": 14, "row": 7, "type": "road_vertical" },
    { "col": 3, "row": 8, "type": "road_vertical" }, { "col": 7, "row": 8, "type": "road_vertical" },
    { "col": 11, "row": 8, "type": "road_vertical" }, { "col": 14, "row": 8, "type": "road_vertical" },
    { "col": 0, "row": 9, "type": "道路横" }, { "col": 1, "row": 9, "type": "道路横" },
    { "col": 2, "row": 9, "type": "道路横" }, { "col": 3, "row": 9, "type": "道路横" },
    { "col": 4, "row": 9, "type": "道路横" }, { "col": 5, "row": 9, "type": "道路横" },
    { "col": 6, "row": 9, "type": "道路横" }, { "col": 7, "row": 9, "type": "道路横" },
    { "col": 8, "row": 9, "type": "道路横" }, { "col": 9, "row": 9, "type": "道路横" },
    { "col": 10, "row": 9, "type": "道路横" }, { "col": 11, "row": 9, "type": "道路横" },
    { "col": 12, "row": 9, "type": "道路横" }, { "col": 13, "row": 9, "type": "道路横" },
    { "col": 14, "row": 9, "type": "道路横" }
  ],
  "props": [
    { "type": "家青", "col": 4, "row": 2 },
    { "type": "家緑", "col": 0, "row": 2 },
    { "type": "家青", "col": 8, "row": 2 },
    { "type": "アイスクリーム", "col": 8, "row": 6 },
    { "type": "ハンバーガー", "col": 4, "row": 6 },
    { "type": "shop_front", "col": 0, "row": 6 }
  ],
  "decals": [
    { "type": "木2", "x": 21, "y": 21 }, { "type": "木2", "x": 17, "y": 58 },
    { "type": "木2", "x": 52, "y": 60 }, { "type": "木2", "x": 64, "y": 11 },
    { "type": "木2", "x": 93, "y": 10 }, { "type": "木2", "x": 101, "y": 52 },
    { "type": "木2", "x": 98, "y": 95 }, { "type": "木2", "x": 53, "y": 89 },
    { "type": "木2", "x": 23, "y": 91 }, { "type": "木2", "x": 183, "y": 59 },
    { "type": "木2", "x": 213, "y": 61 }, { "type": "木2", "x": 253, "y": 62 },
    { "type": "木2", "x": 261, "y": 94 }, { "type": "木2", "x": 227, "y": 95 },
    { "type": "木2", "x": 185, "y": 94 }, { "type": "木2", "x": 346, "y": 68 },
    { "type": "木2", "x": 423, "y": 97 }, { "type": "木2", "x": 386, "y": 83 },
    { "type": "木2", "x": 411, "y": 47 }, { "type": "木2", "x": 364, "y": 13 },
    { "type": "木2", "x": 379, "y": 43 }, { "type": "木2", "x": 498, "y": 70 },
    { "type": "木2", "x": 538, "y": 62 }, { "type": "木2", "x": 511, "y": 104 },
    { "type": "木2", "x": 538, "y": 111 }, { "type": "木2", "x": 498, "y": 154 },
    { "type": "木2", "x": 533, "y": 153 }, { "type": "木2", "x": 501, "y": 268 },
    { "type": "木2", "x": 533, "y": 270 }, { "type": "木2", "x": 533, "y": 303 },
    { "type": "木2", "x": 508, "y": 307 }, { "type": "木2", "x": 503, "y": 338 },
    { "type": "木2", "x": 538, "y": 343 }
  ]
}
```

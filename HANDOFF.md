# 引き継ぎメモ — 2026-06-17

## このファイルを読んでいるClaudeへ

このファイルは別PCのClaudeへの申し送りです。プッシュ前に必ず読んでください。

---

## 状況：2つのPCに未マージの変更がある

### 別PC（会社PC）
- **未プッシュのコミットが1つ**あります
- 内容は不明ですが、origin/masterには届いていません

### このPC（自宅PC）
- 本日の作業をコミット済み（下記参照）
- origin/masterにプッシュ済み

---

## 本日の作業内容（自宅PC）

### 1. editor.html のバグ修正
- `hRoadCells` / `vRoadCells` として宣言されていた変数が、コード全体では `hRoads` / `vRoads` として参照されており未定義エラーになっていた
- → 宣言を `hRoads` / `vRoads` に統一し、道路編集ロジックも修正
- これがエディターが「グリーン一面で何も動かない」状態になっていた原因

### 2. 住宅街プロップの追加（house5_front / house5_back）
- 生成AI画像から住宅街（5棟横並び）を表・裏で2枚作成
- Node.js の `sharp` ライブラリでリサイズ（960×192、fit:fill）
- `fit: contain` にすると右側に透明余白が生じ、プロップ配置がブロックされる問題があったため `fit: fill` を採用
- PROP_DEFS に追加：`house5_front: { cols: 15, rows: 3 }` / `house5_back: { cols: 15, rows: 3 }`

### 3. tree デカールの追加
- 縦に並べた住宅街の隙間を樹木で隠す作戦のため、tree をデカールレイヤーに追加
- `assets/sprites/prop/tree.png` → `assets/sprites/decal/tree.png` にコピー
- DECAL_DEFS に `tree: { cols: 1, rows: 1 }` を追加
- デカールはプロップより下レイヤーに描画されるため、家の手前に重なる心配なし

---

## プッシュ手順（別PCで行うこと）

```
git pull origin master   # 自宅PCの変更を取得
git push origin master   # 別PCの未プッシュコミットを送る
```

コンフリクトが発生した場合は内容を確認してから解決してください。
editor.html が競合する可能性が最も高いです。

---

## 現在のプロップ・デカール定義（editor.html）

### PROP_DEFS
| キー | cols | rows | 備考 |
|---|---|---|---|
| shop | 4 | 4 | |
| shop_front | 3 | 3 | |
| shop_back | 3 | 3 | |
| house5_front | 15 | 3 | 本日追加・住宅街5棟（表） |
| house5_back | 15 | 3 | 本日追加・住宅街5棟（裏） |
| house_front | 3 | 3 | |
| house_back | 3 | 3 | |
| guardrail_h | 1 | 1 | |
| guardrail_v | 1 | 1 | |
| tree | 1 | 1 | |
| house | 3 | 3 | |
| hospital | 4 | 3 | |
| police | 3 | 3 | |

### DECAL_DEFS
| キー | cols | rows | 備考 |
|---|---|---|---|
| crosswalk_h | 2 | 1 | |
| crosswalk_v | 1 | 2 | |
| manhole | 1 | 1 | |
| tree | 1 | 1 | 本日追加 |

---

## 未解決・続きの作業
- 住宅街の縦並び隙間に tree デカールを配置する作業（エディター操作）は未実施
- house5_back の見た目確認は未実施

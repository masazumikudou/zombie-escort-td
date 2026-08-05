const RELAY_INTERVAL    = 4000;  // インターバル時間（ms）
const VARIANT_NAMES     = { dad: 'お父さん', mom: 'お母さん', grandma: 'おばあちゃん', son: '息子', cat: '猫' };

class GameScene extends Phaser.Scene {
  constructor() { super('GameScene'); }

  // ─── 初期化 ───────────────────────────────────────────────
  init({ stageData, sessionTowerText }) {
    this.stageData        = stageData;
    this.sessionTowerText = sessionTowerText ?? '';
  }

  create() {
    const sd = this.stageData;

    // グリッドサイズをJSONから上書き
    if (sd.grid) {
      COLS  = sd.grid.cols;
      ROWS  = sd.grid.rows;
      MAP_W = CELL * COLS;
      MAP_H = CELL * ROWS;
    }

    // ゲーム状態
    this.scaledTime   = 0;
    this.timeModeIdx  = 2;
    this.zoomIdx      = DEFAULT_ZOOM_IDX;
    this.money        = sd.startMoney ?? 0;
    this.totalEarned  = 0;  // ステージ通算の撃破報酬累計（資金表示の内訳用。建設で減らない）
    this.gameState    = 'playing';
    this.killCount       = 0;
    this.spawnCount      = 0;
    this._playLog        = [];
    if (sd.startMoney === undefined) {
      this._playLog.push(`[WARN] stage.startMoneyが未定義のため0として扱います（escort側のstartMoneyに全額寄せる設計なら意図通り。書き忘れの可能性もあるため確認推奨）`);
    }
    this._closecallCount = 0;
    this._closestEver    = Infinity;
    this._yHitCount      = 0;             // Y中の一撃離脱ゾンビ数（CLOSE_CALL・すり抜けとは別集計）
    this._damageBySpawn     = new Map();  // "col,row" → {totalDmg,hits,byType} 護衛被弾のスポーン地点別集計（2-7機能B）
    this._allSpawnedZombies = [];         // すり抜け集計(LEAK_BY_SPAWN)用に全スポーン個体を保持
    this._closeCallBySpawn  = new Map();  // "col,row" → {count,closest} CLOSE_CALLのスポーン地点別集計
    this._yHitBySpawn       = new Map();  // "col,row" → count（Y中の一撃離脱）
    this._escortHpRecords   = [];         // [{variant,hp,maxHp}] 護衛ごとのHP残（交代時にスナップショット・2026-07-29追加）
    this.debugOpen    = false;
    this.showGrid     = false;
    this.showPaths    = false;
    this.showRoute    = false;

    // ポップアップ状態
    this.popupState      = null;
    this.popupObjects    = [];
    this._popupJustActed = 0;  // 0=非活性。非0ならその時刻(this.time.now基準)まで直後のゴーストタップを無視する
    this._popupOpenSince  = undefined;  // popupStateが立ってから経過した実時間の起点（固着検出用・2026-08-05）
    this._popupStuckWarned = false;

    // リレー状態
    this.escortDefs    = sd.escorts;
    this.escortIdx     = 0;
    this.survivors     = 0;
    this.relayPhase    = 'active';  // 'active' | 'interval' | 'done'
    this.intervalTimer = 0;
    this._bannerText   = null;
    this._bannerBg     = null;

    // Y（寄り道防衛）状態
    this._yInflow     = null;   // YInflowManager（Y中のみ生成）

    // 設置点
    this.buildSpots = new Set((sd.buildSpots || []).map(s => `${s.col},${s.row}`));

    // 経路探索（props の占有セルも obstacles と同等にブロック）
    this.pf = new Pathfinder(sd.grid.cols, sd.grid.rows, sd.obstacles);
    this._propBlocked = new Map(); // "col,row" → "type@(col,row)" ラベル（run_sim.js/simulator.htmlと同一形式）
    for (const prop of (sd.props || [])) {
      const def = PROP_DEFS[prop.type];
      if (!def) continue;
      for (let dc = 0; dc < def.cols; dc++) {
        for (let dr = 0; dr < def.rows; dr++) {
          const key = `${prop.col + dc},${prop.row + dr}`;
          this.pf.blocked.add(key);
          this._propBlocked.set(key, `${prop.type}@(${prop.col},${prop.row})`);
        }
      }
    }

    // road-only: ground_cells 以外のセルをすべてブロック（ゾンビは道路上のみ移動）
    // ブロック型タイル(blockW/blockH・道縦ノーマル(2)等)は原点セルのみ記録されているため、
    // 幅・高さ分を展開してから歩行可能判定に使う（描画側は元々展開済み・判定側だけ漏れていた）
    if (sd.ground_cells && sd.ground_cells.length > 0) {
      const roadSet = new Set();
      for (const cell of sd.ground_cells) {
        const bdef = GROUND_BLOCK_DEFS[cell.type];
        const bw = bdef ? (bdef.blockW ?? bdef.blockCells ?? 1) : 1;
        const bh = bdef ? (bdef.blockH ?? bdef.blockCells ?? 1) : 1;
        for (let dc = 0; dc < bw; dc++) {
          for (let dr = 0; dr < bh; dr++) {
            roadSet.add(`${cell.col + dc},${cell.row + dr}`);
          }
        }
      }
      for (let c = 0; c < COLS; c++) {
        for (let r = 0; r < ROWS; r++) {
          if (!roadSet.has(`${c},${r}`)) {
            this.pf.blocked.add(`${c},${r}`);
          }
        }
      }
    }

    // 外周1マスを自動ブロック（128pxスプライトのはみ出し防止）
    // スポーン・護衛の全経路セルとその隣接セルは例外として通行可にする
    const _perimEx = new Set();
    const _spawnCoords = sd.zombieSpawns?.length ? sd.zombieSpawns : (sd.spawns ? Object.values(sd.spawns) : []);
    for (const sp of _spawnCoords) {
      _perimEx.add(`${sp.col},${sp.row}`);
    }
    for (const esc of (sd.escorts || [])) {
      if (esc.path && esc.path.length > 0) {
        esc.path.forEach(p => _perimEx.add(`${p.col},${p.row}`));
      } else {
        const escPath = this.pf.find(esc.start.col, esc.start.row, esc.goal.col, esc.goal.row);
        if (escPath) escPath.forEach(cell => _perimEx.add(`${cell.col},${cell.row}`));
      }
      _perimEx.add(`${esc.start.col},${esc.start.row}`);
      _perimEx.add(`${esc.goal.col},${esc.goal.row}`);
    }
    for (const key of [..._perimEx]) {
      const [ec, er] = key.split(',').map(Number);
      for (const [dc, dr] of [[0,1],[0,-1],[1,0],[-1,0]]) {
        _perimEx.add(`${ec + dc},${er + dr}`);
      }
    }
    for (let c = 0; c < COLS; c++) {
      for (let r = 0; r < ROWS; r++) {
        if ((c === 0 || c === COLS - 1 || r === 0 || r === ROWS - 1) && !_perimEx.has(`${c},${r}`)) {
          this.pf.blocked.add(`${c},${r}`);
        }
      }
    }

    // フローフィールド（全ゾンビ共有の距離マップ）
    this.flowField = new FlowField(this.pf);

    // エンティティ
    this.zombies = [];
    this.towers  = [];
    this.bullets = [];

    // 音声シーン注入
    audioSynth.setScene(this);

    // グラフィクスレイヤー
    this.pathGfx      = this.add.graphics().setDepth(0.5);
    this.mapGfx       = this.add.graphics().setDepth(1);
    this.dynGfx       = this.add.graphics().setDepth(3);
    this.indicatorGfx = this.add.graphics().setScrollFactor(0).setDepth(11);

    // アンダーレイ（depth -3：128pxスプライトのはみ出し吸収用）
    this._drawUnderlayLayer();

    // 地面レイヤー（depth -2）
    this._drawGroundLayer();

    // 道路レイヤー（depth -1）
    this._drawRoadLayer();

    // デカールレイヤー（depth 0：歩ける装飾、当たり判定なし）
    this._drawDecalLayer();

    // 静的マップ描画（mapGfx depth 1）
    this._drawMapStatic();

    // プロップ描画（depth 2：マップ上・キャラ下）
    this._drawProps();

    // カメラ設定（UISceneのヘッダー分だけビューポートを下にオフセット）
    const HEADER_H = 8 + UI_H; // UIScene の SAFE(8) + UI_H と同値
    this._headerH = HEADER_H;
    this.cameras.main.setViewport(0, HEADER_H, this.scale.width, this.scale.height - HEADER_H - UI_H);
    this.cameras.main.setBounds(0, 0, MAP_W, MAP_H + HEADER_H + UI_H);
    this.cameras.main.setZoom(ZOOM_LEVELS[this.zoomIdx]);

    // UISceneのリサイズに合わせてカメラビューポートを追従
    this._onUiResize = ({ w, h }) => {
      this.cameras.main.setViewport(0, this._headerH, w, h - this._headerH - UI_H);
    };
    this.game.events.on('ui_resize', this._onUiResize);

    // UIScene 起動（HUD専用シーン、メインカメラ非依存）
    if (!this.scene.isActive('UIScene')) {
      this.scene.launch('UIScene');
    }
    this._onUiCycleTime      = () => this._cycleTimeMode();
    this._onUiReturnToEscort = () => this._returnToEscort();
    this._onUiToggleRoute    = () => { this.showRoute = !this.showRoute; this._drawEscortRoute(); };
    // _tryPlace()内でも_closePopup()を呼ぶが、_canPlace失敗など閉じ損ねる経路があるため、
    // ここでの保険の呼び出しは削除しない（2026-08-04に一度削除したが判断ミスだったため復帰・2026-08-05）
    this._onUiBuildPlace     = ({ col, row, type }) => { this._popupJustActed = this.time.now + 300; this._tryPlace(col, row, type); this._closePopup(); };
    this._onUiLaserDir       = ({ col, row, dir }) => {
      const t = this.towers.find(t => t.col === col && t.row === row);
      if (t) t.direction = dir;
      this._closePopup();  // popupState('dirPicker')を閉じる。input.enabledはupdate()で毎フレーム同期される
    };
    // 建設ポップアップ外（UISceneの暗幕）タップで閉じるためのコールバック（2026-08-04追加）
    this._onUiClosePopup     = () => this._closePopup();
    this.game.events.on('ui_cycleTime',      this._onUiCycleTime);
    this.game.events.on('ui_returnToEscort', this._onUiReturnToEscort);
    this.game.events.on('ui_toggleRoute',    this._onUiToggleRoute);
    this.game.events.on('ui_buildPlace',     this._onUiBuildPlace);
    this.game.events.on('ui_laserDir',       this._onUiLaserDir);
    this.game.events.on('ui_closePopup',     this._onUiClosePopup);
    this.events.once('shutdown', () => {
      this.game.events.off('ui_cycleTime',      this._onUiCycleTime);
      this.game.events.off('ui_returnToEscort', this._onUiReturnToEscort);
      this.game.events.off('ui_toggleRoute',    this._onUiToggleRoute);
      this.game.events.off('ui_buildPlace',     this._onUiBuildPlace);
      this.game.events.off('ui_laserDir',       this._onUiLaserDir);
      this.game.events.off('ui_resize',         this._onUiResize);
      this.game.events.off('ui_closePopup',     this._onUiClosePopup);
    });

    // UI構築
    this._buildUI();

    // 入力設定
    this._setupInput();

    // 初期配置タワー（JSON指定・コスト無消費・チェックバイパス）
    this._placeInitialTowers();

    // 最初の護衛者をスタート
    this._startEscort(0, 0);
  }

  // ─── リレー：護衛者起動 ───────────────────────────────────
  _startEscort(idx, timeOffset) {
    if (this.escort) this.escort.cleanup();

    const _baseDef = this.escortDefs[idx];
    const _vStats  = ESCORT_DEFS[_baseDef.variant] ?? ESCORT_DEFS.dad;
    const def      = { hp: _vStats.hp, speed: _vStats.speed, ..._baseDef };

    // escort別初期マネー（合算方式）: stage.startMoneyへの加算。1人目起動時・リレー交代時いずれも同じ扱い
    if (def.startMoney) {
      this.money += def.startMoney;
      this._playLog.push(`[START_MONEY] t=${Math.round(this.scaledTime)}ms escortIdx=${idx} variant=${def.variant} +${def.startMoney}  money=${this.money}`);
    }

    let   escPath;
    if (def.path && def.path.length > 0) {
      escPath = def.path.map(p => cellCenter(p.col, p.row));
    } else {
      const escCells = this.pf.find(def.start.col, def.start.row, def.goal.col, def.goal.row);
      escPath = escCells ? this.pf.toPixelPath(escCells) : [];
    }
    this.escort = new Escort(this, escPath, def);

    // Yシステムコールバック接続
    const _NAMES = { dad:'お父さん', mom:'お母さん', son:'息子', grandma:'おばあちゃん', cat:'猫' };
    const variantName = _NAMES[def.variant] ?? def.variant;
    this.escort.onDetourStart    = () => {
      this._playLog.push(`[DETOUR_START]    t=${Math.round(this.scaledTime)}ms variant=${variantName} → announcing`);
      this._showDetourCard(variantName);
    };
    this.escort.onDetourActivate = () => {
      const walletAmount = def.detour?.walletAmount ?? 0;
      if (walletAmount > 0) {
        this.money += walletAmount;
        this._playLog.push(`[WALLET] t=${Math.round(this.scaledTime)}ms 着席取得 +${walletAmount}  money=${this.money}`);
      }
      this._yInflow = new YInflowManager(this.stageData.spawns ?? {}, def.detour?.yInflow ?? []);
      this._yInflow.start(this.scaledTime);
      this._playLog.push(`[DETOUR_ACTIVATE] t=${Math.round(this.scaledTime)}ms waitTime=${def.detour?.waitTime ?? 30000}ms`);
    };
    this.escort.onDetourEnd      = () => {
      this._yInflow?.retreatAll();
      this._yInflow = null;
      this._playLog.push(`[DETOUR_END]      t=${Math.round(this.scaledTime)}ms`);
      this._closeDetourCard();
    };

    const cam = this.cameras.main;
    cam.pan(escPath[0]?.x ?? MAP_W / 2, escPath[0]?.y ?? MAP_H / 2, 600, 'Power2');

    // スポーンマネージャー（segments方式 > spawnEvents方式。旧waves方式(WaveManager)はjs/_legacy/へ退避済み）
    if (def.segments) {
      // 区間制・位置トリガー方式（新文法）
      this.waveManager = new SegmentManager(this.stageData.spawns ?? {}, def.segments);
      this.waveLabel = '';
    } else {
      this.waveManager = new SpawnEventManager(
        this.stageData.spawns ?? {},
        def.spawnEvents ?? this.stageData.spawnEvents ?? []
      );
      this.waveManager.start(timeOffset);
      this.waveLabel = '';
    }
    this._updateRelayHUD();
    this.relayPhase = 'active';
  }

  // 護衛ごとのHP残スナップショット（run_sim.js/simulator.htmlと同一設計）
  _recordEscortHp() {
    this._escortHpRecords.push({ variant: this.escort.variant, hp: this.escort.hp, maxHp: this.escort.maxHp });
  }

  // ─── リレー：護衛者終了処理 ───────────────────────────────
  _onEscortDone(reached) {
    this._recordEscortHp();
    if (reached) {
      this.survivors++;
      this._playLog.push(`[REACH]  t=${Math.round(this.scaledTime)}ms  護衛ゴール到達  生存護衛=${this.survivors}`);
    }

    const nextIdx   = this.escortIdx + 1;
    const remaining = this.escortDefs.length - nextIdx;
    const minS      = this.stageData.minSurvivors ?? 1;

    // 即敗北：現生還数 + 未出発人数 < minSurvivors
    if (this.survivors + remaining < minS) {
      this.relayPhase = 'done';
      this._endGame();
      return;
    }

    if (nextIdx >= this.escortDefs.length) {
      this.relayPhase = 'done';
      this._endGame();
      return;
    }

    // インターバル開始 + NEXT WAVE 画面表示
    this.relayPhase    = 'interval';
    this.intervalTimer = RELAY_INTERVAL;
    const nextName = VARIANT_NAMES[this.escortDefs[nextIdx].variant] ?? this.escortDefs[nextIdx].variant;
    this._playLog.push(`[RELAY_INTERVAL]  t=${Math.round(this.scaledTime)}ms  次の護衛=${nextName}  interval=${RELAY_INTERVAL}ms`);
    console.log('--- RELAY CHECKPOINT (1人目終了) ---\n' + this._playLog.join('\n'));
    this._showNextWaveCard(this.escortIdx + 1, nextName);
  }

  _activateNextEscort() {
    this.escortIdx++;
    this._closeBanner();
    this._closeNextWaveCard();
    this._playLog.push(`[RELAY_START]  t=${Math.round(this.scaledTime)}ms  escortIdx=${this.escortIdx}  timeOffset=${Math.round(this.scaledTime)}ms`);
    this._startEscort(this.escortIdx, this.scaledTime);
  }

  // ログが長い場合に分割出力（Edgeコンソールの表示上限対策）
  _printPlayLog() {
    const CHUNK = 60;
    const lines = this._playLog;
    for (let i = 0; i < lines.length; i += CHUNK) {
      const header = i === 0 ? '=== PLAY LOG ===' : `=== PLAY LOG (続き ${i + 1}〜) ===`;
      console.log(header + '\n' + lines.slice(i, i + CHUNK).join('\n'));
    }
  }

  _endGame() {
    const minS  = this.stageData.minSurvivors ?? 1;
    const total = this.escortDefs.length;
    // HP残: 全護衛のHP合計÷maxHp合計（交代のたびに前護衛のHPが消えるバグを修正・2026-07-29）
    if (this._escortHpRecords.length <= this.escortIdx) this._recordEscortHp();
    const hpSum       = this._escortHpRecords.reduce((s, r) => s + r.hp, 0);
    const hpMaxSum    = this._escortHpRecords.reduce((s, r) => s + r.maxHp, 0);
    const hpPct       = hpMaxSum > 0 ? Math.round(hpSum / hpMaxSum * 100) : 0;
    const hpBreakdown = this._escortHpRecords.map(r => `${r.variant}${Math.round(r.hp / r.maxHp * 100)}`).join('/');
    if (this.survivors >= minS) {
      this.gameState = 'victory';
      audioSynth.stageClear();
      this._playLog.push(`[RESULT] スポーン総数=${this.spawnCount}  撃破=${this.killCount}  すり抜け=${this.spawnCount - this.killCount - this._yHitCount}  護衛生還=${this.survivors}/${total}  HP残=${hpPct}% (${hpBreakdown})  CLOSE_CALL=${this._closecallCount}回/${this._closeCallBySpawn.size}箇所  最接近=${this._closestEver === Infinity ? '-' : Math.round(this._closestEver)}px  Y一撃離脱=${this._yHitCount}体  判定=CLEAR`);
      this._printDamageAndLeakLogs();
      this._printPlayLog();
      this._showResult('STAGE CLEAR!', '#ffff44', 'リスタート', true);
    } else {
      this.gameState = 'defeat';
      audioSynth.gameOver();
      this._playLog.push(`[RESULT] スポーン総数=${this.spawnCount}  撃破=${this.killCount}  すり抜け=${this.spawnCount - this.killCount - this._yHitCount}  護衛生還=${this.survivors}/${total}  HP残=${hpPct}% (${hpBreakdown})  CLOSE_CALL=${this._closecallCount}回/${this._closeCallBySpawn.size}箇所  最接近=${this._closestEver === Infinity ? '-' : Math.round(this._closestEver)}px  Y一撃離脱=${this._yHitCount}体  判定=GAMEOVER`);
      this._printDamageAndLeakLogs();
      this._printPlayLog();
      this._showResult('GAME OVER', '#ff4444', 'もう一度', false);
    }
  }

  // すり抜け（未撃破）・被弾をスポーン地点別に集計してログへ追加（run_sim.js/simulator.htmlと同一形式・2-7機能B）
  _printDamageAndLeakLogs() {
    if (this._damageBySpawn?.size > 0) {
      this._playLog.push('[DAMAGE_BY_SPAWN]');
      const sorted = [...this._damageBySpawn.entries()].sort((a, b) => b[1].totalDmg - a[1].totalDmg);
      for (const [key, rec] of sorted) {
        const byTypeStr   = [...rec.byType.entries()].map(([t, n]) => `${t}×${n}`).join(', ');
        const byEscortStr = [...rec.byEscort.entries()].map(([v, n]) => `${v}×${n}`).join(', ');
        this._playLog.push(`  spawn=(${key})   被弾${rec.hits}回  合計${rec.totalDmg}dmg  （${byTypeStr}）  護衛=${byEscortStr}`);
      }
    }
    if (this._allSpawnedZombies?.length > 0) {
      const leakBySpawn = new Map();
      for (const z of this._allSpawnedZombies) {
        if (z._killed || z._oneShotDefeated) continue;
        const key = `${z._spawnOrigin.col},${z._spawnOrigin.row}`;
        leakBySpawn.set(key, (leakBySpawn.get(key) ?? 0) + 1);
      }
      if (leakBySpawn.size > 0) {
        this._playLog.push('[LEAK_BY_SPAWN]');
        const sorted = [...leakBySpawn.entries()].sort((a, b) => b[1] - a[1]);
        for (const [key, count] of sorted) {
          this._playLog.push(`  spawn=(${key})  すり抜け${count}体`);
        }
      }
    }
    if (this._closeCallBySpawn?.size > 0) {
      const sorted = [...this._closeCallBySpawn.entries()].sort((a, b) => b[1].count - a[1].count);
      for (const [key, rec] of sorted) {
        this._playLog.push(`[CLOSE_CALL_BY_SPAWN] spawn=(${key}) ${rec.count}回 最接近${Math.round(rec.closest)}px`);
      }
    }
    if (this._yHitBySpawn?.size > 0) {
      const sorted = [...this._yHitBySpawn.entries()].sort((a, b) => b[1] - a[1]);
      for (const [key, count] of sorted) {
        this._playLog.push(`[Y_HIT_BY_SPAWN] spawn=(${key}) ${count}体`);
      }
    }
  }

  // ─── メインループ ─────────────────────────────────────────
  update(time, delta) {
    // ポップアップ表示中はGameScene自身の入力を毎フレーム強制的に同期する（2026-08-05）。
    // 「開く場所・閉じる場所それぞれで手動true/false」方式は、閉じる経路を1つ見落とすだけで
    // 恒久固着する事故を起こした（_tryPlaceの_canPlace失敗パス）。popupStateから毎フレーム
    // 導出する形にすれば、どの経路がpopupStateのクリアを忘れても次のフレームで自動復旧する。
    this.input.enabled = !this.popupState;
    if (this.popupState) {
      if (this._popupOpenSince === undefined) this._popupOpenSince = this.time.now;
      const openMs = this.time.now - this._popupOpenSince;
      if (openMs > 2000 && !this._popupStuckWarned) {
        this._popupStuckWarned = true;
        const msg = `[TAP_DEBUG] 警告: popupStateが${Math.round(openMs)}ms開いたまま固着しています type=${this.popupState.type}`;
        this._playLog.push(msg);
        console.warn(msg, this.popupState);
      }
    } else {
      this._popupOpenSince   = undefined;
      this._popupStuckWarned = false;
    }

    const scale   = TIME_SCALES[this.timeModeIdx];
    const totalDt = delta * scale;
    this._dt      = totalDt;  // _drawDynamic から矢印アニメに使う

    if (scale > 0 && this.gameState === 'playing') {
      // サブステップ: 速度倍率による挙動差を最小化するため16msに細分化
      const MAX_STEP = 16;
      let remaining  = totalDt;
      while (remaining > 0 && this.gameState === 'playing') {
        const step = Math.min(remaining, MAX_STEP);
        remaining -= step;
        this.scaledTime += step;

        // 時間指定タワーの建設チェック（@ms 構文）
        while (this._delayedTowerQueue?.length > 0 && this._delayedTowerQueue[0].buildAt <= this.scaledTime) {
          const t = this._delayedTowerQueue.shift();
          this.towers.push(new Tower(this, t.col, t.row, t.type));
          this._playLog?.push(`[BUILD]  t=${Math.round(this.scaledTime)}ms  ${t.type}@(${t.col},${t.row})`);
        }

        // シムと同じ更新順: ff→sem→zombie→tower→escort の順で処理
        if (this.escort.alive && !this.escort.reached) {
          this.flowField.update(
            Math.floor(this.escort.x / CELL),
            Math.floor(this.escort.y / CELL)
          );
        }

        const escortTarget = this.relayPhase === 'active' ? this.escort : null;
        this.waveManager.update(this.scaledTime, (col, row, def, wn, leader) => this._spawnZombie(col, row, def, wn, leader), escortTarget);
        this._yInflow?.update(this.scaledTime, (col, row, def, wn, leader) => this._spawnZombie(col, row, def, wn, leader));

        this.zombies.forEach(z => {
          const _hpBefore = escortTarget ? escortTarget.hp : null;
          z.update(this.scaledTime, step, escortTarget);
          if (escortTarget && _hpBefore != null) {
            const _dmg = _hpBefore - escortTarget.hp;
            if (_dmg > 0) {
              const _key = `${z._spawnOrigin.col},${z._spawnOrigin.row}`;
              let _rec = this._damageBySpawn.get(_key);
              if (!_rec) { _rec = { totalDmg: 0, hits: 0, byType: new Map(), byEscort: new Map() }; this._damageBySpawn.set(_key, _rec); }
              _rec.totalDmg += _dmg;
              _rec.hits += 1;
              _rec.byType.set(z.type, (_rec.byType.get(z.type) ?? 0) + 1);
              _rec.byEscort.set(escortTarget.variant, (_rec.byEscort.get(escortTarget.variant) ?? 0) + 1);
            }
          }
        });
        this.towers.forEach(t  => t.update(this.scaledTime, step, this.zombies, this.bullets, escortTarget));

        this.bullets = this.bullets.filter(b => b.active);
        this.bullets.forEach(b => b.update(step));

        this.zombies.forEach(z => {
          if (!z.alive) {
            // Y中の一撃離脱ゾンビは攻撃成立時点で必ず150px以内にいるため除外する（別途_yHitBySpawnで集計）
            if (!z._retreating && !z._oneShotDefeated && z._closestToEscort < CELL * 1.5 && this.relayPhase === 'active') {
              this._closecallCount++;
              if (z._closestToEscort < this._closestEver) this._closestEver = z._closestToEscort;
              this._playLog?.push(`[CLOSE_CALL] t=${Math.round(this.scaledTime)}ms  dist=${Math.round(z._closestToEscort)}px → 撃破`);
              const _ccKey = `${z._spawnOrigin.col},${z._spawnOrigin.row}`;
              const _ccRec = this._closeCallBySpawn.get(_ccKey) ?? { count: 0, closest: Infinity };
              _ccRec.count++;
              if (z._closestToEscort < _ccRec.closest) _ccRec.closest = z._closestToEscort;
              this._closeCallBySpawn.set(_ccKey, _ccRec);
            }
            if (z._oneShotDefeated) {
              this._yHitCount++;
              const _yKey = `${z._spawnOrigin.col},${z._spawnOrigin.row}`;
              this._yHitBySpawn.set(_yKey, (this._yHitBySpawn.get(_yKey) ?? 0) + 1);
            }
            z.cleanup();
          }
        });
        this.zombies = this.zombies.filter(z => z.alive);

        this.escort.update(step);  // escort は最後に更新（シムと同じ順序）

        if (this.relayPhase === 'active') this._checkWinLose();
      }

      // インターバルカウントダウン（ゲーム速度に連動）
      if (this.relayPhase === 'interval') {
        this.intervalTimer -= totalDt;
        if (this.intervalTimer <= 0) this._activateNextEscort();
      }
    }

    this._drawDynamic();
    this._drawHUD();
    this._drawIndicators();

  }

  // ─── アンダーレイ（depth -3）────────────────────────────
  // 128pxスプライトが64pxマスからはみ出す領域に道路等を敷いて違和感を消す
  _drawUnderlayLayer() {
    const cells = this.stageData.underlay || [];
    if (!cells.length) return;

    const FALLBACK = { road: 0x888888, grass: 0x2a3a25, dirt: 0x7a5a2a, asphalt: 0x3a3a3a };
    for (const cell of cells) {
      const texKey = cell.type === 'road' ? 'ground_road' : `ground_${cell.type}`;
      if (this.textures.exists(texKey)) {
        this.add.image(cell.col * CELL + CELL / 2, cell.row * CELL + CELL / 2, texKey)
          .setDisplaySize(CELL, CELL).setDepth(-3);
      } else {
        const color = FALLBACK[cell.type] ?? 0x888888;
        this.add.graphics().setDepth(-3)
          .fillStyle(color, 1)
          .fillRect(cell.col * CELL, cell.row * CELL, CELL, CELL);
      }
    }
  }

  // ─── 地面レイヤー（depth -2） ────────────────────────────
  _drawGroundLayer() {
    const groundType = this.stageData.ground_base || 'grass';
    const texKey     = `ground_${groundType}`;
    const FALLBACK   = { grass: 0x3a7a2a, dirt: 0x8b6914, asphalt: 0x444444 };

    // ベース地面
    if (this.textures.exists(texKey)) {
      for (let col = 0; col < COLS; col++) {
        for (let row = 0; row < ROWS; row++) {
          this.add.image(col * CELL + CELL / 2, row * CELL + CELL / 2, texKey)
            .setDisplaySize(CELL, CELL)
            .setDepth(-2);
        }
      }
    } else {
      const color = FALLBACK[groundType] ?? 0x2a3a25;
      this.add.graphics().setDepth(-2)
        .fillStyle(color, 1)
        .fillRect(0, 0, MAP_W, MAP_H);
    }

    // セル別地面上書き（bc>1は原点1セル保存方式・旧フォーマット互換）
    const cellGrounds = this.stageData.ground_cells || [];
    const _claimed = new Set();
    const byType = {};
    for (const cell of cellGrounds) {
      const ck = `ground_${cell.type}`;
      if (this.textures.exists(ck)) {
        const bdef = GROUND_BLOCK_DEFS[cell.type];
        const bw = bdef ? (bdef.blockW ?? bdef.blockCells ?? 1) : 1;
        const bh = bdef ? (bdef.blockH ?? bdef.blockCells ?? 1) : 1;
        if (bw > 1 || bh > 1) {
          const cellKey = `${cell.col},${cell.row}`;
          if (_claimed.has(cellKey)) continue; // 旧フォーマット非原点セルをスキップ
          this.add.image(cell.col * CELL, cell.row * CELL, ck)
            .setOrigin(0, 0)
            .setDisplaySize(bw * CELL, bh * CELL)
            .setDepth(-2);
          for (let dc = 0; dc < bw; dc++)
            for (let dr = 0; dr < bh; dr++)
              _claimed.add(`${cell.col+dc},${cell.row+dr}`);
        } else {
          this.add.image(cell.col * CELL + CELL / 2, cell.row * CELL + CELL / 2, ck)
            .setDisplaySize(CELL, CELL).setDepth(-2);
        }
      } else {
        if (!byType[cell.type]) byType[cell.type] = [];
        byType[cell.type].push(cell);
      }
    }
    for (const [type, cells] of Object.entries(byType)) {
      const color = FALLBACK[type] ?? 0x2a3a25;
      const g = this.add.graphics().setDepth(-2).fillStyle(color, 1);
      for (const cell of cells) g.fillRect(cell.col * CELL, cell.row * CELL, CELL, CELL);
    }
  }

  // ─── 道路レイヤー（depth -1） ────────────────────────────
  _drawRoadLayer() {
    const roads = this.stageData.roads || [];
    if (!roads.length) return;

    const roadKey  = 'ground_道路横';
    const vRoadKey = 'ground_road_vertical';
    const hasVTex  = this.textures.exists(vRoadKey);
    const hasHTex  = this.textures.exists(roadKey);
    const fbGfx    = this.add.graphics().setDepth(-1);
    fbGfx.fillStyle(0x888888, 1);

    // ─ 横道路（1セル） ─
    const hRoads = roads.filter(r => r.axis === 'h');
    const drawnH = new Set();
    for (const road of hRoads) {
      for (let i = road.from; i <= road.to; i++) {
        const ck = `${i},${road.line}`;
        if (drawnH.has(ck)) continue;
        drawnH.add(ck);
        if (hasHTex) {
          this.add.image(i * CELL + CELL / 2, road.line * CELL + CELL / 2, roadKey)
            .setDisplaySize(CELL, CELL).setDepth(-1);
        } else {
          fbGfx.fillRect(i * CELL, road.line * CELL, CELL, CELL);
        }
      }
    }

    // ─ 縦道路（隣接列ペアを CELL*2 幅で描画） ─
    const vRoads = roads.filter(r => r.axis === 'v');
    const vColMap = new Map();
    for (const road of vRoads) {
      if (!vColMap.has(road.line)) vColMap.set(road.line, new Set());
      for (let i = road.from; i <= road.to; i++) vColMap.get(road.line).add(i);
    }
    const vCols  = [...vColMap.keys()].sort((a, b) => a - b);
    const vUsed  = new Set();
    for (const col of vCols) {
      if (vUsed.has(col)) continue;
      const rows = vColMap.get(col);
      if (vColMap.has(col + 1) && !vUsed.has(col + 1)) {
        vUsed.add(col); vUsed.add(col + 1);
        const rightRows = vColMap.get(col + 1);
        for (const row of rows) {
          if (!rightRows.has(row)) continue;
          const x = col * CELL + CELL;      // 2セルの中心
          const y = row * CELL + CELL / 2;
          if (hasVTex) {
            this.add.image(x, y, vRoadKey).setDisplaySize(CELL * 2, CELL).setDepth(-1);
          } else {
            fbGfx.fillRect(col * CELL, row * CELL, CELL * 2, CELL);
          }
        }
      } else {
        vUsed.add(col);
        for (const row of rows) {
          const x = col * CELL + CELL / 2;
          const y = row * CELL + CELL / 2;
          if (hasVTex) {
            this.add.image(x, y, vRoadKey).setDisplaySize(CELL, CELL).setDepth(-1);
          } else {
            fbGfx.fillRect(col * CELL, row * CELL, CELL, CELL);
          }
        }
      }
    }

  }

  // ─── デカールレイヤー（depth 0、当たり判定なし） ──────────────
  _drawDecalLayer() {
    // 墓デカールはスポーン予告の意味を持たせない（装飾のみ）。
    // 置きたい場合はステージJSONのdecals/propsに直接配置する。スポーン座標との自動連動は廃止済み。
    const decals = this.stageData.decals || [];
    if (!decals.length) return;

    const FALLBACK  = { crosswalk_h: 0xddcc22, crosswalk_v: 0xddcc22, manhole: 0xaaaaaa };
    const SWAY_TYPES = new Set(['tree', '木1', '木2']);

    for (const decal of decals) {
      const def = DECAL_DEFS[decal.type];
      if (!def) continue;
      const pw  = def.cols * CELL;
      const ph  = def.rows * CELL;
      const sc  = def.scale ?? 1;
      const cx  = decal.x != null ? decal.x : decal.col * CELL + pw / 2;
      const cy  = decal.y != null ? decal.y : decal.row * CELL + ph / 2;
      const key = `decal_${decal.type}`;
      if (this.textures.exists(key)) {
        if (decal.tileW) {
          const tw = pw * sc, th = ph * sc;
          const lx = cx - decal.tileW / 2;
          for (let tx = 0; tx < decal.tileW; tx += tw) {
            this.add.image(lx + tx + tw / 2, cy, key).setDisplaySize(tw, th).setDepth(0);
          }
          continue;
        }
        const sway = SWAY_TYPES.has(decal.type);
        const img = this.add.image(cx, sway ? cy + ph * sc / 2 : cy, key)
          .setDisplaySize(pw * sc, ph * sc)
          .setDepth(0);
        if (sway) {
          img.setOrigin(0.5, 1).setAngle(-3);
          this.tweens.add({
            targets: img, angle: 3,
            duration: 1500 + Math.random() * 1000,
            yoyo: true, repeat: -1,
            ease: 'Sine.easeInOut',
            delay: Math.random() * 1500,
          });
        }
      } else {
        const color = FALLBACK[decal.type] ?? 0x88ccff;
        this.add.graphics().setDepth(0)
          .fillStyle(color, 0.55)
          .fillRect(cx - pw / 2, cy - ph / 2, pw, ph);
      }
    }

  }

  // ─── 護衛ルート赤線（トグル） ────────────────────────────
  _drawEscortRoute() {
    const g = this.pathGfx;
    g.clear();
    if (!this.showRoute) return;
    g.lineStyle(3, 0xff2222, 0.75);
    for (const esc of (this.stageData.escorts ?? [])) {
      const path = esc.path ?? [];
      if (path.length < 2) continue;
      for (let i = 0; i < path.length - 1; i++) {
        const ax = path[i].col   * CELL + CELL / 2, ay = path[i].row   * CELL + CELL / 2;
        const bx = path[i+1].col * CELL + CELL / 2, by = path[i+1].row * CELL + CELL / 2;
        g.lineBetween(ax, ay, bx, by);
      }
    }
  }

  // ─── 静的マップ描画 ───────────────────────────────────────
  _drawMapStatic() {
    const g = this.mapGfx;
    g.clear();

    if (this.showGrid) {
      g.lineStyle(1, 0x7aaacc, 0.22);
      for (let c = 0; c <= COLS; c++) g.lineBetween(c * CELL, 0, c * CELL, MAP_H);
      for (let r = 0; r <= ROWS; r++) g.lineBetween(0, r * CELL, MAP_W, r * CELL);
    }

    g.fillStyle(0x607898, 1);
    for (const obs of this.stageData.obstacles) {
      g.fillRect(obs.col * CELL + 2, obs.row * CELL + 2, CELL - 4, CELL - 4);
      g.lineStyle(2, 0x80a0c0, 1);
      g.strokeRect(obs.col * CELL + 2, obs.row * CELL + 2, CELL - 4, CELL - 4);
    }

    const s  = this.escortDefs[0].start;
    const gl = this.escortDefs[0].goal;
    this.add.graphics().setDepth(1)
      .fillStyle(0x00ff88, 0.22).fillRect(s.col * CELL, s.row * CELL, CELL, CELL)
      .fillStyle(0xffff00, 0.22).fillRect(gl.col * CELL, gl.row * CELL, CELL, CELL);

    // S/Gアイコン（暫定テキスト・GPT素材が来たら差し替え）
    const iconStyle = { fontSize: '20px', fontFamily: '"Arial Black", Arial, sans-serif',
      stroke: '#000000', strokeThickness: 4, shadow: { blur: 4, color: '#000', fill: true } };
    this.add.text(s.col  * CELL + CELL / 2, s.row  * CELL + CELL / 2, 'S',
      { ...iconStyle, color: '#00ff88' }).setOrigin(0.5).setDepth(4);
    this.add.text(gl.col * CELL + CELL / 2, gl.row * CELL + CELL / 2, 'G',
      { ...iconStyle, color: '#ffee44' }).setOrigin(0.5).setDepth(4);

  }

  // ─── プロップ描画（静的、一度だけ） ────────────────────────
  _drawProps() {
    // レーザー用：プロップが占有する全セルをSetで管理
    this.propCells = new Set();
    for (const prop of (this.stageData.props || [])) {
      const def = PROP_DEFS[prop.type];
      if (!def) continue;
      for (let dc = 0; dc < def.cols; dc++)
        for (let dr = 0; dr < def.rows; dr++)
          this.propCells.add(`${prop.col + dc},${prop.row + dr}`);
    }

    const PROP_SWAY = new Set(['tree', '木1', '木2']);

    for (const prop of (this.stageData.props || [])) {
      const def = PROP_DEFS[prop.type];
      if (!def) continue;
      const px = prop.col * CELL;
      const py = prop.row * CELL;
      const pw = def.cols * CELL;
      const ph = def.rows * CELL;
      const sc = def.scale ?? 1;
      const key = `prop_${prop.type}`;
      if (this.textures.exists(key)) {
        const sway = PROP_SWAY.has(prop.type);
        const img = this.add.image(px + pw / 2, sway ? py + ph : py + ph / 2, key)
          .setDisplaySize(pw * sc, ph * sc)
          .setDepth(2);
        if (sway) {
          img.setOrigin(0.5, 1).setAngle(-3);
          this.tweens.add({
            targets: img, angle: 3,
            duration: 1500 + Math.random() * 1000,
            yoyo: true, repeat: -1,
            ease: 'Sine.easeInOut',
            delay: Math.random() * 1500,
          });
        }
      } else {
        const g = this.add.graphics().setDepth(2);
        g.fillStyle(0x607898, 1);
        g.fillRect(px + 2, py + 2, pw - 4, ph - 4);
        g.lineStyle(2, 0x80a0c0, 1);
        g.strokeRect(px + 2, py + 2, pw - 4, ph - 4);
      }
      // フットプリント確認枠（グリッド表示ON時のみ）
      if (this.showGrid) {
        const dg = this.add.graphics().setDepth(2);
        dg.lineStyle(2, 0xff4444, 0.85);
        dg.strokeRect(px, py, pw, ph);
      }
    }
  }

  // ─── 設置点マーカー描画 ───────────────────────────────────
  _drawBuildSpots(g) {
    if (this.buildSpots.size === 0) return;
    const t = this.time.now;
    for (const key of this.buildSpots) {
      const [col, row] = key.split(',').map(Number);
      if (this.towers.some(tw => tw.col === col && tw.row === row)) continue;
      const cx = col * CELL + CELL / 2;
      const cy = row * CELL + CELL / 2;
      const isActive = this.popupState?.type === 'build'
                    && this.popupState.col === col
                    && this.popupState.row === row;
      if (isActive) {
        const pulse = 0.5 + 0.5 * Math.sin(t * 0.005);
        g.fillStyle(0xff3333, 0.18 + 0.14 * pulse);
        g.fillRect(col * CELL + 2, row * CELL + 2, CELL - 4, CELL - 4);
        g.lineStyle(2, 0xff3333, 0.65 + 0.35 * pulse);
        g.strokeRect(col * CELL + 5, row * CELL + 5, CELL - 10, CELL - 10);
        g.fillStyle(0xff3333, 0.95);
        g.fillCircle(cx, cy, 7);
      } else {
        g.fillStyle(0xff3333, 0.85);
        g.fillCircle(cx, cy, 6);
        g.lineStyle(1, 0xffffff, 0.5);
        g.strokeCircle(cx, cy, 6);
      }
    }
  }

  // ─── 動的描画 ─────────────────────────────────────────────
  // 経路ポイント列から累積弧長配列を生成
  _buildArcLengths(pts) {
    const arcs = [0];
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i].x - pts[i-1].x, dy = pts[i].y - pts[i-1].y;
      arcs.push(arcs[i-1] + Math.sqrt(dx*dx + dy*dy));
    }
    return arcs;
  }

  // 弧長パラメータ t → world座標 + 接線方向
  _arcLengthInterp(pts, arcs, t) {
    let lo = 0, hi = arcs.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (arcs[mid] <= t) lo = mid; else hi = mid;
    }
    const segLen = arcs[hi] - arcs[lo];
    const frac   = segLen > 0 ? (t - arcs[lo]) / segLen : 0;
    const a = pts[lo], b = pts[hi];
    return { x: a.x + (b.x - a.x) * frac, y: a.y + (b.y - a.y) * frac, dx: b.x - a.x, dy: b.y - a.y };
  }

  _drawDynamic() {
    const g = this.dynGfx;
    g.clear();

    if (this.showPaths && this.escort.path.length > 1) {
      g.lineStyle(2, 0xffff00, 0.35);
      for (let i = 0; i < this.escort.path.length - 1; i++) {
        const a = this.escort.path[i], b = this.escort.path[i + 1];
        g.lineBetween(a.x, a.y, b.x, b.y);
      }
    }

    // 護衛ルートテレグラフ（Gへ流れる矢印）
    if (this.escort && this.escort.alive && !this.escort.reached) {
      const remaining = this.escort.path.slice(this.escort.wpIdx);
      if (remaining.length > 0) {
        const SPEED   = 55;  // 流れ速度 px/s
        const SPACING = 80;  // 矢印間隔 px
        const SZ      = 10;  // 矢印サイズ px

        const pts      = [{ x: this.escort.x, y: this.escort.y }, ...remaining];
        const arcs     = this._buildArcLengths(pts);
        const totalLen = arcs[arcs.length - 1];

        if (totalLen > 0) {
          this._chevronT = (this._chevronT ?? 0) + SPEED * (this._dt ?? 0) / 1000;
          // ゴール到達 or 経路短縮で行き過ぎたら護衛位置からリスタート
          if (this._chevronT >= totalLen) this._chevronT = 0;

          // 極薄の基線（経路の正確な形を示す）
          g.lineStyle(1, 0xffffff, 0.18);
          for (let i = 0; i < pts.length - 1; i++) {
            g.lineBetween(pts[i].x, pts[i].y, pts[i+1].x, pts[i+1].y);
          }

          // 流れる矢印（1個のみ）
          const count = 1;
          for (let i = 0; i < count; i++) {
            const t   = (this._chevronT + i * SPACING) % totalLen;
            const pos = this._arcLengthInterp(pts, arcs, t);
            const len = Math.sqrt(pos.dx ** 2 + pos.dy ** 2) || 1;
            const nx  = pos.dx / len, ny = pos.dy / len;   // 進行方向
            const px  = -ny,          py = nx;             // 垂直方向

            const tipX = pos.x + nx * SZ;
            const tipY = pos.y + ny * SZ;
            const lx   = pos.x - nx * SZ * 0.5 + px * SZ * 0.65;
            const ly   = pos.y - ny * SZ * 0.5 + py * SZ * 0.65;
            const rx   = pos.x - nx * SZ * 0.5 - px * SZ * 0.65;
            const ry   = pos.y - ny * SZ * 0.5 - py * SZ * 0.65;

            // 暗い縁取り（少し後退させてオフセット）
            g.fillStyle(0x000000, 0.55);
            g.fillTriangle(tipX, tipY, lx - nx * 2, ly - ny * 2, rx - nx * 2, ry - ny * 2);
            // 白い矢印本体
            g.fillStyle(0xffffff, 0.92);
            g.fillTriangle(tipX, tipY, lx, ly, rx, ry);
          }
        }
      }
    }

    // スポーン予告点滅（3秒前から残り時間に応じて点滅が速くなる）
    const warning = this.waveManager?.getWarning(this.scaledTime);
    if (warning) {
      const { spawn, remaining } = warning;
      const wx = spawn.col * CELL, wy = spawn.row * CELL;
      const freq  = 1 + (1 - remaining / 3000) * 4;  // 1Hz→5Hz
      const alpha = Math.abs(Math.sin(this.scaledTime * 0.001 * Math.PI * freq));
      g.lineStyle(3, 0xff4400, alpha * 0.95);
      g.strokeRect(wx + 2, wy + 2, CELL - 4, CELL - 4);
      g.fillStyle(0xff4400, alpha * 0.3);
      g.fillRect(wx + 2, wy + 2, CELL - 4, CELL - 4);
    }

    this._drawBuildSpots(g);
    this.towers.forEach(t => t.draw(g));
    this.zombies.forEach(z => z.draw(g));
    this.escort.draw(g);
    this.bullets.forEach(b => b.draw(g));
  }

  // ─── HUD描画 ─────────────────────────────────────────────
  // HUD表示はUISceneが担当。ここではregistryへ最新値を書き込むのみ。
  _drawHUD() {
    this.registry.set('hud_money',     this.money);
    this.registry.set('hud_earned',    this.totalEarned);
    this.registry.set('hud_wave',      this.waveLabel ?? '');
    this.registry.set('hud_timeIdx',   this.timeModeIdx);
    this.registry.set('hud_gameState', this.gameState);
  }

  // ─── 画面外インジケータ ───────────────────────────────────
  _drawIndicators() {
    const g   = this.indicatorGfx;
    g.clear();

    const cam  = this.cameras.main;
    const vl   = cam.scrollX;
    const vt   = cam.scrollY;
    const vr   = vl + CANVAS_W / cam.zoom;
    const vb   = vt + (CANVAS_H - UI_H) / cam.zoom;
    const scx  = CANVAS_W / 2;
    const scy  = (CANVAS_H - UI_H) / 2;
    const margin = 22;

    const drawArrow = (wx, wy, color) => {
      const sx   = (wx - vl) * cam.zoom;
      const sy   = (wy - vt) * cam.zoom;
      const dx   = sx - scx;
      const dy   = sy - scy;
      const ang  = Math.atan2(dy, dx);
      const halfW = scx - margin, halfH = scy - margin;
      const absDx = Math.abs(dx), absDy = Math.abs(dy);
      if (absDx === 0 && absDy === 0) return;
      const ratio = absDy * halfW < absDx * halfH ? halfW / absDx : halfH / absDy;
      const ax = clamp(scx + dx * ratio, margin, CANVAS_W - margin);
      const ay = clamp(scy + dy * ratio, margin, CANVAS_H - UI_H - margin);

      g.fillStyle(color, 0.85);
      const s = 9;
      const tipX = ax + Math.cos(ang) * s;
      const tipY = ay + Math.sin(ang) * s;
      const lx   = ax + Math.cos(ang + 2.4) * s * 0.7;
      const ly   = ay + Math.sin(ang + 2.4) * s * 0.7;
      const rx   = ax + Math.cos(ang - 2.4) * s * 0.7;
      const ry   = ay + Math.sin(ang - 2.4) * s * 0.7;
      g.fillTriangle(tipX, tipY, lx, ly, rx, ry);
    };

    for (const z of this.zombies) {
      if (!z.alive) continue;
      if (z.x >= vl && z.x <= vr && z.y >= vt && z.y <= vb) continue;
      drawArrow(z.x, z.y, 0x22cc44);
    }

    if (this.escort.alive && !this.escort.reached) {
      if (this.escort.x < vl || this.escort.x > vr || this.escort.y < vt || this.escort.y > vb) {
        drawArrow(this.escort.x, this.escort.y, 0xff4444);
      }
    }
  }

  // ─── 入力設定 ─────────────────────────────────────────────
  _setupInput() {
    this.input.addPointer(1);

    let downX = 0, downY = 0, isDrag = false;
    this.pinching   = false;
    this.pinchStart = { dist: 0, zoom: 1 };

    this.input.on('pointerdown', (p) => {
      downX = p.x; downY = p.y; isDrag = false;
    });

    this.input.on('pointermove', (p) => {
      const p1 = this.input.pointer1;
      const p2 = this.input.pointer2;
      if (p1.isDown && p2.isDown) {
          const dx   = p1.x - p2.x, dy = p1.y - p2.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (!this.pinching) {
          this.pinching   = true;
          this.pinchStart = { dist, zoom: this.cameras.main.zoom };
        } else if (dist > 0) {
          const cam  = this.cameras.main;
          const oldZ = cam.zoom;
          const newZ = clamp(
            this.pinchStart.zoom * (dist / this.pinchStart.dist),
            ZOOM_LEVELS[0], ZOOM_LEVELS[ZOOM_LEVELS.length - 1]
          );
          const midX = (p1.x + p2.x) / 2;
          const midY = (p1.y + p2.y) / 2;
          const wx = cam.scrollX + (midX - cam.x) / oldZ;
          const wy = cam.scrollY + (midY - cam.y) / oldZ;
          cam.setZoom(newZ);
          cam.scrollX = wx - (midX - cam.x) / newZ;
          cam.scrollY = wy - (midY - cam.y) / newZ;
        }
        return;
      }

      if (this.pinching) {
        this._snapZoomIdx();
        this.pinching = false;
        // ピンチ終了時に基準点をリセット（古い downX/prevPosition による跳びを防ぐ）
        downX = p.x; downY = p.y;
        isDrag = false;
        return;
      }

      if (p.isDown) {
          const ddx = Math.abs(p.x - downX), ddy = Math.abs(p.y - downY);
        if (ddx > 8 || ddy > 8) {
          isDrag = true;
          const dx = p.x - p.prevPosition.x;
          const dy = p.y - p.prevPosition.y;
          this.cameras.main.scrollX -= dx / this.cameras.main.zoom;
          this.cameras.main.scrollY -= dy / this.cameras.main.zoom;
        }
      }
    });

    this.input.on('pointerup', (p) => {
      if (this.pinching) this._snapZoomIdx();
      this.pinching = false;
      if (!isDrag) this._handleTap(p);
      isDrag = false;
    });

    this.input.on('wheel', (p, go, dx, dy) => {
      this.zoomIdx = clamp(this.zoomIdx + (dy > 0 ? -1 : 1), 0, ZOOM_LEVELS.length - 1);
      this.cameras.main.setZoom(ZOOM_LEVELS[this.zoomIdx]);
    });

    this.input.keyboard.on('keydown', (e) => {
      if (e.key === 'Escape')                  this._closePopup();
      if (e.key === 'd' || e.key === 'D')      this._toggleDebug();
      if (e.key === 'g' || e.key === 'G')      { this.showGrid = !this.showGrid; this._drawMapStatic(); }
      if (e.key === 'p' || e.key === 'P')      this.showPaths = !this.showPaths;
      if (e.key === ' ')                        this._cycleTimeMode();
      if (e.key === 'h' || e.key === 'H')      this._returnToEscort();
    });
  }

  // ─── ズームスナップ ───────────────────────────────────────
  _snapZoomIdx() {
    const cur = this.cameras.main.zoom;
    let nearest = 0, minDist = Infinity;
    ZOOM_LEVELS.forEach((z, i) => {
      const d = Math.abs(z - cur);
      if (d < minDist) { minDist = d; nearest = i; }
    });
    this.zoomIdx = nearest;
    this.cameras.main.setZoom(ZOOM_LEVELS[this.zoomIdx]);
  }

  // ─── タップ処理 ──────────────────────────────────────────
  _handleTap(p) {
    if (p.y > CANVAS_H - UI_H) return;

    // 調査用デバッグログ（2026-08-04・ポップアップ2回目以降開かない事象の原因特定用・修正後に削除予定）
    const col = Math.floor(p.worldX / CELL);
    const row = Math.floor(p.worldY / CELL);
    const _psSummary = this.popupState
      ? `type=${this.popupState.type}${this.popupState.col !== undefined ? `,col=${this.popupState.col},row=${this.popupState.row}` : ''}`
      : 'null';
    this._playLog.push(`[TAP_DEBUG] enter col=${col} row=${row} popupState=${_psSummary} money=${this.money}`);

    // NEXT WAVEカード表示中のタップ → スキップ
    if (this.relayPhase === 'interval' && this._nextWaveCardObjs) {
      this._playLog.push(`[TAP_DEBUG] return=nextWaveCard popupState=${_psSummary} money=${this.money}`);
      this._activateNextEscort();
      return;
    }

    if (this._popupJustActed) {
      // 時間切れロック方式（2026-08-04修正）: 「次の1タップだけ消費する」設計だと、
      // 期待していた"直後のゴースト重複タップ"が実機で来なかった場合にフラグが残り続け、
      // それ以降の本物のタップまで無限に飲み込んでしまう事故があった（建設1回で以降ずっと開かない）。
      // 実時間ベースで自動失効させることで、ゴーストタップが来ない場合でも必ず一定時間後に復帰する。
      const stillActive = this.time.now < this._popupJustActed;
      this._popupJustActed = 0;
      this._playLog.push(`[TAP_DEBUG] return=popupJustActed(stillActive=${stillActive}) popupState=${_psSummary} money=${this.money}`);
      if (stillActive) return;
    }

    if (this.popupState) {
      this._playLog.push(`[TAP_DEBUG] return=popupState既存(トグルクローズ) popupState=${_psSummary} money=${this.money}`);
      this._closePopup();
      return;
    }

    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) {
      this._playLog.push(`[TAP_DEBUG] return=範囲外 col=${col} row=${row} money=${this.money}`);
      return;
    }

    const tower = this.towers.find(t => t.col === col && t.row === row);
    if (tower) {
      this._playLog.push(`[TAP_DEBUG] return=既存タワー重複(売却メニューへ) col=${col} row=${row} money=${this.money}`);
      this._openSellMenu(tower);
      return;
    }

    // プロップ上のタップ → バツマーク＋効果音
    if (this.propCells?.has(`${col},${row}`)) {
      this._playLog.push(`[TAP_DEBUG] return=prop衝突 col=${col} row=${row} money=${this.money}`);
      this._showPlaceFail(col, row);
      return;
    }

    const onSpot = this.buildSpots.size === 0 || this.buildSpots.has(`${col},${row}`);
    if (onSpot) {
      this._playLog.push(`[TAP_DEBUG] return=正常到達→openBuildMenu col=${col} row=${row} money=${this.money}`);
      this._openBuildMenu(col, row);
    } else {
      this._playLog.push(`[TAP_DEBUG] return=buildSpots非該当 col=${col} row=${row} money=${this.money}`);
    }
  }

  _showPlaceFail(col, row) {
    audioSynth.escortHit();  // 暫定音：専用denySEが来たら差し替え
    const x = col * CELL + CELL / 2;
    const y = row * CELL + CELL / 2;
    const g = this.add.graphics().setDepth(20);
    const s = CELL * 0.32;
    g.lineStyle(3, 0xff2222, 0.95);
    g.lineBetween(x - s, y - s, x + s, y + s);
    g.lineBetween(x + s, y - s, x - s, y + s);
    this.time.delayedCall(500, () => g.destroy());
  }

  // ─── 建設メニュー ────────────────────────────────────────
  _openBuildMenu(col, row) {
    this._closePopup();
    this._preBuildTimeIdx = this.timeModeIdx;
    this.timeModeIdx = 0;  // 完全停止
    this.showGrid = true;
    this._drawMapStatic();

    // スクリーン座標を計算してUISceneに委譲（カメラズームの影響を排除するため）
    const cam        = this.cameras.main;
    const HEADER_H   = 8 + UI_H;
    const sx         = (col * CELL + CELL / 2 - cam.scrollX) * cam.zoom;
    const sy         = (row * CELL + CELL / 2 - cam.scrollY) * cam.zoom + HEADER_H;
    const cellHalfPx = (CELL * cam.zoom) / 2;

    this.popupState   = { type: 'build', col, row };
    this.popupObjects = [];
    // 建設ポップアップ表示中のGameScene自身の入力停止はupdate()で毎フレーム
    // popupStateから導出する（2026-08-05・手動true/false管理は閉じ忘れに弱いため廃止）

    this.game.events.emit('openBuildMenu', { col, row, sx, sy, cellHalfPx, money: this.money });
  }

  // ─── 売却メニュー ────────────────────────────────────────
  _openSellMenu(tower) {
    this._closePopup();

    const cam = this.cameras.main;
    const sx  = (tower.x - cam.scrollX) * cam.zoom;
    const sy  = (tower.y - cam.scrollY) * cam.zoom;

    const upgCost    = tower.upgradeCost?.() ?? null;
    const canUpgrade = upgCost !== null;
    const popW = 152;
    const popH = canUpgrade ? 110 : 72;
    let px = sx - popW / 2;
    let py = sy - (CELL * cam.zoom) / 2 - popH - 6;
    px = clamp(px, 6, CANVAS_W - popW - 6);
    if (py < 6) py = sy + (CELL * cam.zoom) / 2 + 6;
    py = clamp(py, 6, CANVAS_H - UI_H - popH - 6);

    this.popupState   = { type: 'sell', tower };
    this.popupObjects = [];
    tower.selected    = true;

    const def = TOWER_DEFS[tower.type];

    const bg = this.add.rectangle(px + popW / 2, py + popH / 2, popW, popH, 0x050510, 0.96)
      .setScrollFactor(0).setDepth(70).setStrokeStyle(1, 0x3a5070);
    this.popupObjects.push(bg);

    const titleText = this.add.text(px + popW / 2, py + 8, `${def.label}タワー  Lv${tower.upgradeLevel}`, {
      fontSize: '14px', fontFamily: 'Arial, Helvetica, sans-serif',
      color: def.textColor, stroke: '#000000', strokeThickness: 2,
    }).setScrollFactor(0).setDepth(71).setOrigin(0.5, 0);
    this.popupObjects.push(titleText);

    const btnW = 128, btnH = 30;
    const btnX = px + (popW - btnW) / 2;

    if (canUpgrade) {
      const ubY = py + 32;
      const hasMoney = this.money >= upgCost;
      const ubColor  = hasMoney ? 0x114411 : 0x222222;
      const upgradeBtn = this.add.rectangle(btnX + btnW / 2, ubY + btnH / 2, btnW, btnH, ubColor, 0.9)
        .setScrollFactor(0).setDepth(71).setStrokeStyle(1.5, hasMoney ? 0x44ff44 : 0x555555, 0.8).setInteractive();
      if (hasMoney) {
        upgradeBtn.on('pointerover',  () => upgradeBtn.setFillStyle(0x226622, 0.9));
        upgradeBtn.on('pointerout',   () => upgradeBtn.setFillStyle(0x114411, 0.9));
        upgradeBtn.on('pointerdown',  () => { this._popupJustActed = this.time.now + 300; this._upgradeTower(tower); });
      }
      this.popupObjects.push(upgradeBtn);
      const upgradeText = this.add.text(btnX + btnW / 2, ubY + btnH / 2,
        hasMoney ? `強化 Lv${tower.upgradeLevel + 1}  ¥${upgCost}` : `強化 ¥${upgCost} (資金不足)`, {
        fontSize: '13px', fontFamily: 'Arial, Helvetica, sans-serif',
        color: hasMoney ? '#88ff88' : '#666666', stroke: '#000000', strokeThickness: 2,
      }).setScrollFactor(0).setDepth(72).setOrigin(0.5, 0.5);
      this.popupObjects.push(upgradeText);
    }

    const sbY = canUpgrade ? py + 72 : py + popH - btnH - 8;
    const sellBtn = this.add.rectangle(btnX + btnW / 2, sbY + btnH / 2, btnW, btnH, 0x551111, 0.9)
      .setScrollFactor(0).setDepth(71).setStrokeStyle(1.5, 0xff4444, 0.8).setInteractive();
    sellBtn.on('pointerover',  () => sellBtn.setFillStyle(0x882222, 0.9));
    sellBtn.on('pointerout',   () => sellBtn.setFillStyle(0x551111, 0.9));
    sellBtn.on('pointerdown',  () => { this._popupJustActed = this.time.now + 300; this._sellTower(tower); });
    this.popupObjects.push(sellBtn);

    const sellText = this.add.text(btnX + btnW / 2, sbY + btnH / 2, `売却  +¥${tower.sell}`, {
      fontSize: '14px', fontFamily: 'Arial, Helvetica, sans-serif',
      color: '#ff9999', stroke: '#000000', strokeThickness: 2,
    }).setScrollFactor(0).setDepth(72).setOrigin(0.5, 0.5);
    this.popupObjects.push(sellText);
  }

  // ─── ポップアップを閉じる ────────────────────────────────
  _closePopup() {
    // 調査用デバッグログ（2026-08-04・修正後に削除予定）
    const _psBefore = this.popupState
      ? `type=${this.popupState.type}${this.popupState.col !== undefined ? `,col=${this.popupState.col},row=${this.popupState.row}` : ''}`
      : 'null';
    this._playLog.push(`[TAP_DEBUG] _closePopup開始 popupState=${_psBefore}`);
    // 調査用: 例外を握り潰さず、必ずplayLog/consoleへ内容を出してから同じ例外を再送出する（挙動は変えない・修正後に削除予定）
    // input.enabledはここでは触らない。update()が毎フレームpopupStateから導出するため
    // （2026-08-05・手動true/false管理は「閉じ忘れ」に弱く、実際にそれで固着事故が起きたため廃止）
    try {
      if (this.popupObjects?.length) {
        this.popupObjects.forEach(o => o.destroy());
        this.popupObjects = [];
      }
      if (this.popupState?.type === 'sell') {
        this.popupState.tower.selected = false;
      }
      // 建設メニューを閉じたら元の速度に戻す・UISceneのポップアップも閉じる
      if (this.popupState?.type === 'build' && this._preBuildTimeIdx !== undefined) {
        this.timeModeIdx = this._preBuildTimeIdx;
        this._preBuildTimeIdx = undefined;
        this.game.events.emit('closeBuildMenu');
        this.showGrid = false;
        this._drawMapStatic();
      }
      this.popupState = null;
      this._playLog.push(`[TAP_DEBUG] _closePopup完了 popupState=null`);
    } catch (e) {
      this._playLog.push(`[TAP_DEBUG] _closePopup例外: ${e?.message}\n${e?.stack}`);
      console.error('[TAP_DEBUG] _closePopup例外:', e);
      throw e;
    }
  }

  // ─── 初期配置タワー（JSON + ステージ選択画面入力・コスト無消費・チェックバイパス） ───
  _placeInitialTowers() {
    // JSONのinitialTowers
    const fromJson = this.stageData.initialTowers || [];

    // ステージ選択画面のテキスト入力をパース（書式: type:col,row or type:col,row@ms）
    const fromText = (this.sessionTowerText || '').trim()
      .split(/[\s\n]+/)
      .flatMap(token => {
        const m = token.match(/^(\w+):(\d+),(\d+)(?:@(\d+))?$/);
        return m ? [{ type: m[1], col: +m[2], row: +m[3], buildAt: m[4] !== undefined ? +m[4] : 0 }] : [];
      });

    this._delayedTowerQueue = [];
    const errors = [];
    const placedCoords = new Set(); // JSON/テキスト入力の重複座標を検知（同一座標は先着1基のみ建設）
    for (const t of [...fromJson.map(t => ({ ...t, buildAt: 0 })), ...fromText]) {
      if (!TOWER_DEFS[t.type]) {
        errors.push(`不明なタワー種別: "${t.type}"`);
        continue;
      }
      if (t.col < 0 || t.col >= COLS || t.row < 0 || t.row >= ROWS) {
        errors.push(`範囲外: ${t.type}@(${t.col},${t.row})`);
        continue;
      }
      const propHit = this._propBlocked.get(`${t.col},${t.row}`);
      if (propHit) {
        errors.push(`[ERROR] 設置不可: ${t.type}@(${t.col},${t.row}) はprop(${propHit})のフットプリント内です。ステージ側のbuildSpots/props定義が不整合`);
        continue;
      }
      const coordKey = `${t.col},${t.row}`;
      if (placedCoords.has(coordKey)) {
        errors.push(`重複配置（JSON/テキスト両方に同一座標指定・1基のみ建設）: ${t.type}@(${t.col},${t.row})`);
        continue;
      }
      placedCoords.add(coordKey);
      if (t.buildAt > 0) {
        this._delayedTowerQueue.push(t);
      } else {
        this.towers.push(new Tower(this, t.col, t.row, t.type));
      }
    }
    this._delayedTowerQueue.sort((a, b) => a.buildAt - b.buildAt);
    if (errors.length > 0) {
      alert('initialTowers エラー:\n' + errors.join('\n'));
    }
  }

  // ─── タワー配置 ──────────────────────────────────────────
  _canPlace(col, row, type) {
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return false;
    // prop衝突はbuildSpots権威より優先（run_sim.js/simulator.htmlと同一判定・2026-07-29）。
    // buildSpotが道路セル上に乗るのは仕様だが、propのフットプリント内は常に設置不可。
    if (this._propBlocked.has(`${col},${row}`)) return false;
    if (this.buildSpots.size > 0) {
      // buildSpots定義ステージ: buildSpotの権威を優先（pf.blocked=草マスでも建設可。propのみ上のガードで別途除外）
      if (!this.buildSpots.has(`${col},${row}`)) return false;
    } else {
      // buildSpots未定義の自由配置ステージ: walkable判定で道路・prop侵入を防ぐ
      if (!this.pf.isWalkable(col, row)) return false;
    }
    if (this.towers.some(t => t.col === col && t.row === row)) return false;
    return this.money >= TOWER_DEFS[type].cost;
  }

  _tryPlace(col, row, type) {
    if (!this._canPlace(col, row, type)) {
      // 建設不可でもポップアップ・入力ロックは残さない（2026-08-05）。
      // popupStateとUIScene側の暗幕がここで閉じ損ねると「ボタンを押しても何も
      // 起きず、ポップアップも消えない」という無反応状態になる。
      this._closePopup();
      return;
    }
    const cost = TOWER_DEFS[type].cost;
    this.money -= cost;
    this.towers.push(new Tower(this, col, row, type));
    this._playLog.push(`[BUILD]  t=${Math.round(this.scaledTime)}ms  type=${type}  pos=(${col},${row})  cost=${cost}  money=${this.money}`);
    audioSynth.coin();
    this._closePopup();
    // レーザー・パンチは設置後に方向選択ポップアップを表示
    if (type === 'laser' || type === 'punch') {
      const cam      = this.cameras.main;
      const HEADER_H = 8 + UI_H;
      const sx       = (col * CELL + CELL / 2 - cam.scrollX) * cam.zoom;
      const sy       = (row * CELL + CELL / 2 - cam.scrollY) * cam.zoom + HEADER_H;
      const event    = type === 'punch' ? 'openPunchDirPicker' : 'openDirectionPicker';
      // 建設ポップアップと同じ理由（UIScene側の別GameObjectのため）でpopupStateを
      // 立てる。input.enabledはupdate()で毎フレーム導出される（2026-08-05）
      this.popupState = { type: 'dirPicker', col, row };
      this.game.events.emit(event, { col, row, sx, sy });
    }
  }

  _sellTower(tower) {
    const refund = tower.sell;
    this.money += refund;
    this._playLog.push(`[SELL]   t=${Math.round(this.scaledTime)}ms  type=${tower.type}  pos=(${tower.col},${tower.row})  refund=${refund}  money=${this.money}`);
    tower.cleanup();
    this.towers = this.towers.filter(t => t !== tower);
    audioSynth.coin();
    this._closePopup();
  }

  _upgradeTower(tower) {
    const cost = tower.upgradeCost?.() ?? null;
    if (cost === null || this.money < cost) return;
    this.money -= cost;
    tower.upgrade();
    this._playLog.push(`[UPGRADE] t=${Math.round(this.scaledTime)}ms  ${tower.type}@(${tower.col},${tower.row})  Lv${tower.upgradeLevel}  cost=${cost}  money=${this.money}`);
    audioSynth.coin();
    this._closePopup();
  }

  // ─── ゾンビスポーン ──────────────────────────────────────
  // enemyDef: { type, hpMul?, speedMul?, damageMul?, rewardMul? }
  // 数値は ZOMBIE_BASE の基準値に倍率を掛けて確定する
  _spawnZombie(col, row, enemyDef, waveNum, leader = null) {
    if (this.zombies.length >= MAX_ZOMBIES) return null;
    const base = ZOMBIE_BASE[enemyDef.type] ?? ZOMBIE_BASE.salaryman;
    this._spawnSkinIdx = (this._spawnSkinIdx ?? 0) + 1;
    const skins = ['salaryman', 'worker', 'police'];
    const _skinByType = { kickboard: 'kickboard', burger: 'burger' };
    const skin = _skinByType[enemyDef.type] ?? enemyDef.skin ?? skins[this._spawnSkinIdx % skins.length];
    const def  = {
      type:   enemyDef.type,
      skin,
      hp:     Math.round(enemyDef.hp     != null ? enemyDef.hp     : base.hp     * (enemyDef.hpMul     ?? 1)),
      speed:             enemyDef.speed  != null ? enemyDef.speed  : base.speed  * (enemyDef.speedMul  ?? 1),
      damage: Math.round(enemyDef.damage != null ? enemyDef.damage : base.damage * (enemyDef.damageMul ?? 1)),
      reward: Math.round(enemyDef.reward != null ? enemyDef.reward : base.reward * (enemyDef.rewardMul ?? 1)),
      leashTo: enemyDef.leashTo,
      flying:           enemyDef.flying ?? base.flying ?? false,
      circleAt:         enemyDef.circleAt,
      circleRadius:     enemyDef.circleRadius,
      circleDurationMs: enemyDef.circleDurationMs,
    };
    const z = new Zombie(this, col, row, def, waveNum, leader);
    z._spawnOrigin = { col, row };
    z._killed      = false;
    this.spawnCount++;
    this._playLog.push(`[SPAWN]  t=${Math.round(this.scaledTime)}ms  id=${z._logId}  wave=${waveNum}  spawn=(${col},${row})  hp=${def.hp}  total=${this.spawnCount}`);
    const origOnDeath = z.onDeath;
    z.onDeath = () => {
      z._killed = true;
      this.money += z.reward;
      this.totalEarned += z.reward;
      this.killCount++;
      const src = z._lastHitBy;
      const srcStr = src ? `  by=${src.type}@(${src.col},${src.row})` : '';
      this._playLog.push(`[KILL]   t=${Math.round(this.scaledTime)}ms  id=${z._logId}  wave=${z.waveNum}  killCount=${this.killCount}${srcStr}`);
      if (origOnDeath) origOnDeath();
    };
    this.zombies.push(z);
    this._allSpawnedZombies.push(z);
    return z;
  }

  // ─── 勝敗判定 ────────────────────────────────────────────
  _checkWinLose() {
    if (this.gameState !== 'playing') return;
    if (this.relayPhase !== 'active') return;

    if (this.escort.reached || this.escort.state === 'exiting') {
      this._onEscortDone(true);
      return;
    }

    if (this.escort.defeated) {
      this._onEscortDone(false);
    }
  }

  // ─── NEXT WAVE カード ────────────────────────────────────
  _showDetourCard(name) {
    this._closeDetourCard();
    const cx = CANVAS_W / 2, cy = (CANVAS_H - UI_H) / 2;
    const objs = [];
    objs.push(this.add.rectangle(cx, cy, 400, 110, 0x1a0808, 0.93)
      .setScrollFactor(0).setDepth(65).setStrokeStyle(2, 0xff6600));
    objs.push(this.add.text(cx, cy - 22, `${name}が寄り道中！`, {
      fontSize: '28px', color: '#ff8833',
      fontFamily: '"Arial Black", Arial, sans-serif',
      stroke: '#000000', strokeThickness: 4,
    }).setScrollFactor(0).setDepth(66).setOrigin(0.5, 0.5));
    objs.push(this.add.text(cx, cy + 22, 'ゾンビが集中攻撃してくる！', {
      fontSize: '16px', color: '#ffcc88',
      fontFamily: 'Arial, sans-serif',
      stroke: '#000000', strokeThickness: 2,
    }).setScrollFactor(0).setDepth(66).setOrigin(0.5, 0.5));
    this._detourCardObjs = objs;
    this.time.delayedCall(2000, () => this._closeDetourCard());
  }

  _closeDetourCard() {
    (this._detourCardObjs ?? []).forEach(o => o.destroy());
    this._detourCardObjs = null;
  }

  _showNextWaveCard(completedIdx, nextName) {
    this._closeNextWaveCard();
    const cx = CANVAS_W / 2, cy = (CANVAS_H - UI_H) / 2;
    const objs = [];

    // 背景
    objs.push(this.add.rectangle(cx, cy, 420, 140, 0x050518, 0.93)
      .setScrollFactor(0).setDepth(65).setStrokeStyle(2, 0x4488ff));

    // WAVE クリアテキスト
    objs.push(this.add.text(cx, cy - 38, `WAVE ${completedIdx}  クリア！`, {
      fontSize: '22px', color: '#88ccff',
      fontFamily: '"Arial Black", Arial, sans-serif',
      stroke: '#000000', strokeThickness: 3,
    }).setScrollFactor(0).setDepth(66).setOrigin(0.5, 0.5));

    // NEXT → キャラ名
    objs.push(this.add.text(cx, cy + 10, `NEXT  →  ${nextName}！`, {
      fontSize: '32px', color: '#ffffff',
      fontFamily: '"Arial Black", Arial, sans-serif',
      stroke: '#001133', strokeThickness: 5,
    }).setScrollFactor(0).setDepth(66).setOrigin(0.5, 0.5));

    // タップヒント
    objs.push(this.add.text(cx, cy + 56, 'タップでスキップ', {
      fontSize: '13px', color: '#445566',
      fontFamily: 'Arial, sans-serif',
    }).setScrollFactor(0).setDepth(66).setOrigin(0.5, 0.5));

    this._nextWaveCardObjs = objs;
  }

  _closeNextWaveCard() {
    (this._nextWaveCardObjs ?? []).forEach(o => o.destroy());
    this._nextWaveCardObjs = null;
  }

  // ─── バナー表示 ──────────────────────────────────────────
  _showBanner(text) {
    this._closeBanner();
    const cx = CANVAS_W / 2, cy = (CANVAS_H - UI_H) / 2;
    this._bannerBg = this.add.rectangle(cx, cy, 380, 82, 0x0a0a2a, 0.92)
      .setScrollFactor(0).setDepth(65).setStrokeStyle(2, 0x4488ff);
    this._bannerText = this.add.text(cx, cy, text, {
      fontSize: '30px', color: '#ffffff', fontFamily: 'Arial, Helvetica, sans-serif',
      stroke: '#000000', strokeThickness: 4,
    }).setScrollFactor(0).setDepth(66).setOrigin(0.5, 0.5);
  }

  _closeBanner() {
    this._bannerText?.destroy(); this._bannerText = null;
    this._bannerBg?.destroy();   this._bannerBg   = null;
  }

  // ─── リザルト表示 ────────────────────────────────────────
  _showResult(msg, color, btnLabel, victory) {
    const total = this.escortDefs.length;
    const cx = CANVAS_W / 2, cy = (CANVAS_H - UI_H) / 2;

    // 星評価
    const stars = '★'.repeat(this.survivors) + '☆'.repeat(total - this.survivors);
    this.add.text(cx, cy - 65, stars, {
      fontSize: '38px', color: '#ffdd00', fontFamily: 'Arial, Helvetica, sans-serif',
      stroke: '#664400', strokeThickness: 3,
    }).setScrollFactor(0).setDepth(80).setOrigin(0.5);

    this.add.text(cx, cy - 15, msg, {
      fontSize: '40px', color, stroke: '#000000', strokeThickness: 6,
      fontFamily: 'Arial, Helvetica, sans-serif',
    }).setScrollFactor(0).setDepth(80).setOrigin(0.5);

    this.add.text(cx, cy + 38, `生還 ${this.survivors} / ${total}  撃破 ${this.killCount}`, {
      fontSize: '18px', color: '#cccccc', fontFamily: 'Arial, Helvetica, sans-serif',
    }).setScrollFactor(0).setDepth(80).setOrigin(0.5);

    const btn = this.add.text(cx, cy + 86, `[ ${btnLabel} ]`, {
      fontSize: '22px', color: '#ffffff', backgroundColor: '#334466',
      padding: { x: 16, y: 8 }, fontFamily: 'Arial, Helvetica, sans-serif',
    }).setScrollFactor(0).setDepth(80).setOrigin(0.5).setInteractive();
    btn.on('pointerdown', () => this.scene.restart());

    const btnSelect = this.add.text(cx, cy + 136, '[ ステージ選択へ ]', {
      fontSize: '18px', color: '#aaccff', backgroundColor: '#1a2a3a',
      padding: { x: 16, y: 8 }, fontFamily: 'Arial, Helvetica, sans-serif',
    }).setScrollFactor(0).setDepth(80).setOrigin(0.5).setInteractive();
    btnSelect.on('pointerover',  () => btnSelect.setStyle({ color: '#ffffff' }));
    btnSelect.on('pointerout',   () => btnSelect.setStyle({ color: '#aaccff' }));
    btnSelect.on('pointerdown',  () => {
      this.scene.stop('UIScene');
      this.scene.start('StageSelectScene');
    });
  }

  // ─── カメラ操作 ──────────────────────────────────────────
  _returnToEscort() {
    if (this.escort.alive && !this.escort.reached) {
      this.cameras.main.pan(this.escort.x, this.escort.y, 600, 'Power2');
    }
  }

  // ─── タイム・ズーム ──────────────────────────────────────
  _cycleTimeMode() {
    this.timeModeIdx = (this.timeModeIdx + 1) % TIME_SCALES.length;
    if (this.timeBtns) this._highlightTimeBtn();
  }

  _setZoom(idx) {
    this.zoomIdx = clamp(idx, 0, ZOOM_LEVELS.length - 1);
    this.cameras.main.setZoom(ZOOM_LEVELS[this.zoomIdx]);
  }

  _setWaveLabel(n, total) {
    this.waveLabel = `Wave ${n} / ${total}`;
    this._updateRelayHUD();
  }

  _updateRelayHUD() {
    const idx     = this.escortIdx;
    const total   = this.escortDefs.length;
    const name    = VARIANT_NAMES[this.escortDefs[idx].variant] ?? this.escortDefs[idx].variant;
    const survivors = `生還 ${this.survivors}/${total}`;
    this.registry.set('hud_relay', `${name} (${idx + 1}/${total})   ${survivors}`);
  }

  // ─── UI構築 ──────────────────────────────────────────────
  // HUD（所持金・ウェーブ・タイムモード・リレー状況・護衛ボタン）はUISceneへ移設済み。
  _buildUI() {
    this._buildDebugPanel();
  }

  // ─── デバッグパネル ──────────────────────────────────────
  _buildDebugPanel() {
    const px = CANVAS_W - 195, py = 35;
    this.debugObjects = [];

    const dbgFont = { fontFamily: 'Arial, Helvetica, sans-serif' };
    const bg = this.add.rectangle(px - 5, py - 5, 200, 230, 0x000000, 0.88)
      .setScrollFactor(0).setDepth(60).setOrigin(0, 0).setVisible(false);
    this.debugObjects.push(bg);

    this.timeBtns = [];
    ['⏸ 停止', '🐢 スロー', '▶ 通常'].forEach((lbl, i) => {
      const btn = this.add.text(px, py + i * 38, lbl, {
        ...dbgFont, fontSize: '17px',
        color: this.timeModeIdx === i ? '#ffff44' : '#aaaaaa',
        backgroundColor: '#223344', padding: { x: 8, y: 5 },
      }).setScrollFactor(0).setDepth(61).setInteractive().setVisible(false);
      btn.on('pointerdown', () => { this.timeModeIdx = i; this._highlightTimeBtn(); });
      this.timeBtns.push(btn);
      this.debugObjects.push(btn);
    });

    ['-', '+'].forEach((sign, i) => {
      const btn = this.add.text(px + i * 60, py + 120, `ズーム${sign}`, {
        ...dbgFont, fontSize: '16px', color: '#aaccff',
        backgroundColor: '#223344', padding: { x: 6, y: 5 },
      }).setScrollFactor(0).setDepth(61).setInteractive().setVisible(false);
      btn.on('pointerdown', () => this._setZoom(this.zoomIdx + (i === 0 ? -1 : 1)));
      this.debugObjects.push(btn);
    });

    const gridBtn = this.add.text(px, py + 158, 'グリッド: ON', {
      ...dbgFont, fontSize: '16px', color: '#aaccff',
      backgroundColor: '#223344', padding: { x: 6, y: 5 },
    }).setScrollFactor(0).setDepth(61).setInteractive().setVisible(false);
    gridBtn.on('pointerdown', () => {
      this.showGrid = !this.showGrid;
      gridBtn.setText(`グリッド: ${this.showGrid ? 'ON' : 'OFF'}`);
      this._drawMapStatic();
    });
    this.debugObjects.push(gridBtn);

    const pathBtn = this.add.text(px, py + 192, 'パス表示: OFF', {
      ...dbgFont, fontSize: '16px', color: '#aaccff',
      backgroundColor: '#223344', padding: { x: 6, y: 5 },
    }).setScrollFactor(0).setDepth(61).setInteractive().setVisible(false);
    pathBtn.on('pointerdown', () => {
      this.showPaths = !this.showPaths;
      pathBtn.setText(`パス表示: ${this.showPaths ? 'ON' : 'OFF'}`);
    });
    this.debugObjects.push(pathBtn);

    const dbgToggle = this.add.text(10, CANVAS_H - UI_H - 10, '⚙', {
      fontFamily: 'Arial, Helvetica, sans-serif',
      fontSize: '22px', color: '#667788', backgroundColor: '#1a2233',
      padding: { x: 8, y: 5 },
    }).setScrollFactor(0).setDepth(52).setOrigin(0, 1).setInteractive();
    dbgToggle.on('pointerdown', () => {
      this.debugOpen = !this.debugOpen;
      dbgToggle.setColor(this.debugOpen ? '#ffff44' : '#667788');
      this.debugObjects.forEach(o => o.setVisible(this.debugOpen));
    });
  }

  _highlightTimeBtn() {
    if (!this.timeBtns) return;
    this.timeBtns.forEach((btn, i) => {
      btn.setColor(i === this.timeModeIdx ? '#ffff44' : '#aaaaaa');
    });
  }

  _toggleDebug() {
    this.debugOpen = !this.debugOpen;
    if (this.debugObjects) this.debugObjects.forEach(o => o.setVisible(this.debugOpen));
    if (this.debugOpen && this._playLog?.length) console.log('=== PLAY LOG (途中) ===\n' + this._playLog.join('\n'));
  }
}

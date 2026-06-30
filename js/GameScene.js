const RELAY_INTERVAL    = 4000;  // インターバル時間（ms）
const VARIANT_NAMES     = { dad: 'お父さん', mom: 'お母さん', grandma: 'おばあちゃん' };

class GameScene extends Phaser.Scene {
  constructor() { super('GameScene'); }

  // ─── 初期化 ───────────────────────────────────────────────
  init({ stageData }) {
    this.stageData = stageData;
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
    this.money        = sd.startMoney;
    this.gameState    = 'playing';
    this.killCount    = 0;
    this.debugOpen    = false;
    this.showGrid     = false;
    this.showPaths    = false;

    // ポップアップ状態
    this.popupState      = null;
    this.popupObjects    = [];
    this._popupJustActed = false;

    // リレー状態
    this.escortDefs    = sd.escorts;
    this.escortIdx     = 0;
    this.survivors     = 0;
    this.relayPhase    = 'active';  // 'active' | 'interval' | 'done'
    this.intervalTimer = 0;
    this._bannerText   = null;
    this._bannerBg     = null;

    // 設置点
    this.buildSpots = new Set((sd.buildSpots || []).map(s => `${s.col},${s.row}`));

    // 経路探索（props の占有セルも obstacles と同等にブロック）
    this.pf = new Pathfinder(sd.grid.cols, sd.grid.rows, sd.obstacles);
    for (const prop of (sd.props || [])) {
      const def = PROP_DEFS[prop.type];
      if (!def) continue;
      for (let dc = 0; dc < def.cols; dc++) {
        for (let dr = 0; dr < def.rows; dr++) {
          this.pf.blocked.add(`${prop.col + dc},${prop.row + dr}`);
        }
      }
    }

    // 外周1マスを自動ブロック（128pxスプライトのはみ出し防止）
    // スポーン・護衛の全経路セルとその隣接セルは例外として通行可にする
    const _perimEx = new Set();
    for (const sp of (sd.zombieSpawns || [])) {
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
    this.pathGfx      = this.add.graphics().setDepth(0.5); // 導線帯：プロップ(2)・障害物(1)より下
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

    // 導線帯描画（depth 0.5：プロップ・障害物の下）
    this._drawEscortPathBand();

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
    this._onUiBuildPlace     = ({ col, row, type }) => { this._popupJustActed = true; this._tryPlace(col, row, type); this._closePopup(); };
    this._onUiLaserDir       = ({ col, row, dir }) => {
      const t = this.towers.find(t => t.col === col && t.row === row);
      if (t) t.direction = dir;
    };
    this.game.events.on('ui_cycleTime',      this._onUiCycleTime);
    this.game.events.on('ui_returnToEscort', this._onUiReturnToEscort);
    this.game.events.on('ui_buildPlace',     this._onUiBuildPlace);
    this.game.events.on('ui_laserDir',       this._onUiLaserDir);
    this.events.once('shutdown', () => {
      this.game.events.off('ui_cycleTime',      this._onUiCycleTime);
      this.game.events.off('ui_returnToEscort', this._onUiReturnToEscort);
      this.game.events.off('ui_buildPlace',     this._onUiBuildPlace);
      this.game.events.off('ui_laserDir',       this._onUiLaserDir);
      this.game.events.off('ui_resize',         this._onUiResize);
    });

    // UI構築
    this._buildUI();

    // 入力設定
    this._setupInput();

    // 最初の護衛者をスタート
    this._startEscort(0, 0);
  }

  // ─── リレー：護衛者起動 ───────────────────────────────────
  _startEscort(idx, timeOffset) {
    if (this.escort) this.escort.cleanup();

    const def     = this.escortDefs[idx];
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
    this.escort.onDetourStart    = () => this._showDetourCard(variantName);
    this.escort.onDetourActivate = () => { this.waveManager?.setSpawnMultiplier(0.5); };
    this.escort.onDetourEnd      = () => { this.waveManager?.setSpawnMultiplier(1.0); this._closeDetourCard(); };

    const cam = this.cameras.main;
    cam.pan(escPath[0]?.x ?? MAP_W / 2, escPath[0]?.y ?? MAP_H / 2, 600, 'Power2');

    // ウェーブマネージャー
    this.waveManager = new WaveManager(def.waves, this.stageData.zombieSpawns, this.escort);
    this.waveManager.onWaveStart((n, t) => this._setWaveLabel(n, t));
    this.waveManager.start(timeOffset);

    this._setWaveLabel(1, def.waves.length);
    this._updateRelayHUD();
    this.relayPhase = 'active';
  }

  // ─── リレー：護衛者終了処理 ───────────────────────────────
  _onEscortDone(reached) {
    if (reached) this.survivors++;

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
    this._showNextWaveCard(this.escortIdx + 1, nextName);
  }

  _activateNextEscort() {
    this.escortIdx++;
    this._closeBanner();
    this._closeNextWaveCard();
    this._startEscort(this.escortIdx, this.scaledTime);
  }

  _endGame() {
    const minS  = this.stageData.minSurvivors ?? 1;
    const total = this.escortDefs.length;
    if (this.survivors >= minS) {
      this.gameState = 'victory';
      audioSynth.stageClear();
      this._showResult('STAGE CLEAR!', '#ffff44', 'リスタート', true);
    } else {
      this.gameState = 'defeat';
      audioSynth.gameOver();
      this._showResult('GAME OVER', '#ff4444', 'もう一度', false);
    }
  }

  // ─── メインループ ─────────────────────────────────────────
  update(time, delta) {
    const scale = TIME_SCALES[this.timeModeIdx];
    const dt    = delta * scale;
    this._dt    = dt;  // _drawDynamic から矢印アニメに使う
    if (scale > 0) this.scaledTime += delta * scale;

    if (this.gameState === 'playing' && dt > 0) {
      this.escort.update(dt);

      // インターバル中はnullを渡しゾンビを既存パスで継続移動させる
      // フローフィールドを護衛の現在セルで更新（護衛がセルを移動したときのみ再計算）
      if (this.escort.alive && !this.escort.reached) {
        this.flowField.update(
          Math.floor(this.escort.x / CELL),
          Math.floor(this.escort.y / CELL)
        );
      }

      const escortTarget = this.relayPhase === 'active' ? this.escort : null;
      this.zombies.forEach(z => z.update(this.scaledTime, dt, escortTarget));
      this.towers.forEach(t  => t.update(this.scaledTime, dt, this.zombies, this.bullets));

      this.bullets = this.bullets.filter(b => b.active);
      this.bullets.forEach(b => b.update(dt));

      this.waveManager.update(this.scaledTime, (col, row, def, wn, leader) => this._spawnZombie(col, row, def, wn, leader));

      // スポーンカウントダウン更新（次に湧くスポーン地点だけに表示）
      if (this._spawnCountdownTexts?.length) {
        const warning = this.waveManager.getWarning(this.scaledTime);
        const spawns  = this.stageData.zombieSpawns || [];
        this._spawnCountdownTexts.forEach((txt, i) => {
          const sp = spawns[i];
          if (warning && sp.col === warning.spawn.col && sp.row === warning.spawn.row) {
            txt.setText(String(Math.ceil(warning.remaining / 1000)));
          } else {
            txt.setText('');
          }
        });
      }

      this.zombies.forEach(z => { if (!z.alive) z.cleanup(); });
      this.zombies = this.zombies.filter(z => z.alive);

      // インターバルカウントダウン
      if (this.relayPhase === 'interval') {
        this.intervalTimer -= delta;  // リアルタイムで計測
        if (this.intervalTimer <= 0) this._activateNextEscort();
      }

      if (this.relayPhase === 'active') this._checkWinLose();
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

    // セル別地面上書き
    const cellGrounds = this.stageData.ground_cells || [];
    const byType = {};
    for (const cell of cellGrounds) {
      const ck = `ground_${cell.type}`;
      if (this.textures.exists(ck)) {
        this.add.image(cell.col * CELL + CELL / 2, cell.row * CELL + CELL / 2, ck)
          .setDisplaySize(CELL, CELL).setDepth(-2);
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

    // 交差セットを構築（h×v の全組み合わせ）
    const hRoads = roads.filter(r => r.axis === 'h');
    const vRoads = roads.filter(r => r.axis === 'v');
    const intersections = new Set();
    for (const h of hRoads) {
      for (const v of vRoads) {
        if (v.line >= h.from && v.line <= h.to &&
            h.line >= v.from && h.line <= v.to) {
          intersections.add(`${v.line},${h.line}`); // "col,row"
        }
      }
    }

    // 道路タイル描画（交差セルは重複しないよう1度だけ）
    const roadKey = 'ground_road';
    const hasTex  = this.textures.exists(roadKey);
    const fbGfx   = hasTex ? null : this.add.graphics().setDepth(-1);
    if (fbGfx) fbGfx.fillStyle(0x888888, 1);

    const drawn = new Set();
    for (const road of roads) {
      for (let i = road.from; i <= road.to; i++) {
        const col = road.axis === 'h' ? i        : road.line;
        const row = road.axis === 'h' ? road.line : i;
        const ck  = `${col},${row}`;
        if (drawn.has(ck)) continue;
        drawn.add(ck);
        if (hasTex) {
          this.add.image(col * CELL + CELL / 2, row * CELL + CELL / 2, roadKey)
            .setDisplaySize(CELL, CELL)
            .setDepth(-1);
        } else {
          fbGfx.fillRect(col * CELL, row * CELL, CELL, CELL);
        }
      }
    }

    // 白線（コードで描画）
    const dashGfx = this.add.graphics().setDepth(-1);
    dashGfx.lineStyle(6, 0xebebE1, 1);
    this._drawRoadDashes(dashGfx, roads, intersections);
  }

  // ─── 道路白線（破線、交差セルはスキップ・中点アンカー対称） ─
  _drawRoadDashes(g, roads, intersections) {
    const DASH = 28, GAP = 24, THICK = 6;
    const cycle = DASH + GAP;

    // セグメント [startPx, endPx] の中点にダッシュ中心を合わせて描画
    // → 左端と右端（上端と下端）の途切れ量が等しくなり対称に見える
    const drawSegment = (axis, fixedPos, startPx, endPx) => {
      if (endPx <= startPx) return;
      const mid           = (startPx + endPx) / 2;
      const virtDashStart = mid - DASH / 2;
      const n             = Math.floor((startPx - virtDashStart) / cycle);
      let   pos           = virtDashStart + n * cycle;

      g.lineStyle(THICK, 0xebebE1, 1);
      while (pos < endPx) {
        const ds = Math.max(pos, startPx);
        const de = Math.min(pos + DASH, endPx);
        if (ds < de) {
          if (axis === 'h') g.lineBetween(ds, fixedPos, de, fixedPos);
          else               g.lineBetween(fixedPos, ds, fixedPos, de);
        }
        pos += cycle;
      }
    };

    for (const road of roads) {
      const isH      = road.axis === 'h';
      const fixedPos = road.line * CELL + CELL / 2;

      // この道路上の交差点位置（from～to 範囲内、昇順）
      const interPoints = [];
      for (const key of intersections) {
        const [col, row] = key.split(',').map(Number);
        const along = isH ? col : row;
        const fixed = isH ? row : col;
        if (fixed === road.line && along >= road.from && along <= road.to) {
          interPoints.push(along);
        }
      }
      interPoints.sort((a, b) => a - b);

      // 交差点でセグメント分割し、各セグメントを独立して中点アンカー描画
      let segFrom = road.from;
      for (const inter of [...interPoints, null]) {
        const segTo = inter !== null ? inter - 1 : road.to;
        if (segFrom <= segTo) {
          drawSegment(road.axis, fixedPos, segFrom * CELL, (segTo + 1) * CELL);
        }
        if (inter !== null) segFrom = inter + 1;
      }
    }
  }

  // ─── デカールレイヤー（depth 0、当たり判定なし） ──────────────
  _drawDecalLayer() {
    // スポーン地点にお墓＋カウントダウンテキストを表示
    const GRAVE_KEYS  = ['decal_RIP墓', 'decal_Z墓'];
    const GRAVE_SIZES = { 'decal_RIP墓': [64, 64], 'decal_Z墓': [64, 74] };
    this._spawnCountdownTexts = [];
    for (const [i, sp] of (this.stageData.zombieSpawns || []).entries()) {
      const cx  = sp.col * CELL + CELL / 2;
      const cy  = sp.row * CELL + CELL / 2;
      const key = GRAVE_KEYS[i % GRAVE_KEYS.length];
      const [gw, gh] = GRAVE_SIZES[key];
      this.add.image(cx, cy, key).setDisplaySize(gw, gh).setDepth(1);
      const txt = this.add.text(cx + 26, cy - 26, '', {
        fontSize: '16px', fontStyle: 'bold',
        color: '#ffffff', stroke: '#000000', strokeThickness: 3,
      }).setOrigin(0.5).setDepth(2);
      this._spawnCountdownTexts.push(txt);
    }

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

  // ─── 導線帯描画（一度だけ・プロップ下） ────────────────────
  _drawEscortPathBand() {
    const g = this.pathGfx;
    g.clear();
    for (const esc of (this.stageData.escorts ?? [])) {
      const path = esc.path ?? [];
      if (path.length < 2) continue;
      // セル塗り（薄い青）
      g.fillStyle(0x44aaff, 0.20);
      for (const p of path) {
        g.fillRect(p.col * CELL + 3, p.row * CELL + 3, CELL - 6, CELL - 6);
      }
      // 中心線（点線風：区間前半のみ描画）
      g.lineStyle(3, 0x44aaff, 0.35);
      for (let i = 0; i < path.length - 1; i++) {
        const ax = path[i].col * CELL + CELL / 2, ay = path[i].row * CELL + CELL / 2;
        const bx = path[i+1].col * CELL + CELL / 2, by = path[i+1].row * CELL + CELL / 2;
        const mx = (ax + bx) / 2, my = (ay + by) / 2;
        g.lineBetween(ax, ay, mx, my);
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
        g.fillStyle(0xffee44, 0.18 + 0.14 * pulse);
        g.fillRect(col * CELL + 2, row * CELL + 2, CELL - 4, CELL - 4);
        g.lineStyle(2, 0xffee44, 0.65 + 0.35 * pulse);
        g.strokeRect(col * CELL + 5, row * CELL + 5, CELL - 10, CELL - 10);
        g.fillStyle(0xffee44, 0.9);
        g.fillCircle(cx, cy, 6);
      } else {
        g.fillStyle(0xffee44, 0.55);
        g.fillCircle(cx, cy, 4);
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

    // NEXT WAVEカード表示中のタップ → スキップ
    if (this.relayPhase === 'interval' && this._nextWaveCardObjs) {
      this._activateNextEscort();
      return;
    }

    if (this._popupJustActed) {
      this._popupJustActed = false;
      return;
    }

    if (this.popupState) {
      this._closePopup();
      return;
    }

    const col = Math.floor(p.worldX / CELL);
    const row = Math.floor(p.worldY / CELL);
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return;

    const tower = this.towers.find(t => t.col === col && t.row === row);
    if (tower) {
      this._openSellMenu(tower);
      return;
    }

    // プロップ上のタップ → バツマーク＋効果音
    if (this.propCells?.has(`${col},${row}`)) {
      this._showPlaceFail(col, row);
      return;
    }

    const onSpot = this.buildSpots.size === 0 || this.buildSpots.has(`${col},${row}`);
    if (onSpot) {
      this._openBuildMenu(col, row);
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
    this.timeModeIdx = 1;  // 0.25倍スロー
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

    this.game.events.emit('openBuildMenu', { col, row, sx, sy, cellHalfPx, money: this.money });
  }

  // ─── 売却メニュー ────────────────────────────────────────
  _openSellMenu(tower) {
    this._closePopup();

    const cam = this.cameras.main;
    const sx  = (tower.x - cam.scrollX) * cam.zoom;
    const sy  = (tower.y - cam.scrollY) * cam.zoom;

    const popW = 152, popH = 72;
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

    const titleText = this.add.text(px + popW / 2, py + 8, `${def.label}タワー`, {
      fontSize: '14px', fontFamily: 'Arial, Helvetica, sans-serif',
      color: def.textColor, stroke: '#000000', strokeThickness: 2,
    }).setScrollFactor(0).setDepth(71).setOrigin(0.5, 0);
    this.popupObjects.push(titleText);

    const sbW = 128, sbH = 30;
    const sbx = px + (popW - sbW) / 2;
    const sby = py + popH - sbH - 8;

    const sellBtn = this.add.rectangle(sbx + sbW / 2, sby + sbH / 2, sbW, sbH, 0x551111, 0.9)
      .setScrollFactor(0).setDepth(71).setStrokeStyle(1.5, 0xff4444, 0.8).setInteractive();
    sellBtn.on('pointerover',  () => sellBtn.setFillStyle(0x882222, 0.9));
    sellBtn.on('pointerout',   () => sellBtn.setFillStyle(0x551111, 0.9));
    sellBtn.on('pointerdown',  () => {
      this._popupJustActed = true;
      this._sellTower(tower);
    });
    this.popupObjects.push(sellBtn);

    const sellText = this.add.text(sbx + sbW / 2, sby + sbH / 2, `売却  +¥${tower.sell}`, {
      fontSize: '14px', fontFamily: 'Arial, Helvetica, sans-serif',
      color: '#ff9999', stroke: '#000000', strokeThickness: 2,
    }).setScrollFactor(0).setDepth(72).setOrigin(0.5, 0.5);
    this.popupObjects.push(sellText);
  }

  // ─── ポップアップを閉じる ────────────────────────────────
  _closePopup() {
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
  }

  // ─── タワー配置 ──────────────────────────────────────────
  _canPlace(col, row, type) {
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return false;
    if (!this.pf.isWalkable(col, row)) return false;
    if (this.buildSpots.size > 0 && !this.buildSpots.has(`${col},${row}`)) return false;
    if (this.towers.some(t => t.col === col && t.row === row)) return false;
    return this.money >= TOWER_DEFS[type].cost;
  }

  _tryPlace(col, row, type) {
    if (!this._canPlace(col, row, type)) return;
    this.money -= TOWER_DEFS[type].cost;
    this.towers.push(new Tower(this, col, row, type));
    audioSynth.coin();
    this._closePopup();
    // レーザー・パンチは設置後に方向選択ポップアップを表示
    if (type === 'laser' || type === 'punch') {
      const cam      = this.cameras.main;
      const HEADER_H = 8 + UI_H;
      const sx       = (col * CELL + CELL / 2 - cam.scrollX) * cam.zoom;
      const sy       = (row * CELL + CELL / 2 - cam.scrollY) * cam.zoom + HEADER_H;
      const event    = type === 'punch' ? 'openPunchDirPicker' : 'openDirectionPicker';
      this.game.events.emit(event, { col, row, sx, sy });
    }
  }

  _sellTower(tower) {
    this.money += tower.sell;
    tower.cleanup();
    this.towers = this.towers.filter(t => t !== tower);
    audioSynth.coin();
    this._closePopup();
  }

  // ─── ゾンビスポーン ──────────────────────────────────────
  // enemyDef: { type, hpMul?, speedMul?, damageMul?, rewardMul? }
  // 数値は ZOMBIE_BASE の基準値に倍率を掛けて確定する
  _spawnZombie(col, row, enemyDef, waveNum, leader = null) {
    if (this.zombies.length >= MAX_ZOMBIES) return null;
    const base = ZOMBIE_BASE[enemyDef.type] ?? ZOMBIE_BASE.normal;
    this._spawnSkinIdx = (this._spawnSkinIdx ?? 0) + 1;
    const skins = ['salaryman', 'worker', 'police'];
    const skin  = skins[this._spawnSkinIdx % skins.length];
    const def  = {
      type:   enemyDef.type,
      skin,
      hp:     Math.round(enemyDef.hp     != null ? enemyDef.hp     : base.hp     * (enemyDef.hpMul     ?? 1)),
      speed:             enemyDef.speed  != null ? enemyDef.speed  : base.speed  * (enemyDef.speedMul  ?? 1),
      damage: Math.round(enemyDef.damage != null ? enemyDef.damage : base.damage * (enemyDef.damageMul ?? 1)),
      reward: Math.round(enemyDef.reward != null ? enemyDef.reward : base.reward * (enemyDef.rewardMul ?? 1)),
    };
    const z = new Zombie(this, col, row, def, waveNum, leader);
    const origOnDeath = z.onDeath;
    z.onDeath = () => {
      this.money += z.reward;
      this.killCount++;
      if (origOnDeath) origOnDeath();
    };
    this.zombies.push(z);
    return z;
  }

  // ─── 勝敗判定 ────────────────────────────────────────────
  _checkWinLose() {
    if (this.gameState !== 'playing') return;
    if (this.relayPhase !== 'active') return;

    if (this.escort.reached) {
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
  }
}

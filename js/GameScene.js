class GameScene extends Phaser.Scene {
  constructor() { super('GameScene'); }

  // ─── 初期化 ───────────────────────────────────────────────
  init({ stageData }) {
    this.stageData = stageData;
  }

  create() {
    const sd = this.stageData;

    // ゲーム状態
    this.scaledTime   = 0;
    this.timeModeIdx  = 2;   // TIME_SCALES index: 0=停止, 1=スロー, 2=通常
    this.zoomIdx      = DEFAULT_ZOOM_IDX;
    this.money        = sd.startMoney;
    this.selectedType = null;
    this.hoverCell    = { col: -1, row: -1 };
    this.gameState    = 'playing';
    this.killCount    = 0;
    this.debugOpen    = false;
    this.showGrid     = true;
    this.showPaths    = false;
    this.lastInteractionTime = 0;

    // 経路探索
    this.pf = new Pathfinder(sd.grid.cols, sd.grid.rows, sd.obstacles);

    // 護衛
    const escStart = sd.escort.start;
    const escGoal  = sd.escort.goal;
    const escCells = this.pf.find(escStart.col, escStart.row, escGoal.col, escGoal.row);
    const escPath  = escCells ? this.pf.toPixelPath(escCells) : [];
    this.escort    = new Escort(escPath, sd.escort);

    // エンティティ
    this.zombies = [];
    this.towers  = [];
    this.bullets = [];

    // ウェーブ管理
    this.waveManager = new WaveManager(sd.waves, sd.zombieSpawns);
    this.waveManager.onWaveStart((n, t) => this._setWaveLabel(n, t));
    this.waveManager.onAllDone(() => this._onAllWavesDone());
    this._setWaveLabel(1, sd.waves.length);

    // グラフィクスレイヤー
    this.mapGfx      = this.add.graphics().setDepth(0);
    this.dynGfx      = this.add.graphics().setDepth(3);
    this.hudGfx      = this.add.graphics().setScrollFactor(0).setDepth(10);
    this.indicatorGfx = this.add.graphics().setScrollFactor(0).setDepth(11);

    // 静的マップ描画（一度だけ）
    this._drawMapStatic();

    // カメラ設定
    const cam = this.cameras.main;
    cam.setBounds(0, 0, MAP_W, MAP_H);
    cam.setZoom(ZOOM_LEVELS[this.zoomIdx]);
    cam.centerOn(escPath[0]?.x ?? MAP_W / 2, escPath[0]?.y ?? MAP_H / 2);

    // UI構築
    this._buildUI();

    // 入力設定
    this._setupInput();

    // ウェーブ開始
    this.waveManager.start();
  }

  // ─── メインループ ─────────────────────────────────────────
  update(time, delta) {
    const scale = TIME_SCALES[this.timeModeIdx];
    const dt    = delta * scale;
    if (scale > 0) this.scaledTime += delta * scale;

    if (this.gameState === 'playing' && dt > 0) {
      this.escort.update(dt);

      this.zombies.forEach(z => z.update(this.scaledTime, dt, this.escort));
      this.towers.forEach(t  => t.update(this.scaledTime, dt, this.zombies, this.bullets));

      this.bullets = this.bullets.filter(b => b.active);
      this.bullets.forEach(b => b.update(dt));

      this.waveManager.update(this.scaledTime, (col, row, def, wn) => this._spawnZombie(col, row, def, wn));

      this._checkWinLose();
    }

    // 描画（停止中も実行）
    this._drawDynamic();
    this._drawHUD();
    this._drawIndicators();

    // カメラ自動復帰（護衛追跡モード）
    if (this.gameState === 'playing' && this.lastInteractionTime > 0) {
      if (time - this.lastInteractionTime > AUTO_RETURN_DELAY) {
        this._returnToEscort();
        this.lastInteractionTime = 0;
      }
    }
  }

  // ─── 静的マップ描画 ───────────────────────────────────────
  _drawMapStatic() {
    const g = this.mapGfx;
    g.clear();

    // 背景
    g.fillStyle(0x1a1a2e, 1);
    g.fillRect(0, 0, MAP_W, MAP_H);

    // グリッド線
    if (this.showGrid) {
      g.lineStyle(1, 0x2a2a4a, 1);
      for (let c = 0; c <= COLS; c++) g.lineBetween(c * CELL, 0, c * CELL, MAP_H);
      for (let r = 0; r <= ROWS; r++) g.lineBetween(0, r * CELL, MAP_W, r * CELL);
    }

    // 遮蔽物
    g.fillStyle(0x445566, 1);
    for (const obs of this.stageData.obstacles) {
      g.fillRect(obs.col * CELL + 2, obs.row * CELL + 2, CELL - 4, CELL - 4);
      g.lineStyle(1.5, 0x334455, 1);
      g.strokeRect(obs.col * CELL + 2, obs.row * CELL + 2, CELL - 4, CELL - 4);
    }

    // スタート・ゴールマーカー
    const s = this.stageData.escort.start;
    const g2 = this.stageData.escort.goal;
    this.add.graphics().setDepth(1)
      .fillStyle(0x00ff88, 0.22).fillRect(s.col * CELL, s.row * CELL, CELL, CELL)
      .fillStyle(0xffff00, 0.22).fillRect(g2.col * CELL, g2.row * CELL, CELL, CELL);

    // ゾンビスポーンマーカー
    const sg = this.add.graphics().setDepth(1);
    sg.lineStyle(2, 0xff3300, 0.6);
    for (const sp of this.stageData.zombieSpawns) {
      sg.strokeRect(sp.col * CELL + 2, sp.row * CELL + 2, CELL - 4, CELL - 4);
    }
  }

  // ─── 動的描画 ─────────────────────────────────────────────
  _drawDynamic() {
    const g = this.dynGfx;
    g.clear();

    // デバッグ：護衛の経路
    if (this.showPaths && this.escort.path.length > 1) {
      g.lineStyle(2, 0xffff00, 0.35);
      for (let i = 0; i < this.escort.path.length - 1; i++) {
        const a = this.escort.path[i], b = this.escort.path[i + 1];
        g.lineBetween(a.x, a.y, b.x, b.y);
      }
    }

    // タワー
    this.towers.forEach(t => t.draw(g));

    // タワー配置プレビュー（ホバー中）
    if (this.selectedType && this.hoverCell.col >= 0) {
      const { col, row } = this.hoverCell;
      const canPlace = this._canPlace(col, row);
      const def = TOWER_DEFS[this.selectedType];
      const cx = col * CELL + CELL / 2, cy = row * CELL + CELL / 2;
      g.fillStyle(def.color, canPlace ? 0.35 : 0.15);
      g.fillRect(col * CELL + 4, row * CELL + 4, CELL - 8, CELL - 8);
      if (canPlace) {
        g.lineStyle(2, def.color, 0.6);
        g.strokeCircle(cx, cy, def.range * CELL);
      }
    }

    // ゾンビ
    this.zombies.forEach(z => z.draw(g));

    // 護衛
    this.escort.draw(g);

    // 弾丸
    this.bullets.forEach(b => b.draw(g));
  }

  // ─── HUD描画 ─────────────────────────────────────────────
  _drawHUD() {
    // テキストは Phaser.Text オブジェクト（buildUIで作成済み）で更新
    if (this.moneyText) this.moneyText.setText(`¥ ${this.money}`);
    if (this.waveText)  this.waveText.setText(this.waveLabel);
    if (this.timeText)  this.timeText.setText(TIME_LABELS[this.timeModeIdx]);

    // 護衛HPバーをHUD固定で追加表示
    const g = this.hudGfx;
    g.clear();

    // 下部パネル背景
    g.fillStyle(0x0a0a1a, 0.92);
    g.fillRect(0, CANVAS_H - UI_H, CANVAS_W, UI_H);
    g.lineStyle(1, 0x334455, 1);
    g.lineBetween(0, CANVAS_H - UI_H, CANVAS_W, CANVAS_H - UI_H);

    // タワーボタン境界線
    for (let i = 1; i < 3; i++) {
      g.lineStyle(1, 0x334455, 1);
      g.lineBetween(i * (CANVAS_W / 3), CANVAS_H - UI_H, i * (CANVAS_W / 3), CANVAS_H);
    }

    // 選択タワーのハイライト
    if (this.selectedType) {
      const idx  = Object.keys(TOWER_DEFS).indexOf(this.selectedType);
      const def  = TOWER_DEFS[this.selectedType];
      const bx   = idx * (CANVAS_W / 3);
      g.fillStyle(def.color, 0.12);
      g.fillRect(bx, CANVAS_H - UI_H, CANVAS_W / 3, UI_H);
      g.lineStyle(2, def.color, 0.8);
      g.strokeRect(bx, CANVAS_H - UI_H, CANVAS_W / 3, UI_H);
    }

    // ゲームオーバー / ステージクリアオーバーレイ
    if (this.gameState === 'defeat' || this.gameState === 'victory') {
      g.fillStyle(0x000000, 0.6);
      g.fillRect(0, 0, CANVAS_W, CANVAS_H);
    }
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
      // ワールド座標 → スクリーン中央からのベクトル
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

    // ゾンビが画面外にいるとき
    for (const z of this.zombies) {
      if (!z.alive) continue;
      if (z.x >= vl && z.x <= vr && z.y >= vt && z.y <= vb) continue;
      drawArrow(z.x, z.y, 0x22cc44);
    }

    // 護衛が画面外にいるとき（赤 ❗）
    if (this.escort.alive && !this.escort.reached) {
      if (this.escort.x < vl || this.escort.x > vr || this.escort.y < vt || this.escort.y > vb) {
        drawArrow(this.escort.x, this.escort.y, 0xff4444);
      }
    }
  }

  // ─── 入力設定 ─────────────────────────────────────────────
  _setupInput() {
    this.input.addPointer(1);  // タッチ2点対応

    let downX = 0, downY = 0, isDrag = false;
    this.pinching    = false;
    this.pinchStart  = { dist: 0, zoom: 1 };

    this.input.on('pointerdown', (p) => {
      downX = p.x; downY = p.y; isDrag = false;
      this.lastInteractionTime = this.time.now;
    });

    this.input.on('pointermove', (p) => {
      this.lastInteractionTime = this.time.now;

      // ピンチズーム
      const p2 = this.input.pointer2;
      if (p2.isDown) {
        const dx   = p.x - p2.x, dy = p.y - p2.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (!this.pinching) {
          this.pinching   = true;
          this.pinchStart = { dist, zoom: this.cameras.main.zoom };
        } else {
          const nz = clamp(
            this.pinchStart.zoom * (dist / this.pinchStart.dist),
            ZOOM_LEVELS[0], ZOOM_LEVELS[ZOOM_LEVELS.length - 1]
          );
          this.cameras.main.setZoom(nz);
        }
        return;
      }
      this.pinching = false;

      // UI ゾーン（下部パネル）ではホバー無効
      if (p.y > CANVAS_H - UI_H) {
        this.hoverCell = { col: -1, row: -1 };
        return;
      }

      this.hoverCell = {
        col: Math.floor(p.worldX / CELL),
        row: Math.floor(p.worldY / CELL),
      };

      // ドラッグでカメラパン
      if (p.isDown) {
        const ddx = Math.abs(p.x - downX), ddy = Math.abs(p.y - downY);
        if (ddx > 8 || ddy > 8) {
          isDrag = true;
          this.cameras.main.scrollX -= p.velocity.x / this.cameras.main.zoom;
          this.cameras.main.scrollY -= p.velocity.y / this.cameras.main.zoom;
        }
      }
    });

    this.input.on('pointerup', (p) => {
      this.pinching = false;
      if (!isDrag) this._handleTap(p);
      isDrag = false;
    });

    // ホイールズーム
    this.input.on('wheel', (p, go, dx, dy) => {
      this.zoomIdx = clamp(this.zoomIdx + (dy > 0 ? -1 : 1), 0, ZOOM_LEVELS.length - 1);
      this.cameras.main.setZoom(ZOOM_LEVELS[this.zoomIdx]);
      this.lastInteractionTime = this.time.now;
    });

    // キーボードショートカット
    this.input.keyboard.on('keydown', (e) => {
      if (e.key === 'Escape')      this.selectedType = null;
      if (e.key === 'd' || e.key === 'D') this._toggleDebug();
      if (e.key === 'g' || e.key === 'G') { this.showGrid = !this.showGrid; this._drawMapStatic(); }
      if (e.key === 'p' || e.key === 'P') this.showPaths = !this.showPaths;
      if (e.key === ' ')           this._cycleTimeMode();
      if (e.key === 'h' || e.key === 'H') this._returnToEscort();
    });
  }

  // ─── タップ処理 ──────────────────────────────────────────
  _handleTap(p) {
    if (p.y > CANVAS_H - UI_H) return;  // UIゾーンはボタンイベントで処理済み

    const col = Math.floor(p.worldX / CELL);
    const row = Math.floor(p.worldY / CELL);

    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return;

    if (this.selectedType) {
      this._tryPlace(col, row);
    } else {
      // タワーを右クリック or タップで選択/売却
      const tower = this.towers.find(t => t.col === col && t.row === row);
      if (tower) {
        if (p.rightButtonReleased()) {
          this._sellTower(tower);
        } else {
          this.towers.forEach(t => t.selected = false);
          tower.selected = !tower.selected;
        }
      }
    }
  }

  // ─── タワー配置 ──────────────────────────────────────────
  _canPlace(col, row) {
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return false;
    if (!this.pf.isWalkable(col, row)) return false;  // 遮蔽物
    if (this.towers.some(t => t.col === col && t.row === row)) return false;
    const def = TOWER_DEFS[this.selectedType];
    return this.money >= def.cost;
  }

  _tryPlace(col, row) {
    if (!this._canPlace(col, row)) return;
    const def = TOWER_DEFS[this.selectedType];
    this.money -= def.cost;
    const tower = new Tower(col, row, this.selectedType);
    this.towers.push(tower);
    audioSynth.coin();
  }

  _sellTower(tower) {
    this.money += tower.sell;
    this.towers = this.towers.filter(t => t !== tower);
    audioSynth.coin();
  }

  // ─── ゾンビスポーン ──────────────────────────────────────
  _spawnZombie(col, row, def, waveNum) {
    const z = new Zombie(col, row, def, this.pf, waveNum);
    // onDeath はWaveManagerが注入するが、報酬もここで加算
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

    if (!this.escort.alive) {
      this.gameState = 'defeat';
      audioSynth.gameOver();
      this._showResult('GAME OVER', '#ff4444', 'もう一度');
      return;
    }

    if (this.escort.reached && this.waveManager.allDone) {
      // 全ウェーブ完了かつ護衛が無事到達 → 勝利
    }
  }

  _onAllWavesDone() {
    if (this.escort.alive && this.escort.reached) {
      this._victory();
    }
    // 護衛がまだ歩いている場合は reached になった時点で _checkWinLose が処理
  }

  _victory() {
    if (this.gameState !== 'playing') return;
    this.gameState = 'victory';
    audioSynth.stageClear();
    this._showResult('STAGE CLEAR!', '#ffff44', 'リスタート');
  }

  _showResult(msg, color, btnLabel) {
    const cx = CANVAS_W / 2, cy = (CANVAS_H - UI_H) / 2;
    this.add.text(cx, cy - 20, msg, {
      fontSize: '42px', color, stroke: '#000000', strokeThickness: 6
    }).setScrollFactor(0).setDepth(80).setOrigin(0.5);

    const sub = this.add.text(cx, cy + 40, `撃破数: ${this.killCount}`, {
      fontSize: '18px', color: '#cccccc'
    }).setScrollFactor(0).setDepth(80).setOrigin(0.5);

    const btn = this.add.text(cx, cy + 90, `[ ${btnLabel} ]`, {
      fontSize: '22px', color: '#ffffff', backgroundColor: '#334466',
      padding: { x: 16, y: 8 }
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
  }

  // ─── UI構築 ──────────────────────────────────────────────
  _buildUI() {
    const types = Object.keys(TOWER_DEFS);
    this.towerBtns = {};
    const bw = Math.floor(CANVAS_W / 3);
    const by = CANVAS_H - UI_H;

    types.forEach((type, i) => {
      const def = TOWER_DEFS[type];
      const bx  = i * bw + bw / 2;

      const bg = this.add.rectangle(i * bw, by, bw, UI_H, 0x0a0a1a, 0)
        .setScrollFactor(0).setDepth(51).setOrigin(0, 0).setInteractive();
      const lbl = this.add.text(bx, by + 20, def.label, {
        fontSize: '15px', color: def.textColor, fontStyle: 'bold'
      }).setScrollFactor(0).setDepth(52).setOrigin(0.5, 0);
      const cost = this.add.text(bx, by + 42, `¥${def.cost}`, {
        fontSize: '13px', color: '#aaaaaa'
      }).setScrollFactor(0).setDepth(52).setOrigin(0.5, 0);
      const rng = this.add.text(bx, by + 60, `射程 ${def.range}C`, {
        fontSize: '11px', color: '#667788'
      }).setScrollFactor(0).setDepth(52).setOrigin(0.5, 0);

      bg.on('pointerdown', () => {
        this.selectedType = this.selectedType === type ? null : type;
      });
      this.towerBtns[type] = { bg, lbl, cost, rng };
    });

    // 所持金
    this.moneyText = this.add.text(8, 8, `¥ ${this.money}`, {
      fontSize: '18px', color: '#ffee44', stroke: '#000000', strokeThickness: 3
    }).setScrollFactor(0).setDepth(52);

    // ウェーブ表示
    this.waveText = this.add.text(CANVAS_W / 2, 8, this.waveLabel, {
      fontSize: '16px', color: '#ffffff', stroke: '#000000', strokeThickness: 3
    }).setScrollFactor(0).setDepth(52).setOrigin(0.5, 0);

    // タイムモード表示
    this.timeText = this.add.text(CANVAS_W - 8, 8, TIME_LABELS[this.timeModeIdx], {
      fontSize: '13px', color: '#aaaaaa'
    }).setScrollFactor(0).setDepth(52).setOrigin(1, 0).setInteractive();
    this.timeText.on('pointerdown', () => this._cycleTimeMode());

    // 護衛へ戻るボタン
    const homeBtn = this.add.text(CANVAS_W - 8, CANVAS_H - UI_H - 8, '⌂ 護衛', {
      fontSize: '14px', color: '#aaccff', backgroundColor: '#1a2a3a',
      padding: { x: 8, y: 4 }
    }).setScrollFactor(0).setDepth(52).setOrigin(1, 1).setInteractive();
    homeBtn.on('pointerdown', () => {
      this._returnToEscort();
      this.lastInteractionTime = 0;
    });

    // デバッグパネル
    this._buildDebugPanel();
  }

  // ─── デバッグパネル ──────────────────────────────────────
  _buildDebugPanel() {
    const px = CANVAS_W - 195, py = 35;
    this.debugObjects = [];

    const bg = this.add.rectangle(px - 5, py - 5, 190, 200, 0x000000, 0.82)
      .setScrollFactor(0).setDepth(60).setOrigin(0, 0).setVisible(false);
    this.debugObjects.push(bg);

    // タイムボタン
    this.timeBtns = [];
    ['⏸ 停止', '🐢 スロー', '▶ 通常'].forEach((lbl, i) => {
      const btn = this.add.text(px, py + i * 32, lbl, {
        fontSize: '13px', color: this.timeModeIdx === i ? '#ffff44' : '#aaaaaa',
        backgroundColor: '#223344', padding: { x: 6, y: 3 }
      }).setScrollFactor(0).setDepth(61).setInteractive().setVisible(false);
      btn.on('pointerdown', () => { this.timeModeIdx = i; this._highlightTimeBtn(); });
      this.timeBtns.push(btn);
      this.debugObjects.push(btn);
    });

    // ズームボタン
    ['-', '+'].forEach((sign, i) => {
      const btn = this.add.text(px + i * 36, py + 105, `ズーム${sign}`, {
        fontSize: '13px', color: '#aaccff', backgroundColor: '#223344',
        padding: { x: 4, y: 3 }
      }).setScrollFactor(0).setDepth(61).setInteractive().setVisible(false);
      btn.on('pointerdown', () => this._setZoom(this.zoomIdx + (i === 0 ? -1 : 1)));
      this.debugObjects.push(btn);
    });

    // グリッドトグル
    const gridBtn = this.add.text(px, py + 135, 'グリッド: ON', {
      fontSize: '13px', color: '#aaccff', backgroundColor: '#223344',
      padding: { x: 4, y: 3 }
    }).setScrollFactor(0).setDepth(61).setInteractive().setVisible(false);
    gridBtn.on('pointerdown', () => {
      this.showGrid = !this.showGrid;
      gridBtn.setText(`グリッド: ${this.showGrid ? 'ON' : 'OFF'}`);
      this._drawMapStatic();
    });
    this.debugObjects.push(gridBtn);

    // パス表示トグル
    const pathBtn = this.add.text(px, py + 160, 'パス表示: OFF', {
      fontSize: '13px', color: '#aaccff', backgroundColor: '#223344',
      padding: { x: 4, y: 3 }
    }).setScrollFactor(0).setDepth(61).setInteractive().setVisible(false);
    pathBtn.on('pointerdown', () => {
      this.showPaths = !this.showPaths;
      pathBtn.setText(`パス表示: ${this.showPaths ? 'ON' : 'OFF'}`);
    });
    this.debugObjects.push(pathBtn);

    // デバッグ開閉ボタン
    const dbgToggle = this.add.text(8, CANVAS_H - UI_H - 8, '⚙', {
      fontSize: '18px', color: '#667788', backgroundColor: '#1a2233',
      padding: { x: 6, y: 4 }
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

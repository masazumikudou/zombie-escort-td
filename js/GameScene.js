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

    // ゲーム状態
    this.scaledTime   = 0;
    this.timeModeIdx  = 2;
    this.zoomIdx      = DEFAULT_ZOOM_IDX;
    this.money        = sd.startMoney;
    this.gameState    = 'playing';
    this.killCount    = 0;
    this.debugOpen    = false;
    this.showGrid     = true;
    this.showPaths    = false;
    this.lastInteractionTime = 0;

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

    // 経路探索
    this.pf = new Pathfinder(sd.grid.cols, sd.grid.rows, sd.obstacles);

    // エンティティ
    this.zombies = [];
    this.towers  = [];
    this.bullets = [];

    // 音声シーン注入
    audioSynth.setScene(this);

    // グラフィクスレイヤー
    this.mapGfx       = this.add.graphics().setDepth(0);
    this.dynGfx       = this.add.graphics().setDepth(3);
    this.hudGfx       = this.add.graphics().setScrollFactor(0).setDepth(10);
    this.indicatorGfx = this.add.graphics().setScrollFactor(0).setDepth(11);

    // 静的マップ描画
    this._drawMapStatic();

    // カメラ設定
    this.cameras.main.setBounds(0, 0, MAP_W, MAP_H);
    this.cameras.main.setZoom(ZOOM_LEVELS[this.zoomIdx]);

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

    const def      = this.escortDefs[idx];
    const escCells = this.pf.find(def.start.col, def.start.row, def.goal.col, def.goal.row);
    const escPath  = escCells ? this.pf.toPixelPath(escCells) : [];
    this.escort    = new Escort(this, escPath, def);

    const cam = this.cameras.main;
    cam.pan(escPath[0]?.x ?? MAP_W / 2, escPath[0]?.y ?? MAP_H / 2, 600, 'Power2');

    // ウェーブマネージャー
    this.waveManager = new WaveManager(def.waves, this.stageData.zombieSpawns);
    this.waveManager.onWaveStart((n, t) => this._setWaveLabel(n, t));
    this.waveManager.onAllDone(() => {});
    this.waveManager.start(timeOffset);

    this._setWaveLabel(1, def.waves.length);
    this._updateRelayHUD();
    this.relayPhase = 'active';
  }

  // ─── リレー：護衛者終了処理 ───────────────────────────────
  _onEscortDone(reached) {
    if (reached) this.survivors++;

    const nextIdx = this.escortIdx + 1;
    if (nextIdx >= this.escortDefs.length) {
      this.relayPhase = 'done';
      this._endGame();
      return;
    }

    // インターバル開始
    this.relayPhase    = 'interval';
    this.intervalTimer = RELAY_INTERVAL;
    const nextName     = VARIANT_NAMES[this.escortDefs[nextIdx].variant] ?? this.escortDefs[nextIdx].variant;
    this._showBanner(`${nextName}、出発！`);
  }

  _activateNextEscort() {
    this.escortIdx++;
    this._closeBanner();
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
    if (scale > 0) this.scaledTime += delta * scale;

    if (this.gameState === 'playing' && dt > 0) {
      this.escort.update(dt);

      // インターバル中はnullを渡しゾンビを既存パスで継続移動させる
      const escortTarget = this.relayPhase === 'active' ? this.escort : null;
      this.zombies.forEach(z => z.update(this.scaledTime, dt, escortTarget));
      this.towers.forEach(t  => t.update(this.scaledTime, dt, this.zombies, this.bullets));

      this.bullets = this.bullets.filter(b => b.active);
      this.bullets.forEach(b => b.update(dt));

      this.waveManager.update(this.scaledTime, (col, row, def, wn) => this._spawnZombie(col, row, def, wn));

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

    if (this.gameState === 'playing' && !this.popupState && this.lastInteractionTime > 0) {
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

    g.fillStyle(0x1e2840, 1);
    g.fillRect(0, 0, MAP_W, MAP_H);

    if (this.showGrid) {
      g.lineStyle(1, 0x3a4a6a, 1);
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

    const sg = this.add.graphics().setDepth(1);
    sg.lineStyle(2, 0xff3300, 0.6);
    for (const sp of this.stageData.zombieSpawns) {
      sg.strokeRect(sp.col * CELL + 2, sp.row * CELL + 2, CELL - 4, CELL - 4);
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

    this._drawBuildSpots(g);
    this.towers.forEach(t => t.draw(g));
    this.zombies.forEach(z => z.draw(g));
    this.escort.draw(g);
    this.bullets.forEach(b => b.draw(g));
  }

  // ─── HUD描画 ─────────────────────────────────────────────
  _drawHUD() {
    if (this.moneyText) this.moneyText.setText(`¥ ${this.money}`);
    if (this.waveText)  this.waveText.setText(this.waveLabel);
    if (this.timeText)  this.timeText.setText(TIME_LABELS[this.timeModeIdx]);

    const g = this.hudGfx;
    g.clear();

    g.fillStyle(0x0a0a1a, 0.92);
    g.fillRect(0, CANVAS_H - UI_H, CANVAS_W, UI_H);
    g.lineStyle(1, 0x334455, 1);
    g.lineBetween(0, CANVAS_H - UI_H, CANVAS_W, CANVAS_H - UI_H);

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
      this.lastInteractionTime = this.time.now;
    });

    this.input.on('pointermove', (p) => {
      this.lastInteractionTime = this.time.now;

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

      if (this.pinching) {
        this._snapZoomIdx();
        this.pinching = false;
      }

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
      if (this.pinching) this._snapZoomIdx();
      this.pinching = false;
      if (!isDrag) this._handleTap(p);
      isDrag = false;
    });

    this.input.on('wheel', (p, go, dx, dy) => {
      this.zoomIdx = clamp(this.zoomIdx + (dy > 0 ? -1 : 1), 0, ZOOM_LEVELS.length - 1);
      this.cameras.main.setZoom(ZOOM_LEVELS[this.zoomIdx]);
      this.lastInteractionTime = this.time.now;
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

    const onSpot = this.buildSpots.size === 0 || this.buildSpots.has(`${col},${row}`);
    if (onSpot) {
      this._openBuildMenu(col, row);
    }
  }

  // ─── 建設メニュー ────────────────────────────────────────
  _openBuildMenu(col, row) {
    this._closePopup();

    const cam  = this.cameras.main;
    const sx   = (col * CELL + CELL / 2 - cam.scrollX) * cam.zoom;
    const sy   = (row * CELL + CELL / 2 - cam.scrollY) * cam.zoom;

    const BW = 88, BH = 60, GAP = 5, PAD = 7;
    const types = Object.keys(TOWER_DEFS);
    const popW  = types.length * BW + (types.length - 1) * GAP + PAD * 2;
    const popH  = BH + PAD * 2;

    let px = sx - popW / 2;
    let py = sy - (CELL * cam.zoom) / 2 - popH - 6;
    px = clamp(px, 6, CANVAS_W - popW - 6);
    if (py < 6) py = sy + (CELL * cam.zoom) / 2 + 6;
    py = clamp(py, 6, CANVAS_H - UI_H - popH - 6);

    this.popupState   = { type: 'build', col, row };
    this.popupObjects = [];

    const bg = this.add.rectangle(px + popW / 2, py + popH / 2, popW, popH, 0x050510, 0.96)
      .setScrollFactor(0).setDepth(70).setStrokeStyle(1, 0x3a5070);
    this.popupObjects.push(bg);

    types.forEach((type, i) => {
      const def       = TOWER_DEFS[type];
      const canAfford = this.money >= def.cost;
      const bx        = px + PAD + i * (BW + GAP);
      const by        = py + PAD;

      const btn = this.add.rectangle(bx + BW / 2, by + BH / 2, BW, BH,
        canAfford ? def.color : 0x2a2a2a, canAfford ? 0.22 : 0.18)
        .setScrollFactor(0).setDepth(71)
        .setStrokeStyle(1.5, canAfford ? def.color : 0x444444, canAfford ? 0.7 : 0.35);
      if (canAfford) {
        btn.setInteractive();
        btn.on('pointerover',  () => btn.setFillStyle(def.color, 0.44));
        btn.on('pointerout',   () => btn.setFillStyle(def.color, 0.22));
        btn.on('pointerdown',  () => {
          this._popupJustActed = true;
          this._tryPlace(col, row, type);
        });
      }

      const nameText = this.add.text(bx + BW / 2, by + 7, def.label, {
        fontSize: '16px', fontStyle: 'bold', fontFamily: 'Arial, Helvetica, sans-serif',
        color: canAfford ? def.textColor : '#555555',
        stroke: '#000000', strokeThickness: 2,
      }).setScrollFactor(0).setDepth(72).setOrigin(0.5, 0);

      const rangeText = this.add.text(bx + BW / 2, by + 28, `射程${def.range}C`, {
        fontSize: '12px', fontFamily: 'Arial, Helvetica, sans-serif',
        color: canAfford ? '#99aabb' : '#444444',
      }).setScrollFactor(0).setDepth(72).setOrigin(0.5, 0);

      const priceText = this.add.text(bx + BW / 2, by + BH - 16, `¥${def.cost}`, {
        fontSize: '14px', fontFamily: 'Arial, Helvetica, sans-serif',
        color: canAfford ? '#ffffff' : '#555555',
        stroke: '#000000', strokeThickness: 2,
      }).setScrollFactor(0).setDepth(72).setOrigin(0.5, 0);

      this.popupObjects.push(btn, nameText, rangeText, priceText);
    });
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
  }

  _sellTower(tower) {
    this.money += tower.sell;
    tower.cleanup();
    this.towers = this.towers.filter(t => t !== tower);
    audioSynth.coin();
    this._closePopup();
  }

  // ─── ゾンビスポーン ──────────────────────────────────────
  _spawnZombie(col, row, def, waveNum) {
    const z = new Zombie(this, col, row, def, this.pf, waveNum);
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
    if (!this.relayStatusText) return;
    const idx     = this.escortIdx;
    const total   = this.escortDefs.length;
    const name    = VARIANT_NAMES[this.escortDefs[idx].variant] ?? this.escortDefs[idx].variant;
    const survivors = `生還 ${this.survivors}/${total}`;
    this.relayStatusText.setText(`${name} (${idx + 1}/${total})   ${survivors}`);
  }

  // ─── UI構築 ──────────────────────────────────────────────
  _buildUI() {
    const uiFont = { fontFamily: 'Arial, Helvetica, sans-serif' };
    const uy     = CANVAS_H - UI_H;

    // 所持金（左）
    this.moneyText = this.add.text(10, uy + 10, `¥ ${this.money}`, {
      ...uiFont, fontSize: '22px', color: '#ffee44',
      stroke: '#000000', strokeThickness: 4,
    }).setScrollFactor(0).setDepth(52);

    // ウェーブ（中央）
    this.waveText = this.add.text(CANVAS_W / 2, uy + 10, this.waveLabel ?? '', {
      ...uiFont, fontSize: '18px', color: '#ffffff',
      stroke: '#000000', strokeThickness: 4,
    }).setScrollFactor(0).setDepth(52).setOrigin(0.5, 0);

    // タイムモード（右）
    this.timeText = this.add.text(CANVAS_W - 10, uy + 10, TIME_LABELS[this.timeModeIdx], {
      ...uiFont, fontSize: '18px', color: '#aaddff',
      stroke: '#000000', strokeThickness: 3,
    }).setScrollFactor(0).setDepth(52).setOrigin(1, 0).setInteractive();
    this.timeText.on('pointerdown', () => this._cycleTimeMode());

    // リレーステータス（HUD上のライン）
    this.relayStatusText = this.add.text(CANVAS_W / 2, uy - 8, '', {
      ...uiFont, fontSize: '14px', color: '#aabbcc',
      stroke: '#000000', strokeThickness: 2,
    }).setScrollFactor(0).setDepth(52).setOrigin(0.5, 1);

    // 護衛へ戻るボタン
    const homeBtn = this.add.text(CANVAS_W - 10, uy - 10, '⌂ 護衛', {
      ...uiFont, fontSize: '18px', color: '#aaddff', backgroundColor: '#1a2a3a',
      padding: { x: 10, y: 6 },
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

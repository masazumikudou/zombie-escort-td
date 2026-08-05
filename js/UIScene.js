// ─── UIScene ────────────────────────────────────────────────
// HUD専用シーン。GameSceneのメインカメラ（ズーム・パン）の影響を受けない。
//
// データ受け渡し方式:
//   GameScene → game.registry.set(key, value) で書き込み
//   UIScene   → update() で registry.get(key) を毎フレーム読み取り
//
// コールバック方式（UIScene → GameScene）:
//   UIScene   → this.game.events.emit('ui_cycleTime' / 'ui_returnToEscort')
//   GameScene → this.game.events.on(...) でリッスン

class UIScene extends Phaser.Scene {
  constructor() {
    super({ key: 'UIScene' });
  }

  create() {
    const uiFont = { fontFamily: 'Arial, Helvetica, sans-serif' };

    // ヘッダーバー背景 + 勝敗オーバーレイ
    this.hudGfx     = this.add.graphics().setDepth(10);
    this.overlayGfx = this.add.graphics().setDepth(11);

    // 所持金（左）
    this.moneyText = this.add.text(0, 0, '¥ 0', {
      ...uiFont, fontSize: '22px', color: '#ffee44',
      stroke: '#000000', strokeThickness: 4,
    }).setDepth(52);

    // ウェーブ（中央）
    this.waveText = this.add.text(0, 0, '', {
      ...uiFont, fontSize: '18px', color: '#ffffff',
      stroke: '#000000', strokeThickness: 4,
    }).setDepth(52).setOrigin(0.5, 0);

    // タイムモード（右）
    this.timeText = this.add.text(0, 0, TIME_LABELS[2], {
      ...uiFont, fontSize: '18px', color: '#aaddff',
      stroke: '#000000', strokeThickness: 3,
    }).setDepth(52).setOrigin(1, 0).setInteractive();
    this.timeText.on('pointerdown', () => this.game.events.emit('ui_cycleTime'));

    // リレーステータス（ヘッダー直下）
    this.relayStatusText = this.add.text(0, 0, '', {
      ...uiFont, fontSize: '14px', color: '#aabbcc',
      stroke: '#000000', strokeThickness: 2,
    }).setDepth(52).setOrigin(0.5, 0);

    // 護衛へ戻るボタン（ヘッダー直下・右）
    this.homeBtn = this.add.text(0, 0, '⌂ 護衛', {
      ...uiFont, fontSize: '18px', color: '#aaddff', backgroundColor: '#1a2a3a',
      padding: { x: 10, y: 6 },
    }).setDepth(52).setOrigin(1, 0).setInteractive();
    this.homeBtn.on('pointerdown', () => this.game.events.emit('ui_returnToEscort'));

    // ルート表示トグルボタン（ヘッダー直下・右寄り）
    this._routeOn = false;
    this.routeBtn = this.add.text(0, 0, '🔴 ルート', {
      ...uiFont, fontSize: '15px', color: '#885555', backgroundColor: '#1a1010',
      padding: { x: 8, y: 5 },
    }).setDepth(52).setOrigin(1, 0).setInteractive();
    this.routeBtn.on('pointerdown', () => {
      this._routeOn = !this._routeOn;
      this.routeBtn.setStyle({
        color:           this._routeOn ? '#ff6666' : '#885555',
        backgroundColor: this._routeOn ? '#331111' : '#1a1010',
      });
      this.game.events.emit('ui_toggleRoute');
    });

    // 建設ポップアップ（UISceneで管理：カメラズームの影響を受けないため）
    this._buildPopupObjs = [];
    this.game.events.on('openBuildMenu',       (data) => this._openBuildPopup(data));
    this.game.events.on('closeBuildMenu',      ()     => this._closeBuildPopup());
    this.game.events.on('openDirectionPicker',  (data) => this._openDirectionPicker(data));
    this.game.events.on('openPunchDirPicker',   (data) => this._openPunchDirPicker(data));

    // 売却/アップグレードポップアップ（建設ポップアップと同じ理由でUIScene管理・2026-08-05）
    this._sellPopupObjs = [];
    this.game.events.on('openSellMenu',        (data) => this._openSellPopup(data));
    this.game.events.on('closeSellMenu',       ()     => this._closeSellPopup());

    // FPSカウンター（右下・タップでON/OFF）
    this._showFps = false;
    this.fpsText = this.add.text(0, 0, '', {
      ...uiFont, fontSize: '14px', color: '#00ff88',
      stroke: '#000000', strokeThickness: 3,
    }).setDepth(60).setOrigin(1, 1).setInteractive();
    this.fpsText.on('pointerdown', () => {
      this._showFps = !this._showFps;
      if (!this._showFps) this.fpsText.setText('FPS');
    });
    this.fpsText.setText('FPS');

    // 初回レイアウト + リサイズ対応
    this._layout(this.scale.width, this.scale.height);
    this.scale.on('resize', (gameSize) => {
      this._layout(gameSize.width, gameSize.height);
    });
  }

  // 画面サイズが変わるたびに全HUD要素を再配置する
  _layout(w, h) {
    this._w = w;
    this._h = h;
    const SAFE = 8;
    const barH = SAFE + UI_H;
    const textY = SAFE + 10;

    this.moneyText.setPosition(10, textY);
    this.waveText.setPosition(w / 2, textY);
    this.timeText.setPosition(w - 10, textY);
    this.relayStatusText.setPosition(w / 2, barH + 6);
    this.homeBtn.setPosition(w - 10, barH + 6);
    this.routeBtn.setPosition(w - 10 - this.homeBtn.width - 8, barH + 6);
    this.fpsText.setPosition(w - 8, h - 8);

    // ゲームカメラのビューポートも合わせて更新
    this.game.events.emit('ui_resize', { w, h });
  }

  _openBuildPopup({ col, row, sx, sy, cellHalfPx, money }) {
    this._closeBuildPopup();
    const uiFont = { fontFamily: 'Arial, Helvetica, sans-serif' };
    const BW = 88, BH = 60, GAP = 5, PAD = 7;
    const types = (TOWER_UNLOCK ?? Object.keys(TOWER_DEFS)).filter(t => TOWER_DEFS[t]);
    const popW  = types.length * BW + (types.length - 1) * GAP + PAD * 2;
    const popH  = BH + PAD * 2;
    const W = this.scale.width, H = this.scale.height;

    let px = sx - popW / 2;
    let py = sy - cellHalfPx - popH - 6;
    px = Math.max(6, Math.min(W - popW - 6, px));
    if (py < 6) py = sy + cellHalfPx + 6;
    py = Math.max(6, Math.min(H - UI_H - popH - 6, py));

    // 暗幕オーバーレイ（タップで閉じる。GameScene側は建設ポップアップ表示中は入力を止めて
    // いるため、「外側タップで閉じる」操作はこちらから'ui_closePopup'で伝える・2026-08-04）
    const overlay = this.add.rectangle(W / 2, H / 2, W, H, 0x000000, 0.72).setDepth(69).setInteractive();
    overlay.on('pointerdown', () => this.game.events.emit('ui_closePopup'));
    this._buildPopupObjs.push(overlay);

    // 背景
    const bg = this.add.rectangle(px + popW / 2, py + popH / 2, popW, popH, 0x050510, 0.96)
      .setDepth(70).setStrokeStyle(1, 0x3a5070);
    this._buildPopupObjs.push(bg);

    types.forEach((type, i) => {
      const def       = TOWER_DEFS[type];
      const canAfford = money >= def.cost;
      const bx        = px + PAD + i * (BW + GAP);
      const by        = py + PAD;

      const btn = this.add.rectangle(bx + BW / 2, by + BH / 2, BW, BH,
        canAfford ? def.color : 0x2a2a2a, canAfford ? 0.22 : 0.18)
        .setDepth(71)
        .setStrokeStyle(1.5, canAfford ? def.color : 0x444444, canAfford ? 0.7 : 0.35);
      if (canAfford) {
        btn.setInteractive();
        btn.on('pointerover',  () => btn.setFillStyle(def.color, 0.44));
        btn.on('pointerout',   () => btn.setFillStyle(def.color, 0.22));
        btn.on('pointerdown',  () => this.game.events.emit('ui_buildPlace', { col, row, type }));
      }

      const nameText = this.add.text(bx + BW / 2, by + 7, def.label, {
        ...uiFont, fontSize: '16px', fontStyle: 'bold',
        color: canAfford ? def.textColor : '#555555',
        stroke: '#000000', strokeThickness: 2,
      }).setDepth(72).setOrigin(0.5, 0);

      const rangeText = this.add.text(bx + BW / 2, by + 28, `射程${def.range}C`, {
        ...uiFont, fontSize: '12px', color: canAfford ? '#99aabb' : '#444444',
      }).setDepth(72).setOrigin(0.5, 0);

      const priceText = this.add.text(bx + BW / 2, by + BH - 16, `¥${def.cost}`, {
        ...uiFont, fontSize: '14px',
        color: canAfford ? '#ffffff' : '#555555',
        stroke: '#000000', strokeThickness: 2,
      }).setDepth(72).setOrigin(0.5, 0);

      this._buildPopupObjs.push(btn, nameText, rangeText, priceText);
    });
  }

  _closeBuildPopup() {
    this._buildPopupObjs.forEach(o => o.destroy());
    this._buildPopupObjs = [];
  }

  // 売却/アップグレードポップアップ（建設ポップアップと同じ構成。座標・寸法はGameScene側で計算済み・2026-08-05）
  _openSellPopup({ col, row, px, py, popW, popH, label, textColor, upgradeLevel, canUpgrade, upgCost, hasMoney, sellRefund }) {
    this._closeSellPopup();
    const uiFont = { fontFamily: 'Arial, Helvetica, sans-serif' };
    const W = this.scale.width, H = this.scale.height;

    // 暗幕オーバーレイ（タップで閉じる。建設ポップアップと同じ理由・2026-08-05）
    const overlay = this.add.rectangle(W / 2, H / 2, W, H, 0x000000, 0.72).setDepth(69).setInteractive();
    overlay.on('pointerdown', () => this.game.events.emit('ui_closePopup'));
    this._sellPopupObjs.push(overlay);

    const bg = this.add.rectangle(px + popW / 2, py + popH / 2, popW, popH, 0x050510, 0.96)
      .setDepth(70).setStrokeStyle(1, 0x3a5070);
    this._sellPopupObjs.push(bg);

    const titleText = this.add.text(px + popW / 2, py + 8, `${label}タワー  Lv${upgradeLevel}`, {
      ...uiFont, fontSize: '14px', color: textColor, stroke: '#000000', strokeThickness: 2,
    }).setDepth(71).setOrigin(0.5, 0);
    this._sellPopupObjs.push(titleText);

    const btnW = 128, btnH = 30;
    const btnX = px + (popW - btnW) / 2;

    if (canUpgrade) {
      const ubY     = py + 32;
      const ubColor = hasMoney ? 0x114411 : 0x222222;
      const upgradeBtn = this.add.rectangle(btnX + btnW / 2, ubY + btnH / 2, btnW, btnH, ubColor, 0.9)
        .setDepth(71).setStrokeStyle(1.5, hasMoney ? 0x44ff44 : 0x555555, 0.8);
      if (hasMoney) {
        upgradeBtn.setInteractive();
        upgradeBtn.on('pointerover',  () => upgradeBtn.setFillStyle(0x226622, 0.9));
        upgradeBtn.on('pointerout',   () => upgradeBtn.setFillStyle(0x114411, 0.9));
        upgradeBtn.on('pointerdown',  () => this.game.events.emit('ui_upgradeTower', { col, row }));
      }
      this._sellPopupObjs.push(upgradeBtn);
      const upgradeText = this.add.text(btnX + btnW / 2, ubY + btnH / 2,
        hasMoney ? `強化 Lv${upgradeLevel + 1}  ¥${upgCost}` : `強化 ¥${upgCost} (資金不足)`, {
        ...uiFont, fontSize: '13px',
        color: hasMoney ? '#88ff88' : '#666666', stroke: '#000000', strokeThickness: 2,
      }).setDepth(72).setOrigin(0.5, 0.5);
      this._sellPopupObjs.push(upgradeText);
    }

    const sbY = canUpgrade ? py + 72 : py + popH - btnH - 8;
    const sellBtn = this.add.rectangle(btnX + btnW / 2, sbY + btnH / 2, btnW, btnH, 0x551111, 0.9)
      .setDepth(71).setStrokeStyle(1.5, 0xff4444, 0.8).setInteractive();
    sellBtn.on('pointerover',  () => sellBtn.setFillStyle(0x882222, 0.9));
    sellBtn.on('pointerout',   () => sellBtn.setFillStyle(0x551111, 0.9));
    sellBtn.on('pointerdown',  () => this.game.events.emit('ui_sellTower', { col, row }));
    this._sellPopupObjs.push(sellBtn);

    const sellText = this.add.text(btnX + btnW / 2, sbY + btnH / 2, `売却  +¥${sellRefund}`, {
      ...uiFont, fontSize: '14px', color: '#ff9999', stroke: '#000000', strokeThickness: 2,
    }).setDepth(72).setOrigin(0.5, 0.5);
    this._sellPopupObjs.push(sellText);
  }

  _closeSellPopup() {
    this._sellPopupObjs.forEach(o => o.destroy());
    this._sellPopupObjs = [];
  }

  _openPunchDirPicker({ col, row, sx, sy }) {
    if (!this._dirPickerObjs) this._dirPickerObjs = [];
    this._dirPickerObjs.forEach(o => o.destroy());
    this._dirPickerObjs = [];

    const uiFont = { fontFamily: 'Arial, Helvetica, sans-serif' };
    const BW = 80, BH = 52, GAP = 4, PAD = 6;
    const popW = BW * 3 + GAP * 2 + PAD * 2;
    const popH = BH + PAD * 2 + 22;
    const W = this.scale.width, H = this.scale.height;

    let px = sx - popW / 2;
    let py = sy - popH / 2;
    px = Math.max(6, Math.min(W - popW - 6, px));
    py = Math.max(6, Math.min(H - UI_H - popH - 6, py));

    const overlay = this.add.rectangle(W / 2, H / 2, W, H, 0x000000, 0.72).setDepth(69);
    const bg = this.add.rectangle(px + popW / 2, py + popH / 2, popW, popH, 0x050510, 0.96)
      .setDepth(70).setStrokeStyle(1, 0xff6600);
    const title = this.add.text(px + popW / 2, py + 4, 'パンチ方向', {
      ...uiFont, fontSize: '13px', color: '#ff8833', stroke: '#000', strokeThickness: 2,
    }).setDepth(72).setOrigin(0.5, 0);
    this._dirPickerObjs.push(overlay, bg, title);

    [{ key: 'left', label: '← 左' }, { key: 'up', label: '↑ 上' }, { key: 'right', label: '→ 右' }].forEach(({ key, label }, i) => {
      const bx = px + PAD + i * (BW + GAP);
      const by = py + PAD + 22;
      const btn = this.add.rectangle(bx + BW / 2, by + BH / 2, BW, BH, 0xff6600, 0.22)
        .setDepth(71).setStrokeStyle(1.5, 0xff6600, 0.7).setInteractive();
      btn.on('pointerover',  () => btn.setFillStyle(0xff6600, 0.5));
      btn.on('pointerout',   () => btn.setFillStyle(0xff6600, 0.22));
      btn.on('pointerdown',  () => {
        this.game.events.emit('ui_laserDir', { col, row, dir: key });
        this._dirPickerObjs.forEach(o => o.destroy());
        this._dirPickerObjs = [];
      });
      const txt = this.add.text(bx + BW / 2, by + BH / 2, label, {
        ...uiFont, fontSize: '20px', fontStyle: 'bold', color: '#ffffff',
        stroke: '#000', strokeThickness: 3,
      }).setDepth(72).setOrigin(0.5, 0.5);
      this._dirPickerObjs.push(btn, txt);
    });
  }

  _openDirectionPicker({ col, row, sx, sy }) {
    if (!this._dirPickerObjs) this._dirPickerObjs = [];
    this._dirPickerObjs.forEach(o => o.destroy());
    this._dirPickerObjs = [];

    const uiFont = { fontFamily: 'Arial, Helvetica, sans-serif' };
    const BW = 72, BH = 52, GAP = 4, PAD = 6;
    const popW = BW * 2 + GAP + PAD * 2;
    const popH = BH * 2 + GAP + PAD * 2;
    const W = this.scale.width, H = this.scale.height;

    let px = sx - popW / 2;
    let py = sy - popH / 2;
    px = Math.max(6, Math.min(W - popW - 6, px));
    py = Math.max(6, Math.min(H - UI_H - popH - 6, py));

    const overlay = this.add.rectangle(W / 2, H / 2, W, H, 0x000000, 0.72).setDepth(69);
    const bg = this.add.rectangle(px + popW / 2, py + popH / 2, popW, popH, 0x050510, 0.96)
      .setDepth(70).setStrokeStyle(1, 0xff2266);
    const title = this.add.text(px + popW / 2, py + 3, 'レーザー方向', {
      ...uiFont, fontSize: '13px', color: '#ff88aa', stroke: '#000', strokeThickness: 2,
    }).setDepth(72).setOrigin(0.5, 0);
    this._dirPickerObjs.push(overlay, bg, title);

    const dirs = [
      { key: 'up',    label: '↑ 上', gi: 0, gj: 0 },
      { key: 'right', label: '→ 右', gi: 1, gj: 0 },
      { key: 'left',  label: '← 左', gi: 0, gj: 1 },
      { key: 'down',  label: '↓ 下', gi: 1, gj: 1 },
    ];
    dirs.forEach(({ key, label, gi, gj }) => {
      const bx = px + PAD + gi * (BW + GAP);
      const by = py + PAD + 20 + gj * (BH + GAP);
      const btn = this.add.rectangle(bx + BW / 2, by + BH / 2, BW, BH, 0xff2266, 0.22)
        .setDepth(71).setStrokeStyle(1.5, 0xff2266, 0.7).setInteractive();
      btn.on('pointerover',  () => btn.setFillStyle(0xff2266, 0.5));
      btn.on('pointerout',   () => btn.setFillStyle(0xff2266, 0.22));
      btn.on('pointerdown',  () => {
        this.game.events.emit('ui_laserDir', { col, row, dir: key });
        this._dirPickerObjs.forEach(o => o.destroy());
        this._dirPickerObjs = [];
      });
      const txt = this.add.text(bx + BW / 2, by + BH / 2, label, {
        ...uiFont, fontSize: '18px', fontStyle: 'bold', color: '#ffffff',
        stroke: '#000', strokeThickness: 3,
      }).setDepth(72).setOrigin(0.5, 0.5);
      this._dirPickerObjs.push(btn, txt);
    });
  }

  update() {
    const r    = this.registry;
    const w    = this._w ?? this.scale.width;
    const h    = this._h ?? this.scale.height;
    const SAFE = 8;
    const barH = SAFE + UI_H;

    this.moneyText.setText(`¥ ${r.get('hud_money') ?? 0} (稼ぎ ¥${r.get('hud_earned') ?? 0})`);
    this.waveText.setText(r.get('hud_wave') ?? '');
    this.timeText.setText(TIME_LABELS[r.get('hud_timeIdx') ?? 2]);
    this.relayStatusText.setText(r.get('hud_relay') ?? '');

    // ヘッダーバー
    const g = this.hudGfx;
    g.clear();
    g.fillStyle(0x0a0a1a, 0.92);
    g.fillRect(0, 0, w, barH);
    g.lineStyle(1, 0x334455, 1);
    g.lineBetween(0, barH, w, barH);

    // FPS表示
    if (this._showFps) {
      this.fpsText.setText(`${Math.round(this.game.loop.actualFps)} fps`);
    }

    // 勝敗オーバーレイ
    const gameState = r.get('hud_gameState') ?? 'playing';
    const ov = this.overlayGfx;
    ov.clear();
    if (gameState === 'defeat' || gameState === 'victory') {
      ov.fillStyle(0x000000, 0.6);
      ov.fillRect(0, 0, w, h);
    }
  }
}

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
    const uiFont  = { fontFamily: 'Arial, Helvetica, sans-serif' };
    const SAFE    = 8;          // 上端セーフエリアマージン（ノッチ・ステータスバー対策）
    const barH    = SAFE + UI_H; // ヘッダーバー全高
    const textY   = SAFE + 10;  // バー内テキストのY基準

    // ヘッダーバー背景 + 勝敗オーバーレイ
    this.hudGfx     = this.add.graphics().setDepth(10);
    this.overlayGfx = this.add.graphics().setDepth(11);

    // 所持金（左）
    this.moneyText = this.add.text(10, textY, '¥ 0', {
      ...uiFont, fontSize: '22px', color: '#ffee44',
      stroke: '#000000', strokeThickness: 4,
    }).setDepth(52);

    // ウェーブ（中央）
    this.waveText = this.add.text(CANVAS_W / 2, textY, '', {
      ...uiFont, fontSize: '18px', color: '#ffffff',
      stroke: '#000000', strokeThickness: 4,
    }).setDepth(52).setOrigin(0.5, 0);

    // タイムモード（右）
    this.timeText = this.add.text(CANVAS_W - 10, textY, TIME_LABELS[2], {
      ...uiFont, fontSize: '18px', color: '#aaddff',
      stroke: '#000000', strokeThickness: 3,
    }).setDepth(52).setOrigin(1, 0).setInteractive();
    this.timeText.on('pointerdown', () => this.game.events.emit('ui_cycleTime'));

    // リレーステータス（ヘッダー直下）
    this.relayStatusText = this.add.text(CANVAS_W / 2, barH + 6, '', {
      ...uiFont, fontSize: '14px', color: '#aabbcc',
      stroke: '#000000', strokeThickness: 2,
    }).setDepth(52).setOrigin(0.5, 0);

    // 護衛へ戻るボタン（ヘッダー直下・右）
    const homeBtn = this.add.text(CANVAS_W - 10, barH + 6, '⌂ 護衛', {
      ...uiFont, fontSize: '18px', color: '#aaddff', backgroundColor: '#1a2a3a',
      padding: { x: 10, y: 6 },
    }).setDepth(52).setOrigin(1, 0).setInteractive();
    homeBtn.on('pointerdown', () => this.game.events.emit('ui_returnToEscort'));

    // FPSカウンター（右下・タップでON/OFF）
    this._showFps = false;
    this.fpsText = this.add.text(CANVAS_W - 8, CANVAS_H - 8, '', {
      ...uiFont, fontSize: '14px', color: '#00ff88',
      stroke: '#000000', strokeThickness: 3,
    }).setDepth(60).setOrigin(1, 1).setInteractive();
    this.fpsText.on('pointerdown', () => {
      this._showFps = !this._showFps;
      if (!this._showFps) this.fpsText.setText('FPS');
    });
    // 初期表示（タップできると気づけるよう小さく表示）
    this.fpsText.setText('FPS');
  }

  update() {
    const r    = this.registry;
    const SAFE = 8;
    const barH = SAFE + UI_H;

    this.moneyText.setText(`¥ ${r.get('hud_money') ?? 0}`);
    this.waveText.setText(r.get('hud_wave') ?? '');
    this.timeText.setText(TIME_LABELS[r.get('hud_timeIdx') ?? 2]);
    this.relayStatusText.setText(r.get('hud_relay') ?? '');

    // ヘッダーバー
    const g = this.hudGfx;
    g.clear();
    g.fillStyle(0x0a0a1a, 0.92);
    g.fillRect(0, 0, CANVAS_W, barH);
    g.lineStyle(1, 0x334455, 1);
    g.lineBetween(0, barH, CANVAS_W, barH);

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
      ov.fillRect(0, 0, CANVAS_W, CANVAS_H);
    }
  }
}

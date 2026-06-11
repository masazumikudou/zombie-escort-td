// Phaser 設定 & 起動
const PhaserConfig = {
  type:       Phaser.AUTO,
  width:      CANVAS_W,
  height:     CANVAS_H,
  backgroundColor: '#1e2840',
  parent:     'game-container',
  scene:      [BootScene, GameScene],
  resolution: window.devicePixelRatio || 1,  // HiDPI対応：フォントを鮮明に
  scale: {
    mode:       Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  render: {
    antialias:   true,
    pixelArt:    false,
    roundPixels: false,
  },
};

const game = new Phaser.Game(PhaserConfig);

// ステージ選択（将来の拡張用）
function startStage(file) {
  game.scene.getScene('BootScene')?.scene.restart({ stageFile: file });
}

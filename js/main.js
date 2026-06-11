// Phaser 設定 & 起動
const PhaserConfig = {
  type:   Phaser.AUTO,
  width:  CANVAS_W,
  height: CANVAS_H,
  backgroundColor: '#1a1a2e',
  parent: 'game-container',
  scene:  [BootScene, GameScene],
  scale: {
    mode:       Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  render: {
    antialias:    false,
    pixelArt:     false,
    roundPixels:  true,
  },
};

const game = new Phaser.Game(PhaserConfig);

// ステージ選択（将来の拡張用）
function startStage(file) {
  game.scene.getScene('BootScene')?.scene.restart({ stageFile: file });
}

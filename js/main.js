// Phaser 設定 & 起動
const PhaserConfig = {
  type:       Phaser.WEBGL,
  antialias:  true,
  width:      window.innerWidth,
  height:     window.innerHeight,
  backgroundColor: '#1e2840',
  parent:     'game-container',
  scene:      [BootScene, GameScene, UIScene],
  resolution: window.devicePixelRatio || 1,  // HiDPI対応：フォントを鮮明に
  scale: {
    mode:       Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  render: {
    antialias:        true,
    mipmapFilter:     'LINEAR_MIPMAP_LINEAR',
    pixelArt:         false,
    roundPixels:      false,
  },
};

const game = new Phaser.Game(PhaserConfig);

// ステージ選択（将来の拡張用）
function startStage(file) {
  game.scene.getScene('BootScene')?.scene.restart({ stageFile: file });
}

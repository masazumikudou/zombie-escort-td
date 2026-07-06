class StageSelectScene extends Phaser.Scene {
  constructor() { super('StageSelectScene'); }

  preload() {
    this.load.json('stageIndex', 'stages/index.json');
  }

  create() {
    const { width: w, height: h } = this.scale;
    const list = this.cache.json.get('stageIndex')?.stages ?? [];

    this.add.rectangle(w / 2, h / 2, w, h, 0x0d0d1a);

    this.add.text(w / 2, h * 0.10, 'ZOMBIE ESCORT TD', {
      fontSize: '32px', color: '#ffdd88',
      fontFamily: 'Arial, Helvetica, sans-serif',
      stroke: '#000000', strokeThickness: 4,
    }).setOrigin(0.5);

    this.add.text(w / 2, h * 0.20, 'ステージ選択', {
      fontSize: '20px', color: '#aaaaaa',
      fontFamily: 'Arial, Helvetica, sans-serif',
    }).setOrigin(0.5);

    const startY = h * 0.33;
    const step   = Math.min(90, (h * 0.55) / Math.max(list.length, 1));

    list.forEach((stage, i) => {
      const y = startY + i * step;

      const btn = this.add.text(w / 2, y, stage.title, {
        fontSize: '20px', color: '#ffffff',
        backgroundColor: '#1e3a5f',
        padding: { x: 28, y: 12 },
        fontFamily: 'Arial, Helvetica, sans-serif',
      }).setOrigin(0.5).setInteractive();

      btn.on('pointerover',  () => btn.setStyle({ backgroundColor: '#2a5488' }));
      btn.on('pointerout',   () => btn.setStyle({ backgroundColor: '#1e3a5f' }));
      btn.on('pointerdown',  () => {
        this.scene.start('BootScene', { stageFile: stage.file });
      });
    });
  }
}

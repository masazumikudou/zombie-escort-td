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

    const startY = h * 0.28;
    const step   = Math.min(110, (h * 0.65) / Math.max(list.length, 1));

    // タワー入力欄・JSONコピーボタン（DOM）
    const inputs = [];
    const domBtns = [];
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
        const raw = inputs[i]?.value?.trim() ?? '';
        this.scene.start('BootScene', { stageFile: stage.file, sessionTowerText: raw });
      });

      // JSONコピーボタン（HTMLオーバーレイ）
      const copyBtn = document.createElement('button');
      copyBtn.textContent = 'JSON';
      copyBtn.style.cssText = [
        'position:absolute',
        `left:calc(50% + 210px)`,
        `top:${y - 14}px`,
        'background:#0d2a1a', 'color:#4ade80',
        'border:1px solid #2a5a3a', 'border-radius:4px',
        'padding:4px 10px', 'font-size:11px',
        'font-family:monospace', 'cursor:pointer',
      ].join(';');
      copyBtn.onclick = async () => {
        try {
          const r    = await fetch(stage.file);
          const text = await r.text();
          await navigator.clipboard.writeText(text);
          copyBtn.textContent = 'コピー済';
          setTimeout(() => { copyBtn.textContent = 'JSON'; }, 1500);
        } catch (e) {
          copyBtn.textContent = 'エラー';
          setTimeout(() => { copyBtn.textContent = 'JSON'; }, 1500);
        }
      };
      document.body.appendChild(copyBtn);
      domBtns.push(copyBtn);

      // タワー入力欄（HTMLオーバーレイ）
      const inp = document.createElement('input');
      inp.type        = 'text';
      inp.placeholder = 'タワー追加: sniper:10,8 basic:5,3 …';
      inp.style.cssText = [
        'position:absolute',
        `left:50%`, `transform:translateX(-50%)`,
        `top:${y + 36}px`,
        'width:420px', 'max-width:90vw',
        'background:#0d1a2e', 'color:#aaddff',
        'border:1px solid #2a4a6a', 'border-radius:4px',
        'padding:4px 10px', 'font-size:12px',
        'font-family:monospace', 'outline:none',
      ].join(';');
      document.body.appendChild(inp);
      inputs.push(inp);
    });

    // シーン離脱時にDOM要素を削除
    this.events.once('shutdown', () => {
      inputs.forEach(el => el.remove());
      domBtns.forEach(el => el.remove());
    });
  }
}

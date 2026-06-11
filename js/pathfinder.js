// A* 経路探索（4方向のみ・game-v2から移植）
// obstacles: [{col, row}, ...] のみブロック。タワーは通過可能。
class Pathfinder {
  constructor(cols, rows, obstacles) {
    this.cols = cols;
    this.rows = rows;
    this.blocked = new Set(obstacles.map(o => `${o.col},${o.row}`));
  }

  setObstacles(obstacles) {
    this.blocked = new Set(obstacles.map(o => `${o.col},${o.row}`));
  }

  isWalkable(col, row) {
    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) return false;
    return !this.blocked.has(`${col},${row}`);
  }

  // セルパス [{col, row}, ...] を返す。到達不能なら null
  find(sc, sr, gc, gr) {
    const key = (c, r) => `${c},${r}`;
    const h   = (c, r) => Math.abs(c - gc) + Math.abs(r - gr);

    const open   = new Map();
    const closed = new Set();

    open.set(key(sc, sr), { col: sc, row: sr, g: 0, f: h(sc, sr), parent: null });

    while (open.size > 0) {
      let current = null;
      for (const node of open.values()) {
        if (!current || node.f < current.f) current = node;
      }

      if (current.col === gc && current.row === gr) {
        const path = [];
        let n = current;
        while (n) { path.unshift({ col: n.col, row: n.row }); n = n.parent; }
        return path;
      }

      const ck = key(current.col, current.row);
      open.delete(ck);
      closed.add(ck);

      for (const [dc, dr] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nc = current.col + dc;
        const nr = current.row + dr;
        const nk = key(nc, nr);
        if (!this.isWalkable(nc, nr) || closed.has(nk)) continue;
        const g = current.g + 1;
        const existing = open.get(nk);
        if (!existing || g < existing.g) {
          open.set(nk, { col: nc, row: nr, g, f: g + h(nc, nr), parent: current });
        }
      }
    }
    return null;
  }

  // セルパス → ピクセルウェイポイント [{x, y, col, row}, ...]
  toPixelPath(cellPath) {
    return cellPath.map(({ col, row }) => {
      const { x, y } = cellCenter(col, row);
      return { x, y, col, row };
    });
  }

  findPixels(sc, sr, gc, gr) {
    const cp = this.find(sc, sr, gc, gr);
    return cp ? this.toPixelPath(cp) : null;
  }
}

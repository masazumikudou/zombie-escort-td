// フローフィールド
// BFSで護衛セルから全walkableセルへの「次の1歩方向」を事前計算する。
// 全ゾンビが共有し、自分のセルをO(1)ルックアップするだけで次ウェイポイントを得る。
// 護衛のセルが変わったときだけ再計算（ゾンビ数に関係なく1回のみ）。

var FlowField = class FlowField {
  constructor(pf) {
    this.pf      = pf;
    this.version = 0;     // 更新のたびにインクリメント（ゾンビが変化検知に使う）
    this._dirs   = null;  // Map: "col,row" -> {dc, dr}
    this._tCol   = -1;
    this._tRow   = -1;
  }

  // 護衛のセルが前回と異なるときだけ再計算する
  update(tCol, tRow) {
    if (tCol === this._tCol && tRow === this._tRow) return;
    this._tCol = tCol;
    this._tRow = tRow;
    this._compute();
    this.version++;
  }

  _compute() {
    const key  = (c, r) => `${c},${r}`;
    this._dist = new Map();
    const queue = [];

    this._dist.set(key(this._tCol, this._tRow), 0);
    queue.push({ col: this._tCol, row: this._tRow });

    // BFS：護衛セルを起点に全方向へ距離マップを展開
    let head = 0;
    while (head < queue.length) {
      const { col, row } = queue[head++];
      const d = this._dist.get(key(col, row));
      for (const [dc, dr] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nc = col + dc, nr = row + dr;
        const nk = key(nc, nr);
        if (!this.pf.isWalkable(nc, nr) || this._dist.has(nk)) continue;
        this._dist.set(nk, d + 1);
        queue.push({ col: nc, row: nr });
      }
    }

    // 各セルから「距離が減る方向」= 護衛に向かう1歩を記録
    const dirs = new Map();
    for (const [k] of this._dist) {
      const sep = k.indexOf(',');
      const c = +k.slice(0, sep), r = +k.slice(sep + 1);
      if (c === this._tCol && r === this._tRow) continue;
      const myD = this._dist.get(k);
      let bestDc = 0, bestDr = 0, bestD = myD;
      for (const [dc, dr] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nd = this._dist.get(key(c + dc, r + dr));
        if (nd !== undefined && nd < bestD) { bestD = nd; bestDc = dc; bestDr = dr; }
      }
      if (bestDc !== 0 || bestDr !== 0) dirs.set(k, { dc: bestDc, dr: bestDr });
    }
    this._dirs = dirs;
  }

  // スポーン地点から護衛までの経路距離（壁考慮）。到達不能はInfinity
  distAt(col, row) {
    return this._dist?.get(`${col},${row}`) ?? Infinity;
  }

  // (col, row) から護衛に向かう次セルを返す。到達不能 or 護衛セルなら null
  getNextCell(col, row) {
    const dir = this._dirs?.get(`${col},${row}`);
    if (!dir) return null;
    return { col: col + dir.dc, row: row + dir.dr };
  }
}

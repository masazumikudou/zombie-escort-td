"""
sprite_align.py — 透過PNG複数枚のコンテンツ中心を揃えてスプライトシートを生成

使い方:
    python tools/sprite_align.py frame1.png frame2.png [frame3.png ...]

出力:
    aligned_frame1.png, aligned_frame2.png, ... （中心揃え済み個別フレーム）
    spritesheet.png                             （横並びスプライトシート）
"""

import sys
from pathlib import Path
from PIL import Image
import numpy as np


def content_bounds(img: Image.Image):
    """非透過ピクセルの bounding box を返す (left, top, right, bottom)"""
    arr = np.array(img.convert('RGBA'))
    alpha = arr[:, :, 3]
    rows = np.any(alpha > 0, axis=1)
    cols = np.any(alpha > 0, axis=0)
    if not rows.any():
        return None
    top,  bottom = int(np.argmax(rows)),        int(len(rows)  - 1 - np.argmax(rows[::-1]))
    left, right  = int(np.argmax(cols)),        int(len(cols)  - 1 - np.argmax(cols[::-1]))
    return left, top, right, bottom


def content_center(bounds):
    left, top, right, bottom = bounds
    return (left + right) / 2, (top + bottom) / 2


def align_frames(paths: list[str]):
    images = [Image.open(p).convert('RGBA') for p in paths]
    bounds_list = [content_bounds(img) for img in images]

    for i, b in enumerate(bounds_list):
        if b is None:
            print(f"警告: {paths[i]} に不透明ピクセルが見つかりません")
            sys.exit(1)

    centers = [content_center(b) for b in bounds_list]
    cx_list = [c[0] for c in centers]
    cy_list = [c[1] for c in centers]

    # 各フレームのコンテンツサイズ
    widths  = [b[2] - b[0] + 1 for b in bounds_list]
    heights = [b[3] - b[1] + 1 for b in bounds_list]

    max_w = max(widths)
    max_h = max(heights)

    # 出力キャンバスサイズ：最大コンテンツ + 余白を持たせる（32px）
    pad    = 32
    out_w  = max_w + pad * 2
    out_h  = max_h + pad * 2

    # 出力キャンバス中心
    out_cx = out_w / 2
    out_cy = out_h / 2

    aligned = []
    for img, (cx, cy) in zip(images, centers):
        canvas = Image.new('RGBA', (out_w, out_h), (0, 0, 0, 0))
        offset_x = int(round(out_cx - cx))
        offset_y = int(round(out_cy - cy))
        canvas.paste(img, (offset_x, offset_y), img)
        aligned.append(canvas)

    # 個別出力
    out_dir = Path(paths[0]).parent
    out_paths = []
    for i, (img, src) in enumerate(zip(aligned, paths)):
        name = f"aligned_{Path(src).name}"
        out_path = out_dir / name
        img.save(out_path)
        out_paths.append(str(out_path))
        print(f"出力: {out_path}  ({out_w}x{out_h})")

    # スプライトシート（横並び）
    sheet = Image.new('RGBA', (out_w * len(aligned), out_h), (0, 0, 0, 0))
    for i, img in enumerate(aligned):
        sheet.paste(img, (i * out_w, 0))
    sheet_path = out_dir / 'spritesheet.png'
    sheet.save(sheet_path)
    print(f"\nスプライトシート: {sheet_path}  ({out_w * len(aligned)}x{out_h})")
    print(f"frameWidth={out_w}, frameHeight={out_h}  ← BootScene.js に設定")


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("使い方: python tools/sprite_align.py frame1.png frame2.png [...]")
        sys.exit(1)
    align_frames(sys.argv[1:])

#!/usr/bin/env python3
"""
tools/pipeline.py
白背景PNG → ゲーム用アセット自動変換スクリプト

Usage:
    python tools/pipeline.py --input raw/shop.png --type shop
    python tools/pipeline.py --input raw/house.png --type house --threshold 220
"""

import argparse
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw


def remove_white_background(img: Image.Image, threshold: int) -> Image.Image:
    """Step 1: RGB が全チャンネル threshold 以上のピクセルを透過に変換"""
    img = img.convert("RGBA")
    px = img.load()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = px[x, y]
            if r >= threshold and g >= threshold and b >= threshold:
                px[x, y] = (r, g, b, 0)
    return img


def trim_bbox(img: Image.Image) -> Image.Image:
    """Step 2: アルファ > 0 のピクセルの bounding box でクロップ"""
    bbox = img.getbbox()
    if bbox is None:
        print("[Step 2] 警告: 透明でないピクセルが見つかりません。トリミングをスキップします。")
        return img
    return img.crop(bbox)


def fit_to_footprint(img: Image.Image, cols: int, rows: int, cell: int) -> Image.Image:
    """Step 3: アスペクト比を維持してフットプリントサイズにフィット（letterbox）"""
    target_w = cols * cell
    target_h = rows * cell

    img_w, img_h = img.size
    scale = min(target_w / img_w, target_h / img_h)
    new_w = max(1, int(img_w * scale))
    new_h = max(1, int(img_h * scale))

    resized = img.resize((new_w, new_h), Image.LANCZOS)

    canvas = Image.new("RGBA", (target_w, target_h), (0, 0, 0, 0))
    offset_x = (target_w - new_w) // 2
    offset_y = (target_h - new_h) // 2
    canvas.paste(resized, (offset_x, offset_y), resized)
    return canvas


def harden_alpha(img: Image.Image) -> Image.Image:
    """Step 4: アルファ 1-30 → 0（フリンジ除去）、31以上 → 255（完全不透明）"""
    px = img.load()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = px[x, y]
            px[x, y] = (r, g, b, 0) if a <= 30 else (r, g, b, 255)
    return img


def overlay_grid(img: Image.Image, cell: int) -> Image.Image:
    """プレビュー用: 画像に 64px グリッド線を重ねる"""
    result = img.copy().convert("RGBA")
    draw = ImageDraw.Draw(result)
    w, h = result.size
    color = (255, 0, 0, 128)
    for x in range(0, w + 1, cell):
        draw.line([(x, 0), (x, h - 1)], fill=color, width=1)
    for y in range(0, h + 1, cell):
        draw.line([(0, y), (w - 1, y)], fill=color, width=1)
    return result


def make_preview(original: Image.Image, processed: Image.Image, cell: int, out_path: Path):
    """Step 6: 元画像（左）と処理後＋グリッド（右）を横並びで保存"""
    proc_w, proc_h = processed.size
    orig_resized = original.convert("RGBA").resize((proc_w, proc_h), Image.LANCZOS)
    proc_with_grid = overlay_grid(processed, cell)

    gap = 8
    canvas = Image.new("RGBA", (proc_w * 2 + gap, proc_h), (50, 50, 50, 255))
    canvas.paste(orig_resized, (0, 0))
    canvas.paste(proc_with_grid, (proc_w + gap, 0), proc_with_grid)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(str(out_path), "PNG")


def main():
    parser = argparse.ArgumentParser(description="白背景PNG → ゲーム用アセット変換")
    parser.add_argument("--input",     required=True,        help="入力画像パス")
    parser.add_argument("--type",      required=True,        help="種別（footprint.json のキー）")
    parser.add_argument("--threshold", type=int, default=230, help="白背景判定しきい値 0-255（デフォルト: 230）")
    parser.add_argument("--cell",      type=int, default=64,  help="1セルの px サイズ（デフォルト: 64）")
    args = parser.parse_args()

    # footprint.json ロード
    footprint_path = Path(__file__).parent / "footprint.json"
    if not footprint_path.exists():
        print(f"Error: {footprint_path} が見つかりません。")
        sys.exit(1)
    with open(footprint_path, encoding="utf-8") as f:
        footprint = json.load(f)

    if args.type not in footprint:
        print(f"Error: '{args.type}' は footprint.json に定義されていません。")
        print(f"定義済み種別: {', '.join(footprint.keys())}")
        sys.exit(1)

    fp = footprint[args.type]
    cols, rows = fp["cols"], fp["rows"]
    target_w = cols * args.cell
    target_h = rows * args.cell

    print(f"[pipeline] type={args.type}  footprint={cols}×{rows}  cell={args.cell}px")
    print(f"[pipeline] 出力サイズ: {target_w} × {target_h} px  threshold={args.threshold}")

    # 入力画像ロード
    input_path = Path(args.input)
    if not input_path.exists():
        print(f"Error: 入力ファイルが見つかりません: {input_path}")
        sys.exit(1)
    original = Image.open(str(input_path)).convert("RGBA")
    print(f"[Step 0] 元画像サイズ: {original.size}")

    # Step 1: 白背景除去
    img = remove_white_background(original.copy(), args.threshold)
    print(f"[Step 1] 白背景除去完了 (threshold={args.threshold})")

    # Step 2: bbox トリミング
    img = trim_bbox(img)
    print(f"[Step 2] bboxトリミング後: {img.size}")

    # Step 3: フットプリントにフィット
    img = fit_to_footprint(img, cols, rows, args.cell)
    print(f"[Step 3] フットプリントフィット後: {img.size}")

    # Step 4: アルファ硬化
    img = harden_alpha(img)
    print(f"[Step 4] アルファ硬化完了")

    # Step 5: 保存
    out_path = Path("assets") / "sprites" / "prop" / f"{args.type}.png"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(str(out_path), "PNG")
    print(f"[Step 5] 保存完了: {out_path}")

    # Step 6: プレビュー生成
    preview_path = Path("preview") / f"{args.type}_check.png"
    make_preview(original, img, args.cell, preview_path)
    print(f"[Step 6] プレビュー生成完了: {preview_path}")

    print(f"\n[OK] preview/{args.type}_check.png を確認してください。")


if __name__ == "__main__":
    main()

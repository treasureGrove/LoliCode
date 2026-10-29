"""Deterministically recolor only the connected backdrop of the original App icon.

Usage:
    python scripts/build/lolicode-refresh-icons.py --source ORIGINAL.png --output OUTPUT.png

The original portrait is never generated or redrawn. The existing white outer
matte becomes alpha; only boundary-connected lavender pixels become wine red.
The two-pixel anti-aliased contour is unmatted before PNG downsizing.
Requires Pillow, numpy and scipy.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import struct
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage


def boundary_connected(mask: np.ndarray, extra_seeds: list[tuple[int, int]] | None = None) -> np.ndarray:
    seed = np.zeros_like(mask)
    seed[0, :] = mask[0, :]
    seed[-1, :] = mask[-1, :]
    seed[:, 0] = mask[:, 0]
    seed[:, -1] = mask[:, -1]
    for x, y in extra_seeds or []:
        if not mask[y, x]:
            raise ValueError(f"The inspected backdrop seed {x},{y} is not eligible")
        seed[y, x] = True
    return ndimage.binary_propagation(seed, mask=mask)


def normalize_png(data: bytes) -> bytes:
    """Remove <=4/255 alpha resampling residue outside the rounded contour."""
    rgba = np.array(Image.open(io.BytesIO(data)).convert("RGBA"))
    transparent = rgba[:, :, 3] <= 4
    rgba[transparent] = 0
    buffer = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def normalize_native(directory: Path) -> None:
    # Only desktop packaging assets at the directory root are maintained here.
    for path in directory.glob("*.png"):
        path.write_bytes(normalize_png(path.read_bytes()))
    ico_path = directory / "icon.ico"
    ico = ico_path.read_bytes()
    count = struct.unpack_from("<H", ico, 4)[0]
    header = bytearray(ico[:6 + 16 * count])
    chunks = []
    offset = len(header)
    for index in range(count):
        entry = 6 + index * 16
        length, start = struct.unpack_from("<II", ico, entry + 8)
        png = normalize_png(ico[start:start + length])
        struct.pack_into("<II", header, entry + 8, len(png), offset)
        chunks.append(png)
        offset += len(png)
    ico_path.write_bytes(bytes(header) + b"".join(chunks))

    icns_path = directory / "icon.icns"
    icns = icns_path.read_bytes()
    chunks = []
    offset = 8
    while offset < len(icns):
        kind = icns[offset:offset + 4]
        size = struct.unpack_from(">I", icns, offset + 4)[0]
        payload = icns[offset + 8:offset + size]
        if payload.startswith(b"\x89PNG\r\n\x1a\n"):
            payload = normalize_png(payload)
        elif kind in {b"s8mk", b"l8mk"}:
            payload = bytes(0 if a <= 4 else a for a in payload)
        chunks.append(kind + struct.pack(">I", len(payload) + 8) + payload)
        offset += size
    body = b"".join(chunks)
    icns_path.write_bytes(b"icns" + struct.pack(">I", len(body) + 8) + body)
    print(f"Normalized desktop PNG/ICO/ICNS transparent contours in {directory}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--normalize-native", type=Path)
    args = parser.parse_args()
    if args.normalize_native:
        normalize_native(args.normalize_native)
        return
    if not args.source or not args.output:
        parser.error("--source and --output are required when not normalizing native icons")
    source = np.array(Image.open(args.source).convert("RGBA"))
    rgb = source[:, :, :3].astype(np.float64)
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]

    white_like = (rgb.min(axis=2) >= 242) & (rgb.max(axis=2) - rgb.min(axis=2) <= 14)
    lavender_like = (b >= 230) & (r >= 160) & (g >= 140) & (b - r >= 10) & (b - g >= 16)
    # These are inspected background gaps between the original hair strands,
    # at the original 1254px resolution. They do not select portrait highlights.
    if source.shape[:2] != (1254, 1254):
        raise ValueError("The verified masks and gap seeds require the original 1254px App art")
    gap_seeds = [(367, 161), (251, 276), (1095, 568), (1175, 667),
                 (1157, 703), (1138, 731), (113, 838), (1206, 846), (57, 1029)]
    backdrop = boundary_connected(white_like | lavender_like, gap_seeds)
    white = backdrop & white_like
    lavender = backdrop & ~white

    # Recover coverage at the white matte boundary, using an inward colour
    # sample. Only this two-pixel edge band is allowed to alter portrait RGB.
    solid = ~white
    interior = ndimage.binary_erosion(solid, iterations=3, border_value=1)
    _, inward = ndimage.distance_transform_edt(~interior, return_indices=True)
    foreground_sample = rgb[inward[0], inward[1]]
    white_distance = ndimage.distance_transform_edt(~white)
    edge = (white_distance > 0) & (white_distance <= 2)
    matte = np.full_like(rgb, 254.0)
    direction = foreground_sample - matte
    denominator = np.sum(direction * direction, axis=2)
    alpha = np.ones(r.shape, dtype=np.float64)
    coverage = np.sum((rgb - matte) * direction, axis=2) / np.maximum(denominator, 1)
    alpha[edge] = np.clip(coverage[edge], 0, 1)
    alpha[white] = 0
    unmatted = (rgb - (1 - alpha[:, :, None]) * matte) / np.maximum(alpha[:, :, None], 1 / 255)
    result_rgb = rgb.copy()
    result_rgb[edge] = np.clip(unmatted[edge], 0, 255)

    # Retain a very subtle version of the original background's light gradient.
    target = np.array([158.0, 36.0, 69.0])
    shade = np.clip(0.97 + (r - 195) / 600, 0.95, 1.035)
    result_rgb[lavender] = (shade[:, :, None] * target)[lavender]

    # Replace the lavender contribution in the existing two-pixel antialias
    # band; recover its foreground contribution rather than painting over it.
    foreground = ~backdrop
    foreground_core = ndimage.binary_erosion(foreground, iterations=3)
    background_core = ndimage.binary_erosion(lavender, iterations=3)
    _, foreground_indices = ndimage.distance_transform_edt(~foreground_core, return_indices=True)
    _, background_indices = ndimage.distance_transform_edt(~background_core, return_indices=True)
    f = rgb[foreground_indices[0], foreground_indices[1]]
    old_b = rgb[background_indices[0], background_indices[1]]
    new_b = (shade[:, :, None] * target)[background_indices[0], background_indices[1]]
    purple_edge = (ndimage.binary_dilation(lavender, iterations=2)
                   & ndimage.binary_dilation(foreground, iterations=2)
                   & ~white & (white_distance > 2))
    background_direction = old_b - f
    background_coverage = np.sum((rgb - f) * background_direction, axis=2) / np.maximum(
        np.sum(background_direction * background_direction, axis=2), 1)
    background_coverage = np.clip(background_coverage, 0, 1)
    corrected = rgb + background_coverage[:, :, None] * (new_b - old_b)
    result_rgb[purple_edge] = np.clip(corrected[purple_edge], 0, 255)
    # Fully transparent RGB is zero to avoid a white fringe in bad renderers.
    result_rgb[white] = 0
    result = np.dstack((np.rint(result_rgb), np.rint(alpha * 255))).astype(np.uint8)

    # Foreground pixels outside the explicit two-pixel matte edge are immutable.
    protected = ~backdrop & ~edge & ~purple_edge
    assert np.array_equal(result[:, :, :3][protected], source[:, :, :3][protected])
    assert np.all(result[:, :, 3][protected] == source[:, :, 3][protected])
    for y, x in [(0, 0), (0, -1), (-1, 0), (-1, -1)]:
        assert result[y, x, 3] == 0
    args.output.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(result, "RGBA").save(args.output, optimize=True)
    mask = np.zeros_like(source)
    mask[protected] = [35, 172, 105, 255]
    mask[lavender] = [158, 36, 69, 255]
    mask[edge & ~lavender] = [255, 181, 64, 255]
    mask[purple_edge] = [255, 181, 64, 255]
    mask[white] = [255, 255, 255, 255]
    Image.fromarray(mask, "RGBA").save(args.output.with_name("region-mask.png"))
    report = {
        "source": str(args.source.resolve()),
        "source_sha256": hashlib.sha256(args.source.read_bytes()).hexdigest(),
        "output_sha256": hashlib.sha256(args.output.read_bytes()).hexdigest(),
        "dimensions": [result.shape[1], result.shape[0]],
        "connected_white_pixels": int(white.sum()),
        "connected_lavender_pixels": int(lavender.sum()),
        "matte_edge_pixels": int(edge.sum()),
        "lavender_antialias_edge_pixels": int(purple_edge.sum()),
        "inspected_hair_gap_seeds": gap_seeds,
        "protected_portrait_pixels": int(protected.sum()),
        "protected_portrait_rgba_identical": True,
        "corners_alpha": [int(result[y, x, 3]) for y, x in [(0, 0), (0, -1), (-1, 0), (-1, -1)]],
        "alpha_zero_pixels": int((result[:, :, 3] == 0).sum()),
        "alpha_partial_pixels": int(((result[:, :, 3] > 0) & (result[:, :, 3] < 255)).sum()),
        "method": "Boundary-connected lavender/near-white masks; 2px white-matte unmix; no portrait regeneration",
    }
    args.output.with_suffix(".proof.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report))


if __name__ == "__main__":
    main()

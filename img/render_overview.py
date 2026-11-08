#!/usr/bin/env python3
"""Render one plain English overview table for all benchmark runs."""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
FB = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
FR = "/System/Library/Fonts/Supplemental/Arial.ttf"
FM = "/System/Library/Fonts/Menlo.ttc"

W = 1500
M = 48
BG = (255, 255, 255)
INK = (23, 27, 34)
MUT = (110, 118, 132)
LINE = (222, 226, 233)
SOFT = (246, 247, 250)
GREEN = (22, 132, 76)
RED = (190, 48, 48)
BLUE = (32, 88, 170)
_cache = {}


def f(path, size):
    key = (path, size)
    if key not in _cache:
        _cache[key] = ImageFont.truetype(path, size)
    return _cache[key]


def fmt_int(n):
    return f"{int(n):,}"


def fmt_money(v):
    return f"${v:,.4f}"


def fmt_pct(v):
    return f"{v * 100:.1f}%"


ROWS = [
    # name, context, tasks, correct, score, steps, wall s, folds, cost, hit
    ("Needle in a Haystack", "1M", 4, 4, 1.0, 2.25, 19.4, 5, 0.029674, 0.8883),
    ("RULER", "131K", 11, 11, 1.0, 2.18, 25.8, 13, 0.077781, 0.9035),
    ("MRCR", "131K", 6, 6, 1.0, 4.00, 289.5, 18, 0.296454, 0.8259),
    ("LongBench", "long docs", 6, 4, 0.6667, 5.67, 333.3, 28, 0.604093, 0.7977),
    ("LongBench-Pro", "long docs", 20, 14, 0.7750, 4.05, 189.5, 61, 1.301719, 0.4146),
    ("OOLONG", "131K", 5, 5, 1.0, 1.60, 102.7, 3, 0.111612, 0.1974),
    ("CodeGraph", "120K", 6, 6, 1.0, 3.67, 284.0, 93, 1.259369, 0.7689),
]


def score_color(v):
    if v >= 0.999:
        return GREEN
    if v >= 0.85:
        return BLUE
    return RED


def status(v):
    return "PASS" if v >= 0.999 else ("PARTIAL" if v > 0 else "FAIL")


HEADERS = ["Benchmark", "Context", "Tasks", "Passed", "Score",
           "Avg steps", "Wall time", "Folds", "Cost", "Cache hit", "Status"]
WIDTHS = [270, 100, 80, 90, 100, 110, 120, 80, 140, 120, 110]
ALIGNS = ["l", "c", "r", "r", "r", "r", "r", "r", "r", "r", "c"]


def draw_overview(d):
    y = M
    d.text((M, y), "AgentFold benchmark results", font=f(FB, 52), fill=INK)
    y += 74
    d.text((M, y), "Seven latest runs, 05.11.2026 - 07.11.2026  |  all numbers from the run summary.json files",
            font=f(FR, 22), fill=MUT)
    y += 26
    d.line([M, y, W - M, y], fill=INK, width=2)
    y += 24

    rows = [[(h, MUT, True) for h in HEADERS]]
    for name, ctx, n, ok, score, steps, wall, folds, cost, hit in ROWS:
        rows.append([
            (name, INK, True), (ctx, MUT, False), (str(n), INK, False),
            (str(ok), INK, False), (f"{score:.4f}", score_color(score), True),
            (f"{steps:.2f}", INK, False), (f"{wall:.1f} s", INK, False),
            (str(folds), INK, False), (fmt_money(cost), INK, False),
            (fmt_pct(hit), INK, False), (status(score), score_color(score), True),
        ])

    n = sum(r[2] for r in ROWS)
    ok = sum(r[3] for r in ROWS)
    cost = sum(r[8] for r in ROWS)
    steps = sum(r[5] * r[2] for r in ROWS) / n
    wall = sum(r[6] for r in ROWS)
    folds = sum(r[7] for r in ROWS)
    mean = sum(r[4] for r in ROWS) / len(ROWS)
    rows.append([
        ("Total", INK, True), ("-", MUT, False), (str(n), INK, True),
        (str(ok), INK, True), (f"{mean:.4f}", score_color(mean), True),
        (f"{steps:.2f}", INK, True), (f"{wall:.1f} s", INK, True),
        (str(folds), INK, True), (fmt_money(cost), INK, True), ("-", MUT, False),
        (f"{ok}/{n}", MUT, True),
    ])

    pad = 16
    row_h = 42
    x = M
    for ri, row in enumerate(rows):
        is_head = ri == 0
        is_total = ri == len(rows) - 1
        if is_head or is_total:
            d.rectangle([M, y, M + sum(WIDTHS), y + row_h], fill=SOFT)
        cx = x
        for ci, (text, color, bold) in enumerate(row):
            font = f(FB if (bold or is_head) else FR, 22)
            tw = d.textlength(text, font=font)
            if ALIGNS[ci] == "r":
                tx = cx + WIDTHS[ci] - pad - tw
            elif ALIGNS[ci] == "c":
                tx = cx + (WIDTHS[ci] - tw) / 2
            else:
                tx = cx + pad
            d.text((tx, y + (row_h - 26) / 2), text, font=font, fill=color)
            cx += WIDTHS[ci]
        d.line([M, y + row_h, M + sum(WIDTHS), y + row_h], fill=LINE, width=1)
        y += row_h
    d.line([M, y, M + sum(WIDTHS), y], fill=INK, width=2)
    y += 40

    d.text((M, y), "How to read this table", font=f(FB, 24), fill=INK)
    y += 40
    notes = [
        "Score is the mean per-task score from the run summary; Passed counts tasks scored 1.0.",
        "Avg steps is the mean number of agent steps per task; Folds counts completed context folds.",
        "Cache hit is cached prompt tokens divided by total prompt tokens for the run.",
        "Cost is the summed model spend for the run; Total cost is the sum across all seven runs.",
        "Total score is the mean of the seven benchmark scores, not a task-weighted average.",
    ]
    for note in notes:
        d.text((M, y), "- " + note, font=f(FR, 22), fill=INK)
        y += 32

    y += 20
    d.line([M, y, W - M, y], fill=LINE, width=1)
    y += 20
    d.text((M, y), "Generated from results/ summary.json  |  AgentFold", font=f(FR, 18), fill=MUT)
    return y + 52


def main():
    probe = ImageDraw.Draw(Image.new("RGB", (W, 100)))
    h = draw_overview(probe)
    im = Image.new("RGB", (W, int(h)), BG)
    draw_overview(ImageDraw.Draw(im))
    path = os.path.join(HERE, "bench-overview.png")
    im.save(path)
    print(f"bench-overview.png  {im.width}x{im.height}")


if __name__ == "__main__":
    main()

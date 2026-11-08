#!/usr/bin/env python3
"""Render one plain English benchmark table card per benchmark."""
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


DATA = [
    {
        "file": "bench-needle.png",
        "name": "Needle in a Haystack",
        "run": "exp-needle-1m-d2",
        "date": "05.11.2026",
        "ctx": "1,000,000 tokens",
        "n": 4, "correct": 4, "score": 1.0,
        "steps": 2.25, "wall": 19.4, "folds": 5, "lq": 0, "format": 0,
        "prompt": 24424, "cached": 21696, "comp": 4594, "hit": 0.8883,
        "cost": 0.029674, "per": 0.007418, "saved": 0.024733,
        "tasks": [("lookup", 2, 1.0), ("count", 2, 1.0)],
        "note": "Retrieval of a single fact and counting of repeated facts in a 1M-token haystack.",
    },
    {
        "file": "bench-ruler.png",
        "name": "RULER",
        "run": "exp-ruler-131k-d2-v3",
        "date": "06.11.2026",
        "ctx": "131,072 tokens",
        "n": 11, "correct": 11, "score": 1.0,
        "steps": 2.18, "wall": 25.8, "folds": 13, "lq": 0, "format": 0,
        "prompt": 71683, "cached": 64768, "comp": 11650, "hit": 0.9035,
        "cost": 0.077781, "per": 0.007071, "saved": 0.073836,
        "tasks": [
            ("niah_single_1", 1, 1.0), ("niah_single_2", 1, 1.0), ("niah_single_3", 1, 1.0),
            ("niah_multikey_1", 1, 1.0), ("niah_multikey_2", 1, 1.0), ("niah_multikey_3", 1, 1.0),
            ("niah_multiquery", 1, 1.0), ("niah_multivalue", 1, 1.0),
            ("vt", 1, 1.0), ("cwe", 1, 1.0), ("fwe", 1, 1.0),
        ],
        "note": "Needle-in-a-haystack variants plus variable tracking and word-frequency tasks at 128K.",
    },
    {
        "file": "bench-mrcr.png",
        "name": "MRCR",
        "run": "exp-mrcr-131k-d2",
        "date": "06.11.2026",
        "ctx": "131,072 tokens",
        "n": 6, "correct": 6, "score": 1.0,
        "steps": 4.0, "wall": 289.5, "folds": 18, "lq": 0, "format": 0,
        "prompt": 86708, "cached": 71616, "comp": 58342, "hit": 0.8259,
        "cost": 0.296454, "per": 0.049409, "saved": 0.081642,
        "tasks": [("mrcr_coref", 6, 1.0)],
        "note": "Multi-round coreference over long conversations with many competing entities.",
    },
    {
        "file": "bench-longbench.png",
        "name": "LongBench",
        "run": "en-longbench-d2",
        "date": "07.11.2026",
        "ctx": "long documents",
        "n": 6, "correct": 4, "score": 0.6667,
        "steps": 5.67, "wall": 333.3, "folds": 28, "lq": 0, "format": 2,
        "prompt": 119785, "cached": 95552, "comp": 123937, "hit": 0.7977,
        "cost": 0.604093, "per": 0.100682, "saved": 0.108929,
        "tasks": [("Multi-Document QA", 4, 0.5), ("Code Repository Understanding", 2, 1.0)],
        "note": "Open-ended long-document QA; two tasks failed on answer format.",
    },
    {
        "file": "bench-longbench-pro.png",
        "name": "LongBench-Pro",
        "run": "en-longbench-pro-20-d2",
        "date": "07.11.2026",
        "ctx": "long documents",
        "n": 20, "correct": 14, "score": 0.775,
        "steps": 4.05, "wall": 189.5, "folds": 61, "lq": 4, "format": 6,
        "prompt": 526073, "cached": 218112, "comp": 248463, "hit": 0.4146,
        "cost": 1.301719, "per": 0.065086, "saved": 0.248648,
        "tasks": [
            ("T1 Retrieval & Ranking", 3, 0.6667), ("T2 Sequencing", 3, 0.6667),
            ("T3 Evidence-Grounded QA", 1, 0.0), ("T5 Attribution", 2, 1.0),
            ("T6 Aggregation", 7, 0.9286), ("T7 Consistency", 2, 0.5),
            ("T9 Version & Diff", 1, 1.0), ("T10 Rule Induction", 1, 1.0),
        ],
        "note": "Twenty hard long-context tasks across eight categories; the weakest area is evidence QA.",
    },
    {
        "file": "bench-oolong.png",
        "name": "OOLONG",
        "run": "rlm-port-oolong-d2",
        "date": "07.11.2026",
        "ctx": "131,072 tokens",
        "n": 5, "correct": 5, "score": 1.0,
        "steps": 1.6, "wall": 102.7, "folds": 3, "lq": 1, "format": 0,
        "prompt": 148820, "cached": 29376, "comp": 108359, "hit": 0.1974,
        "cost": 0.111612, "per": 0.022322, "saved": 0.026177,
        "tasks": [("MOST_FREQ", 1, 1.0), ("LEAST_FREQ", 1, 1.0), ("RELATIVE_FREQ", 3, 1.0)],
        "note": "Aggregation over long text: most, least and relatively frequent labels.",
    },
    {
        "file": "bench-codegraph.png",
        "name": "CodeGraph",
        "run": "rlm-port-codegraph-d2",
        "date": "07.11.2026",
        "ctx": "120,000 tokens",
        "n": 6, "correct": 6, "score": 1.0,
        "steps": 3.67, "wall": 284.0, "folds": 93, "lq": 0, "format": 0,
        "prompt": 746178, "cached": 573760, "comp": 197456, "hit": 0.7689,
        "cost": 1.259369, "per": 0.209895, "saved": 0.654086,
        "tasks": [("spec_specialist", 2, 1.0), ("diamond_deps", 2, 1.0), ("chain_hop", 2, 1.0)],
        "note": "Code-repository reasoning: specification lookup, diamond dependencies and multi-hop chains.",
    },
]


def score_color(v):
    if v >= 0.999:
        return GREEN
    if v >= 0.85:
        return BLUE
    return RED


def table(d, x, y, widths, rows, header=True, aligns=None):
    """Draw a simple ruled table. rows are lists of (text, color, bold)."""
    aligns = aligns or ["l"] * len(widths)
    pad = 16
    row_h = 40 if header else 38
    for ri, row in enumerate(rows):
        is_head = header and ri == 0
        h = row_h
        if is_head:
            d.rectangle([x, y, x + sum(widths), y + h], fill=SOFT)
        cx = x
        for ci, (text, color, bold) in enumerate(row):
            font = f(FB if (bold or is_head) else FR, 22)
            tw = d.textlength(text, font=font)
            if aligns[ci] == "r":
                tx = cx + widths[ci] - pad - tw
            elif aligns[ci] == "c":
                tx = cx + (widths[ci] - tw) / 2
            else:
                tx = cx + pad
            d.text((tx, y + (h - 26) / 2), text, font=font, fill=color)
            cx += widths[ci]
        d.line([x, y + h, x + sum(widths), y + h], fill=LINE, width=1)
        y += h
    d.line([x, y, x + sum(widths), y], fill=INK, width=2)
    return y


def draw_card(d, c):
    y = M
    # Header line.
    d.text((M, y), c["name"], font=f(FB, 52), fill=INK)
    y += 72
    d.text((M, y), f"Run {c['run']}  |  {c['date']}  |  Context {c['ctx']}", font=f(FR, 22), fill=MUT)
    y += 44
    d.line([M, y, W - M, y], fill=INK, width=2)
    y += 28

    # Result block: four plain figures.
    figs = [
        ("Tasks passed", f"{c['correct']} / {c['n']}", INK),
        ("Score", f"{c['score']:.4f}", score_color(c["score"])),
        ("Total cost", fmt_money(c["cost"]), INK),
        ("Cost per task", fmt_money(c["per"]), INK),
    ]
    colw = (W - 2 * M) // 4
    for i, (label, value, color) in enumerate(figs):
        x = M + i * colw
        d.text((x, y), label.upper(), font=f(FB, 18), fill=MUT)
        d.text((x, y + 28), value, font=f(FB, 44), fill=color)
        if i:
            d.line([x - 24, y + 4, x - 24, y + 84], fill=LINE, width=1)
    y += 116

    # Main metrics table.
    d.text((M, y), "Run metrics", font=f(FB, 24), fill=INK)
    y += 44
    metrics = [
        ("Average steps", f"{c['steps']:.2f}"),
        ("Wall time", f"{c['wall']:.1f} s"),
        ("Folding calls", str(c["folds"])),
        ("LLM query calls", str(c["lq"])),
        ("Format issues", str(c["format"])),
        ("Prompt tokens", fmt_int(c["prompt"])),
        ("Cached tokens", fmt_int(c["cached"])),
        ("Computed tokens", fmt_int(c["comp"])),
        ("Cache hit rate", fmt_pct(c["hit"])),
        ("Cost saved by cache", fmt_money(c["saved"])),
    ]
    half = (len(metrics) + 1) // 2
    colw = (W - 2 * M - 40) // 2
    rows = []
    for i in range(half):
        left = metrics[i]
        right = metrics[i + half] if i + half < len(metrics) else ("", "")
        rows.append([
            (left[0], MUT, False), (left[1], INK, True),
            (right[0], MUT, False), (right[1], INK, True),
        ])
    y = table(d, M, y, [colw - 170, 170, colw - 170, 170], rows,
              header=False, aligns=["l", "r", "l", "r"])
    y += 44

    # Task table.
    d.text((M, y), "Tasks", font=f(FB, 24), fill=INK)
    y += 44
    rows = [[("Task", MUT, True), ("Cases", MUT, True), ("Score", MUT, True), ("Status", MUT, True), ("", MUT, True)]]
    for name, n, s in c["tasks"]:
        status = "PASS" if s >= 0.999 else ("PARTIAL" if s > 0 else "FAIL")
        rows.append([
            (name, INK, False), (str(n), INK, False),
            (f"{s:.4f}", score_color(s), True),
            (status, score_color(s), True),
            ("", INK, False),
        ])
    total = sum(t[1] for t in c["tasks"])
    rows.append([
        ("Total", INK, True), (str(total), INK, True),
        (f"{c['score']:.4f}", score_color(c["score"]), True), ("", INK, False), ("", INK, False),
    ])
    y = table(d, M, y, [620, 140, 180, 200, W - 2 * M - 1140], rows,
              aligns=["l", "r", "r", "l", "l"])
    y += 44

    # Note.
    words = c["note"].split()
    lines, cur = [], ""
    maxw = W - 2 * M
    for w in words:
        trial = (cur + " " + w).strip()
        if d.textlength(trial, font=f(FR, 22)) <= maxw:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    d.text((M, y), "Note", font=f(FB, 18), fill=MUT)
    y += 30
    for line in lines:
        d.text((M, y), line, font=f(FR, 22), fill=INK)
        y += 32
    y += 20
    d.line([M, y, W - M, y], fill=LINE, width=1)
    y += 20
    d.text((M, y), "Generated from results/ summary.json  |  AgentFold", font=f(FR, 18), fill=MUT)
    return y + 52


def main():
    for c in DATA:
        probe = ImageDraw.Draw(Image.new("RGB", (W, 100)))
        h = draw_card(probe, c)
        im = Image.new("RGB", (W, int(h)), BG)
        draw_card(ImageDraw.Draw(im), c)
        path = os.path.join(HERE, c["file"])
        im.save(path)
        print(f"{c['file']}  {im.width}x{im.height}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""contrast_check.py — 静态 WCAG 2.1 对比度校验 DESIGN.md（纯 stdlib，无第三方依赖）。

把 design 角色卡的颜色对比度检查从 B 腿 [render]（需浏览器）降为 A 腿 [diff]（静态解析）。
解析 DESIGN.md 的 :root{} CSS 变量 + markdown 表格语义色 → 启发式跨类配对（可被
`<!-- contrast: fg on bg, ... -->` 注释覆盖）→ 算对比度 → 标 < WCAG AA 4.5:1 的组合。

定位：确定性 advisory（info/warning），非强制必要条件。默认 exit 0；--strict 时低对比 exit 1。
不支持的色彩空间（oklch/lab/hsl）诚实跳过并标 skipped，不假装算过。

用法:
  python3 contrast_check.py <DESIGN.md>        # 或 - 读 stdin
  python3 contrast_check.py --format text <f>
  python3 contrast_check.py --strict <f>       # 有 <4.5 时 exit 1
"""
import argparse
import json
import re
import sys

AA_NORMAL = 4.5   # WCAG 2.1 SC 1.4.3 正文最小对比度
AA_LARGE = 3.0    # 大字号最小对比度（也用作"连大字都不过"的更严提示分界）

# 启发式分类关键词（子串匹配，小写）
FG_HINTS = ("ink", "text", "fg", "foreground", "muted", "label", "heading", "body", "on-")
BG_HINTS = ("bg", "background", "panel", "surface", "canvas", "base", "paper")


# ── 颜色解析 ──────────────────────────────────────────────────────
def to_rgb(value):
    """把单一颜色字符串转 (r,g,b)。非颜色或不支持的色彩空间返回 None。"""
    if not isinstance(value, str):
        return None
    v = value.strip()
    m = re.fullmatch(r"#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})", v)
    if m:
        h = m.group(1)
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    m = re.fullmatch(r"rgba?\(\s*([0-9]{1,3})[ ,]+([0-9]{1,3})[ ,]+([0-9]{1,3})"
                     r"(?:[ ,/]+[0-9.]+%?)?\s*\)", v)
    if m:
        rgb = tuple(min(255, int(g)) for g in m.groups())
        return rgb
    return None


def _is_color_attempt(value):
    """value 看起来是想表达一个颜色吗（用于区分"非颜色"vs"不支持的颜色空间"）。"""
    v = value.strip().lower()
    return v.startswith("#") or re.match(r"(rgb|rgba|oklch|oklab|lab|lch|hsl|hwb)\(", v) is not None


# ── 文档解析 ──────────────────────────────────────────────────────
def parse_colors(text):
    """从 :root{} 块 + markdown 表格语义色提取 {name: value}（保留原始 value 串）。"""
    colors = {}
    # :root { --name: value; ... } —— 只收"看起来是颜色"的（过滤 8px / shadow 等非颜色）
    for block in re.findall(r":root\s*\{(.*?)\}", text, re.DOTALL):
        for name, value in re.findall(r"--([\w-]+)\s*:\s*([^;]+);", block):
            v = value.split("/*")[0].strip()
            if _is_color_attempt(v):
                colors.setdefault(name.strip(), v)
    # 表格里的 `--name #hex`（语义色，常不在 :root）
    for name, hexv in re.findall(r"--([\w-]+)\s+(#[0-9a-fA-F]{3,6})", text):
        colors.setdefault(name.strip(), hexv)
    return colors


def parse_overrides(text):
    """提取 <!-- contrast: fg on bg, fg2 on bg2 --> → [(fg,bg),...]；无则 None。"""
    m = re.search(r"<!--\s*contrast:\s*(.*?)-->", text, re.DOTALL | re.IGNORECASE)
    if not m:
        return None
    pairs = []
    for part in m.group(1).split(","):
        mm = re.match(r"\s*([\w-]+)\s+on\s+([\w-]+)\s*", part, re.IGNORECASE)
        if mm:
            pairs.append((mm.group(1), mm.group(2)))
    return pairs or None


def classify(name):
    """启发式分类：fg / bg / either（语义色，可作前景与背景配）。"""
    n = name.lower()
    if any(h in n for h in FG_HINTS):
        return "fg"
    if any(n.startswith(h) or ("-" + h) in n or n == h for h in BG_HINTS):
        return "bg"
    return "either"


def resolve_token(name, colors):
    """把 override/短名解析到真实 token key（前缀归一）。
    精确匹配优先；否则唯一后缀匹配（key 以 "-<name>" 结尾）；歧义或零匹配返回 None。"""
    if name in colors:
        return name
    matches = [k for k in colors if k.endswith("-" + name)]
    return matches[0] if len(matches) == 1 else None


def build_pairs(colors, overrides):
    """决定要比哪些 (fg,bg) 对。注释覆盖优先；否则启发式跨类（fg/either × bg）。
    override 端用前缀归一解析到真实 token key；解析失败的对丢弃（lint 另报 info）。"""
    if overrides:
        out = []
        for fg, bg in overrides:
            rfg, rbg = resolve_token(fg, colors), resolve_token(bg, colors)
            if rfg is not None and rbg is not None:
                out.append((rfg, rbg))
        return out
    names = list(colors)
    bgs = [n for n in names if classify(n) == "bg"]
    fgs = [n for n in names if classify(n) in ("fg", "either")]
    pairs = []
    for fg in fgs:
        for bg in bgs:
            if fg != bg:
                pairs.append((fg, bg))
    return pairs


# ── WCAG 计算 ─────────────────────────────────────────────────────
def relative_luminance(rgb):
    def chan(c):
        s = c / 255.0
        return s / 12.92 if s <= 0.03928 else ((s + 0.055) / 1.055) ** 2.4
    r, g, b = rgb
    return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b)


def contrast_ratio(c1, c2):
    l1, l2 = relative_luminance(c1), relative_luminance(c2)
    hi, lo = max(l1, l2), min(l1, l2)
    return (hi + 0.05) / (lo + 0.05)


# ── 主入口 ────────────────────────────────────────────────────────
def lint(text):
    """返回 {findings, skipped, summary}。永不抛异常——问题作为数据返回。"""
    colors = parse_colors(text)
    overrides = parse_overrides(text)
    findings, skipped = [], []

    if not colors:
        findings.append({
            "severity": "info", "fg": None, "bg": None, "ratio": None,
            "message": "未发现颜色 token（无 :root 变量块、无表格语义色）——退回通用原则。",
        })
        return {"findings": findings, "skipped": skipped,
                "summary": {"pairs_checked": 0, "warnings": 0, "skipped": 0,
                            "pairing": "override" if overrides else "heuristic"}}

    # 解析颜色为 RGB，分出 skipped
    rgb = {}
    for name, value in colors.items():
        c = to_rgb(value)
        if c is None:
            if _is_color_attempt(value):
                skipped.append({"token": name, "value": value,
                                "reason": "unsupported-color-space" if not value.strip().startswith("#")
                                          else "invalid-hex"})
        else:
            rgb[name] = c

    # override 名归一失败 → info（不静默吞，避免短名拼错却以为检查过了）
    if overrides:
        seen_unresolved = set()
        for fg, bg in overrides:
            for nm in (fg, bg):
                if resolve_token(nm, colors) is None and nm not in seen_unresolved:
                    seen_unresolved.add(nm)
                    findings.append({
                        "severity": "info", "fg": None, "bg": None, "ratio": None,
                        "message": f"override 名 '{nm}' 未匹配到任何 token（不存在或前缀归一歧义）——该对未检查。",
                    })

    pairs = build_pairs(colors, overrides)
    checked = 0
    for fg, bg in pairs:
        if fg not in rgb or bg not in rgb:
            continue
        checked += 1
        ratio = round(contrast_ratio(rgb[fg], rgb[bg]), 2)
        if ratio < AA_NORMAL:
            findings.append({
                "severity": "warning", "fg": fg, "bg": bg, "ratio": ratio,
                "message": f"{fg}({colors[fg]}) on {bg}({colors[bg]}) = {ratio}:1，"
                           f"低于 WCAG AA {AA_NORMAL}:1"
                           + ("（连大字号 3:1 都不过）" if ratio < AA_LARGE else "（大字号 3:1 可过）"),
            })

    warnings = sum(1 for f in findings if f["severity"] == "warning")
    return {
        "findings": findings, "skipped": skipped,
        "summary": {"pairs_checked": checked, "warnings": warnings,
                    "skipped": len(skipped),
                    "pairing": "override" if overrides else "heuristic"},
    }


def _format_text(rep):
    lines = []
    s = rep["summary"]
    lines.append(f"Contrast check: {s['warnings']} warning(s), "
                 f"{s['pairs_checked']} pair(s) checked, {s['skipped']} skipped "
                 f"[pairing: {s['pairing']}]")
    for f in rep["findings"]:
        lines.append(f"  [{f['severity']}] {f['message']}")
    for sk in rep["skipped"]:
        lines.append(f"  [skipped] {sk['token']}: {sk['value']} ({sk['reason']})")
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description="静态 WCAG 对比度校验 DESIGN.md（advisory）")
    ap.add_argument("file", help="DESIGN.md 路径，或 - 读 stdin")
    ap.add_argument("--format", choices=["json", "text"], default="json")
    ap.add_argument("--strict", action="store_true",
                    help="有 <4.5 对比度时 exit 1（默认 advisory exit 0）")
    args = ap.parse_args(argv)

    text = sys.stdin.read() if args.file == "-" else open(args.file, encoding="utf-8").read()
    rep = lint(text)

    if args.format == "json":
        print(json.dumps(rep, ensure_ascii=False, indent=2))
    else:
        print(_format_text(rep))

    return 1 if (args.strict and rep["summary"]["warnings"] > 0) else 0


if __name__ == "__main__":
    sys.exit(main())

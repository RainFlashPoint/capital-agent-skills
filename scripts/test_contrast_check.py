#!/usr/bin/env python3
"""Tests for scripts/contrast_check.py — stdlib unittest, no third-party deps."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "contrast_check.py")
sys.path.insert(0, HERE)
import contrast_check as cc  # noqa: E402


def run_cli(*args, stdin=None):
    return subprocess.run(
        [sys.executable, SCRIPT, *args],
        input=stdin, capture_output=True, text=True,
    )


# ── 算法 ──────────────────────────────────────────────────────────
class TestColorParsing(unittest.TestCase):
    def test_hex6(self):
        self.assertEqual(cc.to_rgb("#ffffff"), (255, 255, 255))
        self.assertEqual(cc.to_rgb("#000000"), (0, 0, 0))
        self.assertEqual(cc.to_rgb("#1f2d24"), (31, 45, 36))

    def test_hex3_shorthand(self):
        self.assertEqual(cc.to_rgb("#fff"), (255, 255, 255))
        self.assertEqual(cc.to_rgb("#f00"), (255, 0, 0))

    def test_rgb_func(self):
        self.assertEqual(cc.to_rgb("rgb(31, 45, 36)"), (31, 45, 36))
        self.assertEqual(cc.to_rgb("rgb(255 255 255)"), (255, 255, 255))

    def test_non_color_returns_none(self):
        self.assertIsNone(cc.to_rgb("8px"))
        self.assertIsNone(cc.to_rgb("0 2px 0 rgba(31, 45, 36, 0.18)"))  # shadow 多值

    def test_unsupported_colorspace_returns_none(self):
        self.assertIsNone(cc.to_rgb("oklch(62% 0.18 250)"))
        self.assertIsNone(cc.to_rgb("hsl(120 50% 50%)"))


class TestLuminanceContrast(unittest.TestCase):
    def test_luminance_extremes(self):
        self.assertAlmostEqual(cc.relative_luminance((255, 255, 255)), 1.0, places=4)
        self.assertAlmostEqual(cc.relative_luminance((0, 0, 0)), 0.0, places=4)

    def test_contrast_black_white_is_21(self):
        self.assertAlmostEqual(
            cc.contrast_ratio((0, 0, 0), (255, 255, 255)), 21.0, places=2)

    def test_contrast_symmetric(self):
        a = cc.contrast_ratio((31, 45, 36), (246, 241, 230))
        b = cc.contrast_ratio((246, 241, 230), (31, 45, 36))
        self.assertAlmostEqual(a, b, places=6)

    def test_gray_on_white_below_aa(self):
        # #777777 on #fff ≈ 4.48 — 刚好低于 AA 4.5
        r = cc.contrast_ratio((0x77, 0x77, 0x77), (255, 255, 255))
        self.assertTrue(4.3 < r < 4.5, f"expected ~4.48, got {r}")


# ── 分类 + 配对 ──────────────────────────────────────────────────
class TestClassify(unittest.TestCase):
    def test_fg_names(self):
        for n in ("ink", "text", "fg", "muted", "on-primary", "heading", "body"):
            self.assertEqual(cc.classify(n), "fg", n)

    def test_bg_names(self):
        for n in ("bg", "panel", "surface", "canvas", "paper", "background"):
            self.assertEqual(cc.classify(n), "bg", n)

    def test_either_for_semantic(self):
        for n in ("green", "line", "blue", "danger"):
            self.assertEqual(cc.classify(n), "either", n)


class TestPairing(unittest.TestCase):
    def test_heuristic_crosses_fg_bg_only(self):
        colors = {"ink": "#000000", "bg": "#ffffff", "panel": "#eeeeee"}
        pairs = cc.build_pairs(colors, None)
        self.assertIn(("ink", "bg"), pairs)
        self.assertIn(("ink", "panel"), pairs)
        # 不比 bg×panel（背景×背景）
        self.assertNotIn(("bg", "panel"), pairs)
        self.assertNotIn(("panel", "bg"), pairs)

    def test_either_pairs_with_backgrounds(self):
        colors = {"green": "#6f925f", "bg": "#ffffff"}
        pairs = cc.build_pairs(colors, None)
        self.assertIn(("green", "bg"), pairs)

    def test_override_takes_precedence(self):
        colors = {"ink": "#000", "bg": "#fff", "green": "#6f925f", "panel": "#eee"}
        overrides = [("green", "panel")]
        pairs = cc.build_pairs(colors, overrides)
        self.assertEqual(pairs, [("green", "panel")])  # 启发式让位


class TestParseColors(unittest.TestCase):
    def test_root_block(self):
        text = """```css
:root {
  --bg:    #f6f1e6;  /* 暖奶油 */
  --ink:   #1f2d24;
  --radius: 8px;
  --shadow: 0 2px 0 rgba(31, 45, 36, 0.18);
}
```"""
        colors = cc.parse_colors(text)
        self.assertEqual(colors.get("bg"), "#f6f1e6")
        self.assertEqual(colors.get("ink"), "#1f2d24")
        self.assertNotIn("radius", colors)   # 非颜色不收
        self.assertNotIn("shadow", colors)   # 多值 shadow 不收

    def test_table_semantic_colors(self):
        text = "| shaped | `--blue #cddce2` | 已定形 |\n| built | `--orange #df8a54` | done |"
        colors = cc.parse_colors(text)
        self.assertEqual(colors.get("blue"), "#cddce2")
        self.assertEqual(colors.get("orange"), "#df8a54")


class TestParseOverrides(unittest.TestCase):
    def test_override_comment(self):
        text = "<!-- contrast: ink on bg, green on panel -->"
        ov = cc.parse_overrides(text)
        self.assertEqual(ov, [("ink", "bg"), ("green", "panel")])

    def test_no_override(self):
        self.assertIsNone(cc.parse_overrides("# no comment here"))


# ── 主入口 lint() + 负路径 ──────────────────────────────────────
class TestLint(unittest.TestCase):
    def test_reports_low_contrast(self):
        text = "```css\n:root {\n  --bg: #ffffff;\n  --muted: #777777;\n}\n```"
        rep = cc.lint(text)
        warns = [f for f in rep["findings"] if f["severity"] == "warning"]
        self.assertTrue(any(f["fg"] == "muted" and f["bg"] == "bg" for f in warns))

    def test_no_root_is_info_not_crash(self):
        rep = cc.lint("# DESIGN.md\n\n纯散文，无 :root 无表格色。")
        self.assertEqual(rep["summary"]["warnings"], 0)
        self.assertTrue(any(f["severity"] == "info" for f in rep["findings"]))

    def test_bad_hex_skipped(self):
        text = "```css\n:root {\n  --bg: #ffffff;\n  --x: #gggggg;\n}\n```"
        rep = cc.lint(text)
        self.assertTrue(any(s["token"] == "x" for s in rep["skipped"]))

    def test_oklch_skipped_honestly(self):
        text = "```css\n:root {\n  --bg: #ffffff;\n  --accent: oklch(62% 0.18 250);\n}\n```"
        rep = cc.lint(text)
        sk = [s for s in rep["skipped"] if s["token"] == "accent"]
        self.assertEqual(len(sk), 1)
        self.assertEqual(sk[0]["reason"], "unsupported-color-space")

    def test_empty(self):
        rep = cc.lint("")
        self.assertEqual(rep["summary"]["warnings"], 0)


# ── CLI ──────────────────────────────────────────────────────────
class TestCLI(unittest.TestCase):
    def _write(self, text):
        fd, p = tempfile.mkstemp(suffix=".md")
        with os.fdopen(fd, "w") as f:
            f.write(text)
        return p

    def test_default_exit_zero_even_with_low_contrast(self):
        p = self._write("```css\n:root {\n  --bg: #fff;\n  --muted: #777;\n}\n```")
        r = run_cli(p)
        self.addCleanup(os.remove, p)
        self.assertEqual(r.returncode, 0)            # advisory：默认不卡
        json.loads(r.stdout)                          # 合法 JSON

    def test_strict_exit_one_on_low_contrast(self):
        p = self._write("```css\n:root {\n  --bg: #fff;\n  --muted: #777;\n}\n```")
        r = run_cli(p, "--strict")
        self.addCleanup(os.remove, p)
        self.assertEqual(r.returncode, 1)

    def test_stdin_dash(self):
        r = run_cli("-", stdin="```css\n:root{--bg:#fff;--ink:#000;}\n```")
        self.assertEqual(r.returncode, 0)
        json.loads(r.stdout)

    def test_real_design_md(self):
        real = os.path.normpath(os.path.join(HERE, "..", "DESIGN.md"))
        if not os.path.exists(real):
            self.skipTest("no repo-root DESIGN.md")
        r = run_cli(real)
        self.assertEqual(r.returncode, 0)
        rep = json.loads(r.stdout)
        self.assertIn("summary", rep)
        self.assertGreater(rep["summary"]["pairs_checked"], 0)


# ── 前缀归一匹配（happycompany 场景）──────────────────────────────
class TestResolveToken(unittest.TestCase):
    def setUp(self):
        self.colors = {
            "color-text-primary": "#182026",
            "color-text-muted": "#687782",
            "color-bg-base": "#ffffff",
            "color-bg-deep": "#f6f7f8",
        }

    def test_exact_match_wins(self):
        self.assertEqual(cc.resolve_token("color-bg-base", self.colors), "color-bg-base")

    def test_suffix_shortname(self):
        self.assertEqual(cc.resolve_token("text-primary", self.colors), "color-text-primary")
        self.assertEqual(cc.resolve_token("bg-deep", self.colors), "color-bg-deep")

    def test_ambiguous_returns_none(self):
        colors = {"a-tone": "#000", "b-tone": "#111"}
        self.assertIsNone(cc.resolve_token("tone", colors))

    def test_no_match_returns_none(self):
        self.assertIsNone(cc.resolve_token("nope", self.colors))

    def test_exact_beats_suffix(self):
        # 同时存在 "primary" 和 "color-text-primary"，写 "primary" 精确命中 "primary"
        colors = {"primary": "#000", "color-text-primary": "#111"}
        self.assertEqual(cc.resolve_token("primary", colors), "primary")


class TestPrefixMatchInPipeline(unittest.TestCase):
    def test_build_pairs_override_shortname(self):
        colors = {"color-text-primary": "#000", "color-bg-base": "#fff"}
        pairs = cc.build_pairs(colors, [("text-primary", "bg-base")])
        self.assertEqual(pairs, [("color-text-primary", "color-bg-base")])

    def test_lint_override_shortname_happycompany(self):
        # text-muted #687782 on bg-deep #f6f7f8 ≈ 4.3 < 4.5
        text = ("<!-- contrast: text-muted on bg-deep -->\n```css\n:root{\n"
                "  --color-text-muted: #687782;\n  --color-bg-deep: #f6f7f8;\n}\n```")
        rep = cc.lint(text)
        warns = [f for f in rep["findings"] if f["severity"] == "warning"]
        self.assertEqual(len(warns), 1)
        self.assertEqual(warns[0]["fg"], "color-text-muted")
        self.assertEqual(warns[0]["bg"], "color-bg-deep")

    def test_lint_override_unresolved_is_info_not_silent(self):
        text = ("<!-- contrast: ghost on bg-base -->\n```css\n:root{\n"
                "  --color-bg-base: #fff;\n}\n```")
        rep = cc.lint(text)
        infos = [f for f in rep["findings"] if f["severity"] == "info"]
        self.assertTrue(any("ghost" in f.get("message", "") for f in infos))


if __name__ == "__main__":
    unittest.main(verbosity=2)

#!/usr/bin/env python3
"""spec-web-review build —— 把任意 markdown 渲染成「可划词批注」的审阅网页。

用法:
  python3 build.py <source.md> <outdir> [--title "标题"]

产物(写到 outdir):
  index.html      渲染后的审阅页 + 注入批注层
  annotate.css/js 划词批注层(从 skill assets 复制)
  server.py       零依赖回收服务器(从 skill assets 复制)

零依赖(仅 Python 标准库)。md 子集足够 spec 用:标题/段落/有序无序列表/
GFM 表格/围栏代码/引用/行内 code、**粗体**、链接。
"""
import sys, os, re, html, shutil, argparse

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = HERE  # build.py 与 annotate.*/server.py 同目录(references/web-review/)


# ---------------- 行内 ----------------
def inline(text):
    # 先抽出行内 code 占位,避免内部被加粗/转义破坏
    spans = []
    def stash(m):
        spans.append('<code>' + html.escape(m.group(1)) + '</code>')
        return '\x00%d\x00' % (len(spans) - 1)
    text = re.sub(r'`([^`]+)`', stash, text)
    text = html.escape(text)
    text = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', text)
    text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2" target="_blank" rel="noopener">\1</a>', text)
    text = re.sub(r'\x00(\d+)\x00', lambda m: spans[int(m.group(1))], text)
    return text


# ---------------- 块级 ----------------
def render(md):
    lines = md.split('\n')
    out, i, n = [], 0, len(lines)
    section_open = False

    def close_section():
        nonlocal section_open
        if section_open:
            out.append('</div></section>')
            section_open = False

    while i < n:
        ln = lines[i]

        # 围栏代码
        if ln.strip().startswith('```'):
            buf = []
            i += 1
            while i < n and not lines[i].strip().startswith('```'):
                buf.append(html.escape(lines[i])); i += 1
            i += 1
            out.append('<pre class="code"><code>' + '\n'.join(buf) + '</code></pre>')
            continue

        # 标题
        m = re.match(r'^(#{1,6})\s+(.*)$', ln)
        if m:
            lvl, txt = len(m.group(1)), inline(m.group(2).strip())
            if lvl == 1:
                close_section()
                out.append('<header><h1>%s</h1></header>' % txt)
            elif lvl == 2:
                close_section()
                out.append('<section><div class="wrap"><h2>%s</h2>' % txt)
                section_open = True
            else:
                out.append('<h%d>%s</h%d>' % (lvl, txt, lvl))
            i += 1
            continue

        # 表格 (GFM)
        if '|' in ln and i + 1 < n and re.match(r'^\s*\|?[\s:|-]+\|[\s:|-]+$', lines[i + 1]):
            def cells(row):
                row = row.strip().strip('|')
                return [c.strip() for c in row.split('|')]
            header = cells(ln); i += 2
            rows = []
            while i < n and '|' in lines[i] and lines[i].strip():
                rows.append(cells(lines[i])); i += 1
            t = ['<table><thead><tr>'] + ['<th>%s</th>' % inline(c) for c in header] + ['</tr></thead><tbody>']
            for r in rows:
                t.append('<tr>' + ''.join('<td>%s</td>' % inline(c) for c in r) + '</tr>')
            t.append('</tbody></table>')
            out.append(''.join(t))
            continue

        # 引用
        if ln.strip().startswith('>'):
            buf = []
            while i < n and lines[i].strip().startswith('>'):
                buf.append(inline(re.sub(r'^\s*>\s?', '', lines[i]))); i += 1
            out.append('<blockquote>' + '<br>'.join(buf) + '</blockquote>')
            continue

        # 列表(有序/无序)
        if re.match(r'^\s*([-*+]|\d+\.)\s+', ln):
            ordered = bool(re.match(r'^\s*\d+\.\s+', ln))
            tag = 'ol' if ordered else 'ul'
            items = []
            while i < n and re.match(r'^\s*([-*+]|\d+\.)\s+', lines[i]):
                items.append('<li>' + inline(re.sub(r'^\s*([-*+]|\d+\.)\s+', '', lines[i])) + '</li>')
                i += 1
            out.append('<%s>%s</%s>' % (tag, ''.join(items), tag))
            continue

        # 空行
        if not ln.strip():
            i += 1
            continue

        # 段落(合并连续非空行)
        buf = []
        while i < n and lines[i].strip() and not re.match(r'^(#{1,6}\s|\s*([-*+]|\d+\.)\s|>|```)', lines[i]) and '|' not in lines[i]:
            buf.append(inline(lines[i])); i += 1
        if buf:
            out.append('<p>' + '<br>'.join(buf) + '</p>')
        else:
            out.append('<p>' + inline(ln) + '</p>'); i += 1

    close_section()
    return '\n'.join(out)


TEMPLATE = '''<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<style>
:root{{--ink:#16181d;--soft:#4a4f5a;--faint:#8b909c;--paper:#f7f5f0;--card:#fff;--line:#e4e0d6;--accent:#3a3df0;--mono:ui-monospace,'SF Mono',Menlo,monospace;--sans:-apple-system,'PingFang SC','Segoe UI',sans-serif}}
*{{box-sizing:border-box}} body{{margin:0;background:var(--paper);color:var(--ink);font:15px/1.65 var(--sans);-webkit-font-smoothing:antialiased}}
.doc{{max-width:880px;margin:0 auto;padding:0 24px 80px}}
header{{padding:56px 0 8px}} h1{{font-size:clamp(28px,5vw,44px);line-height:1.1;letter-spacing:-.02em;margin:0}}
section{{border-top:1px solid var(--line);padding:8px 0}} .wrap{{padding:8px 0}}
h2{{font-size:clamp(20px,3vw,27px);margin:24px 0 10px;letter-spacing:-.01em}}
h3{{font-size:17px;margin:20px 0 6px}} h4{{font-size:15px;margin:16px 0 4px;color:var(--soft)}}
p{{margin:10px 0}} a{{color:var(--accent)}}
code{{font-family:var(--mono);font-size:.88em;background:#eceae3;padding:1px 5px;border-radius:5px}}
pre.code{{background:#16181d;color:#e8e6df;border-radius:10px;padding:14px 16px;overflow:auto}}
pre.code code{{background:none;color:inherit;padding:0;font-size:12.5px;line-height:1.55}}
ul,ol{{margin:10px 0;padding-left:22px}} li{{margin:4px 0}}
blockquote{{margin:12px 0;padding:8px 14px;border-left:3px solid var(--accent);background:var(--card);border-radius:0 8px 8px 0;color:var(--soft)}}
table{{width:100%;border-collapse:collapse;margin:14px 0;font-size:13.5px;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}}
th,td{{padding:8px 11px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}}
th{{background:#efece4;font-weight:650}} tr:last-child td{{border-bottom:0}}
</style>
<link rel="stylesheet" href="annotate.css">
</head><body>
<div class="doc">
{body}
</div>
<script src="annotate.js"></script>
<script>
/* live mode: 轮询 /rev,值变即 reload(agent rebuild 后页面自动更新)。无 /rev 静默降级手动刷新。 */
(function(){{var last=null;setInterval(function(){{
  fetch('/rev',{{cache:'no-store'}}).then(function(r){{return r.ok?r.text():null;}}).then(function(t){{
    if(t==null)return;if(last===null){{last=t;return;}}if(t!==last)location.reload();
  }}).catch(function(){{}});
}},2000);}})();
</script>
</body></html>'''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('source'); ap.add_argument('outdir'); ap.add_argument('--title', default=None)
    a = ap.parse_args()
    md = open(a.source, encoding='utf-8').read()
    title = a.title or (os.path.basename(a.source))
    body = render(md)
    os.makedirs(a.outdir, exist_ok=True)
    open(os.path.join(a.outdir, 'index.html'), 'w', encoding='utf-8').write(
        TEMPLATE.format(title=html.escape(title), body=body))
    for f in ('annotate.css', 'annotate.js', 'server.py'):
        shutil.copy(os.path.join(ASSETS, f), os.path.join(a.outdir, f))
    # rev 文件:每次 build 单调递增。注入页面的 poller 轮询 /rev,值变即 reload。
    # 缺它则 /rev 一直 404 → poller 拿不到值 → 自动刷新永不触发(历史 bug)。
    rev_path = os.path.join(a.outdir, 'rev')
    prev = 0
    if os.path.exists(rev_path):
        try:
            prev = int(open(rev_path, encoding='utf-8').read().strip() or '0')
        except ValueError:
            prev = 0
    open(rev_path, 'w', encoding='utf-8').write(str(prev + 1))
    print('built:', os.path.join(a.outdir, 'index.html'), '(rev=%d)' % (prev + 1))
    print('next: cd %s && python3 server.py 8777  → open http://127.0.0.1:8777/' % a.outdir)


if __name__ == '__main__':
    main()

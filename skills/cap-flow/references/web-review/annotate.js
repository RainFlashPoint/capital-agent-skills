/* annotate.js — 通用划词批注层
   划词 → 浮动按钮 → 评论气泡 → 高亮 + 右侧面板 → 提交 POST /feedback
   零依赖。注入任意页面即可。 */
(function () {
  'use strict';
  var DOC_ID = (document.title || 'doc').trim();
  var annotations = []; // {id, section, quote, comment}
  var seq = 0;
  var pendingRange = null;
  // 持久化 key:按页面路径 + 文档标题区分,reload / 自动刷新后不丢批注
  var STORE_KEY = 'an:' + (location.pathname || '/') + ':' + DOC_ID;
  function persist() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ seq: seq, annotations: annotations })); } catch (_) {}
  }

  var mk = function (t, c) { var e = document.createElement(t); if (c) e.className = c; return e; };
  var esc = function (s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; };

  // ---- UI elements ----
  var addBtn = mk('button'); addBtn.id = 'an-addbtn'; addBtn.textContent = '💬 添加评论';
  var pop = mk('div'); pop.id = 'an-pop';
  pop.innerHTML = '<div class="q"></div><textarea placeholder="写下对这段的评论…(⌘/Ctrl+Enter 保存)"></textarea>' +
    '<div class="row"><button class="cancel" type="button">取消</button><button class="save" type="button">保存批注</button></div>';
  var panel = mk('div'); panel.id = 'an-panel';
  panel.innerHTML =
    '<h4><span class="t">批注 <span class="cnt">0</span></span><button class="an-collapse" type="button" title="收起到侧边">‹</button></h4>' +
    '<div id="an-list"><div class="empty">在正文里选中任意文字，点“添加评论”。</div></div>' +
    '<div id="an-foot">' +
      '<div class="verdict">' +
        '<label><input type="radio" name="an-v" value="approve"><span>✅ 通过</span></label>' +
        '<label><input type="radio" name="an-v" value="changes" checked><span>✏️ 要改</span></label>' +
      '</div>' +
      '<button class="submit" type="button">提交反馈给 agent</button>' +
      '<div class="msg"></div>' +
    '</div>';
  var toggle = mk('button'); toggle.id = 'an-toggle'; toggle.textContent = '📝 批注面板';
  [addBtn, pop, panel, toggle].forEach(function (e) { document.body.appendChild(e); });

  var listEl = panel.querySelector('#an-list');
  var cntEl = panel.querySelector('.cnt');
  var msgEl = panel.querySelector('.msg');

  // ---- selection → add button ----
  function inUI(node) {
    while (node) { if (node.id === 'an-panel' || node.id === 'an-pop' || node.id === 'an-addbtn' || node.id === 'an-toggle' || node.id === 'an-toggle') return true; node = node.parentNode; }
    return false;
  }
  function sectionOf(node) {
    var el = node.nodeType === 3 ? node.parentElement : node;
    var sec = el && el.closest ? el.closest('section') : null;
    if (sec) { var h = sec.querySelector('h2'); if (h) return h.textContent.trim(); }
    return '(页面)';
  }
  document.addEventListener('mouseup', function (e) {
    if (inUI(e.target)) return;
    setTimeout(function () {
      var sel = window.getSelection();
      var text = sel ? sel.toString().trim() : '';
      if (!text || text.length < 2 || sel.rangeCount === 0) { addBtn.style.display = 'none'; return; }
      var r = sel.getRangeAt(0);
      if (inUI(r.startContainer) || inUI(r.endContainer)) return;
      pendingRange = r.cloneRange();
      var rect = r.getBoundingClientRect();
      addBtn.style.left = (rect.left + rect.width / 2 + window.scrollX) + 'px';
      addBtn.style.top = (rect.top + window.scrollY - 6) + 'px';
      addBtn.style.display = 'block';
    }, 1);
  });
  document.addEventListener('scroll', function () { addBtn.style.display = 'none'; }, true);

  // ---- open comment popover ----
  addBtn.addEventListener('click', function () {
    if (!pendingRange) return;
    addBtn.style.display = 'none';
    var rect = pendingRange.getBoundingClientRect();
    pop.querySelector('.q').textContent = pendingRange.toString().trim();
    pop.querySelector('textarea').value = '';
    pop.style.left = (rect.left + rect.width / 2 + window.scrollX) + 'px';
    pop.style.top = (rect.bottom + window.scrollY) + 'px';
    pop.style.display = 'block';
    pop.querySelector('textarea').focus();
  });
  pop.querySelector('.cancel').addEventListener('click', closePop);
  pop.querySelector('.save').addEventListener('click', saveAnnot);
  pop.querySelector('textarea').addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') saveAnnot();
    if (e.key === 'Escape') closePop();
  });
  function closePop() { pop.style.display = 'none'; pendingRange = null; }

  function saveAnnot() {
    var comment = pop.querySelector('textarea').value.trim();
    if (!comment) { pop.querySelector('textarea').focus(); return; }
    if (!pendingRange) { closePop(); return; }
    var id = 'a' + (++seq);
    var quote = pendingRange.toString().trim();
    var section = sectionOf(pendingRange.startContainer);
    highlight(pendingRange, id);
    annotations.push({ id: id, section: section, quote: quote, comment: comment });
    persist();
    renderList();
    closePop();
  }

  // ---- highlight a range (robust across nodes) ----
  function highlight(range, id) {
    try { var m = mk('mark', 'annot-hl'); m.dataset.aid = id; range.surroundContents(m); bindMark(m); return; }
    catch (_) {
      var nodes = [], w = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT, null);
      while (w.nextNode()) { if (range.intersectsNode(w.currentNode)) nodes.push(w.currentNode); }
      nodes.forEach(function (n) {
        var r = document.createRange(); r.selectNodeContents(n);
        if (n === range.startContainer) r.setStart(n, range.startOffset);
        if (n === range.endContainer) r.setEnd(n, range.endOffset);
        if (!r.toString().trim()) return;
        try { var m = mk('mark', 'annot-hl'); m.dataset.aid = id; r.surroundContents(m); bindMark(m); } catch (e) {}
      });
    }
  }
  function bindMark(m) {
    m.addEventListener('click', function () {
      var item = listEl.querySelector('[data-aid="' + m.dataset.aid + '"]');
      if (item) { item.scrollIntoView({ block: 'center', behavior: 'smooth' });
        item.style.outline = '2px solid var(--an-accent)'; setTimeout(function () { item.style.outline = ''; }, 1200); }
    });
  }

  // ---- render side list ----
  function renderList() {
    cntEl.textContent = annotations.length;
    if (!annotations.length) { listEl.innerHTML = '<div class="empty">在正文里选中任意文字，点“添加评论”。</div>'; return; }
    listEl.innerHTML = '';
    annotations.forEach(function (a) {
      var it = mk('div', 'an-item'); it.dataset.aid = a.id;
      it.innerHTML = '<span class="del" title="删除">✕</span><div class="sec">' + esc(a.section) + '</div>' +
        '<div class="quote">「<b>' + esc(a.quote.slice(0, 60)) + (a.quote.length > 60 ? '…' : '') + '</b>」</div>' +
        '<div class="cm">' + esc(a.comment) + '</div>' +
        (a.reply ? '<div class="reply"><span class="who">↩ agent</span>' + esc(a.reply) + '</div>' : '');
      it.addEventListener('click', function (e) {
        if (e.target.classList.contains('del')) { removeAnnot(a.id); return; }
        var m = document.querySelector('mark.annot-hl[data-aid="' + a.id + '"]');
        if (m) { m.scrollIntoView({ block: 'center', behavior: 'smooth' });
          document.querySelectorAll('mark.annot-hl').forEach(function (x) { x.classList.remove('active'); });
          document.querySelectorAll('mark.annot-hl[data-aid="' + a.id + '"]').forEach(function (x) { x.classList.add('active'); }); }
      });
      listEl.appendChild(it);
    });
  }
  function removeAnnot(id) {
    annotations = annotations.filter(function (a) { return a.id !== id; });
    document.querySelectorAll('mark.annot-hl[data-aid="' + id + '"]').forEach(function (m) {
      var p = m.parentNode; while (m.firstChild) p.insertBefore(m.firstChild, m); p.removeChild(m); p.normalize();
    });
    persist();
    renderList();
  }

  // ---- submit ----
  panel.querySelector('.submit').addEventListener('click', function () {
    var verdict = (panel.querySelector('input[name=an-v]:checked') || {}).value || 'changes';
    var payload = { doc: DOC_ID, verdict: verdict, submittedAt: new Date().toISOString(),
      count: annotations.length, annotations: annotations };
    msgEl.textContent = '提交中…'; msgEl.style.color = '#4a4f5a';
    fetch('/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload, null, 2) })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function () { msgEl.textContent = '✅ 已提交！agent 正在读取并统一修改，改完会在每条批注下回复。'; msgEl.style.color = '#0c8f5a'; })
      .catch(function (e) { msgEl.textContent = '✗ 提交失败(' + e.message + ')。确认服务器在跑。'; msgEl.style.color = '#cf3b3b'; });
  });

  // ---- collapse / expand(可见按钮,不再藏在双击里)----
  function collapse() { panel.classList.add('collapsed'); toggle.style.display = 'block'; }
  function expand() { panel.classList.remove('collapsed'); toggle.style.display = 'none'; }
  panel.querySelector('.an-collapse').addEventListener('click', collapse);
  toggle.addEventListener('click', expand);
  panel.querySelector('h4 .t').addEventListener('dblclick', collapse); // 双击标题也可收起

  // ---- restore persisted annotations(survive reload / 自动刷新)----
  function rehighlightQuote(quote, id) {
    if (!quote) return;
    var q = quote.trim();
    var root = document.querySelector('.doc') || document.body;
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    while (w.nextNode()) {
      var node = w.currentNode;
      if (inUI(node)) continue;
      var idx = node.nodeValue.indexOf(q);
      if (idx === -1) continue;          // 跨节点的长引用找不到 → 跳过高亮,列表项仍保留
      try {
        var r = document.createRange();
        r.setStart(node, idx); r.setEnd(node, idx + q.length);
        var m = mk('mark', 'annot-hl'); m.dataset.aid = id;
        r.surroundContents(m); bindMark(m);
      } catch (_) {}
      return;                            // 只标第一处
    }
  }
  (function restore() {
    var raw; try { raw = localStorage.getItem(STORE_KEY); } catch (_) { return; }
    if (!raw) return;
    var data; try { data = JSON.parse(raw); } catch (_) { return; }
    if (!data || !data.annotations || !data.annotations.length) return;
    annotations = data.annotations;
    seq = data.seq || annotations.length;
    annotations.forEach(function (a) { rehighlightQuote(a.quote, a.id); });
    renderList();
  })();

  // ---- agent replies(agent 处理批注后写 replies.json:{批注id: 回复文本};在每条批注下显示)----
  var lastRepliesRaw = null;
  function pollReplies() {
    fetch('/replies.json', { cache: 'no-store' }).then(function (r) { return r.ok ? r.text() : null; })
      .then(function (t) {
        if (t == null || t === lastRepliesRaw) return;
        lastRepliesRaw = t;
        var map; try { map = JSON.parse(t); } catch (_) { return; }
        if (!map || typeof map !== 'object') return;
        annotations.forEach(function (a) { if (map[a.id] != null) a.reply = map[a.id]; });
        renderList();
      }).catch(function () {});
  }
  setInterval(pollReplies, 3000); pollReplies();
})();

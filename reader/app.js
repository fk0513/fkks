/**
 * app.js —— fkks-reader 主逻辑
 *
 * 结构：
 *   1. 工具函数
 *   2. 全局状态
 *   3. 路由
 *   4. 书架：渲染 / 导入 / 删除 / 备份恢复
 *   5. 阅读器：EPUB & TXT
 *   6. 阅读设置
 *   7. 标注体系
 *   8. 事件绑定
 */
(function () {
  'use strict';

  /* ============================================================
   * 1. 工具
   * ============================================================ */

  var $ = function (sel) { return document.querySelector(sel); };
  var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtSize(bytes) {
    if (!bytes) return '0 B';
    var u = ['B', 'KB', 'MB', 'GB'], i = 0, n = bytes;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(n >= 10 || i === 0 ? 0 : 1) + ' ' + u[i];
  }

  var toastTimer = null;
  function toast(msg, ms) {
    var el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { el.hidden = true; }, 220);
    }, ms || 2200);
  }

  function confirmDialog(msg) {
    return window.confirm(msg);
  }

  /* ============================================================
   * 2. 全局状态
   * ============================================================ */

  var state = {
    books: [],
    book: null,          // 当前打开的书
    settings: null,      // 当前书的设置
    annotations: [],     // 当前书的标注
    epubBook: null,      // epub.js Book 实例
    rendition: null,     // epub.js Rendition
    txtReader: null,     // TxtReader 实例
    txtChapters: null,   // TXT 章节缓存
    toc: [],             // 展开后的目录（统一结构）
    progress: null,
    pendingSelection: null,  // { text, cfi, chapterIndex, chapterLabel, range }
    editingAnnotation: null,
    saveProgressTimer: null
  };

  var THEMES = {
    light: { bg: '#ffffff', fg: '#1c1c1e', muted: '#6b7280' },
    sepia: { bg: '#f5ecd9', fg: '#3d3226', muted: '#8a7a63' },
    dark:  { bg: '#1a1a1c', fg: '#c9c9cc', muted: '#8a8a90' }
  };

  var FONTS = {
    system: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
    serif: 'Georgia, "Songti SC", "SimSun", serif',
    sans: '"Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif',
    kai: '"Kaiti SC", "KaiTi", "STKaiti", serif'
  };

  /* ============================================================
   * 3. 路由
   * ============================================================ */

  function parseHash() {
    var h = location.hash.replace(/^#/, '');
    var m = /^\/read\/(.+)$/.exec(h);
    if (m) return { view: 'read', bookId: decodeURIComponent(m[1]) };
    return { view: 'shelf' };
  }

  function navigate(hash) {
    location.hash = hash;
  }

  function route() {
    var r = parseHash();
    closeAllPanels();
    if (r.view === 'read' && r.bookId) {
      $('#view-shelf').hidden = true;
      $('#view-reader').hidden = false;
      openBook(r.bookId);
    } else {
      destroyReader();
      $('#view-reader').hidden = true;
      $('#view-shelf').hidden = false;
      loadShelf();
    }
  }

  /* ============================================================
   * 4. 书架
   * ============================================================ */

  function loadShelf() {
    return DB.getBooks().then(function (books) {
      state.books = books;
      renderShelf();
    });
  }

  function renderShelf() {
    var grid = $('#shelf-grid');
    var empty = $('#shelf-empty');

    if (!state.books.length) {
      grid.innerHTML = '';
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    // 批量取进度
    Promise.all(state.books.map(function (b) { return DB.getProgress(b.id); }))
      .then(function (progs) {
        var html = '';
        state.books.forEach(function (b, i) {
          var p = progs[i];
          var pct = p ? Math.round(p.percentage || 0) : 0;
          var coverHtml;
          if (b.cover && b.cover instanceof Blob) {
            coverHtml = '<img class="book-cover-img" alt="">';
          } else {
            coverHtml = '<div class="book-cover-ph" style="background:' + phColor(b.title) + '">' +
                        esc((b.title || '?').slice(0, 1)) + '</div>';
          }
          html +=
            '<article class="book-card" data-id="' + esc(b.id) + '">' +
              '<div class="book-cover">' + coverHtml +
                '<button class="book-del" data-del="' + esc(b.id) + '" title="删除">✕</button>' +
              '</div>' +
              '<div class="book-meta">' +
                '<div class="book-title" title="' + esc(b.title) + '">' + esc(b.title) + '</div>' +
                '<div class="book-author">' + esc(b.author || '未知作者') + '</div>' +
                '<div class="book-progress">' +
                  '<div class="bar"><i style="width:' + pct + '%"></i></div>' +
                  '<span class="pct">' + (pct >= 99.5 ? '已读完' : pct + '%') + '</span>' +
                '</div>' +
              '</div>' +
            '</article>';
        });
        grid.innerHTML = html;
        hydrateCovers();
      });
  }

  function hydrateCovers() {
    state.books.forEach(function (b) {
      if (!(b.cover instanceof Blob)) return;
      var card = document.querySelector('.book-card[data-id="' + cssEsc(b.id) + '"]');
      if (!card) return;
      var img = card.querySelector('.book-cover-img');
      if (!img) return;
      var url = URL.createObjectURL(b.cover);
      img.src = url;
      img.onload = function () { URL.revokeObjectURL(url); };
    });
  }

  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  function phColor(seed) {
    var h = 0;
    seed = String(seed || 'x');
    for (var i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
    return 'linear-gradient(135deg, hsl(' + h + ',45%,62%), hsl(' + ((h + 40) % 360) + ',45%,52%))';
  }

  /* ---- 导入 ---- */

  var importing = false;

  function handleFiles(files) {
    if (!files || !files.length) return;
    if (importing) { toast('正在导入中，请稍候'); return; }
    importing = true;

    var list = Array.prototype.slice.call(files);
    var ok = 0, fail = [], firstId = null;

    var chain = Promise.resolve();
    list.forEach(function (f) {
      chain = chain.then(function () {
        return DB.estimate().then(function (est) {
          if (est && est.quota && est.usage + f.size > est.quota * 0.9) {
            throw new Error('浏览器存储空间不足');
          }
        }).then(function () {
          return Parsers.parseFile(f);
        }).then(function (info) {
          return DB.addBook(info);
        }).then(function (rec) {
          ok++;
          if (!firstId) firstId = rec.id;
        }).catch(function (err) {
          fail.push(f.name + '：' + (err && err.message ? err.message : '未知错误'));
        });
      });
    });

    chain.then(function () {
      importing = false;
      if (ok) toast('成功导入 ' + ok + ' 本');
      if (fail.length) {
        alert('以下文件导入失败：\n\n' + fail.join('\n'));
      }
      return loadShelf();
    }).catch(function (err) {
      importing = false;
      toast('导入出错：' + (err && err.message ? err.message : '未知错误'));
    });
  }

  function deleteBook(id) {
    var b = state.books.filter(function (x) { return x.id === id; })[0];
    var name = b ? b.title : '这本书';
    if (!confirmDialog('确定删除《' + name + '》吗？\n\n其阅读进度和全部标注会一并删除，且无法恢复。')) return;
    DB.deleteBook(id).then(function () {
      toast('已删除');
      return loadShelf();
    });
  }

  /* ---- 备份 / 恢复 ---- */

  function doBackup() {
    toast('正在生成备份…');
    DB.exportAll().then(function (json) {
      var blob = new Blob([json], { type: 'application/json' });
      var a = document.createElement('a');
      var d = new Date();
      var stamp = d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2) +
                  '-' + ('0' + d.getHours()).slice(-2) + ('0' + d.getMinutes()).slice(-2);
      a.href = URL.createObjectURL(blob);
      a.download = 'fkks-reader-backup-' + stamp + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
      toast('备份已下载');
    }).catch(function (err) {
      alert('备份失败：' + (err && err.message ? err.message : '未知错误'));
    });
  }

  function doRestore(file) {
    var fr = new FileReader();
    fr.onload = function () {
      DB.importAll(String(fr.result)).then(function (r) {
        alert('恢复完成：书籍 ' + r.books + ' 本，标注 ' + r.annotations + ' 条。');
        return loadShelf();
      }).catch(function (err) {
        alert('恢复失败：' + (err && err.message ? err.message : '未知错误'));
      });
    };
    fr.onerror = function () { alert('读取文件失败'); };
    fr.readAsText(file);
  }

  /* ============================================================
   * 5. 阅读器
   * ============================================================ */

  function openBook(bookId) {
    setLoading(true);
    state.annotations = [];
    state.pendingSelection = null;

    Promise.all([
      DB.getBook(bookId),
      DB.getSettings(bookId),
      DB.getProgress(bookId),
      DB.getAnnotations(bookId)
    ]).then(function (res) {
      var book = res[0];
      if (!book) { toast('书籍不存在'); navigate('#/'); return; }

      state.book = book;
      state.settings = res[1];
      state.progress = res[2];
      state.annotations = res[3] || [];

      DB.touchBook(bookId);

      $('#reader-book-title').textContent = book.title;
      $('#reader-chapter').textContent = res[2] && res[2].chapterLabel ? res[2].chapterLabel : '';
      applySettingsToUI();

      if (book.format === 'epub') return openEpub(book);
      return openTxt(book);
    }).then(function () {
      setLoading(false);
    }).catch(function (err) {
      setLoading(false);
      alert('打开失败：' + (err && err.message ? err.message : '未知错误'));
      navigate('#/');
    });
  }

  function setLoading(on) { $('#reader-loading').hidden = !on; }

  /* ---- EPUB ---- */

  function openEpub(book) {
    var stage = $('#reader-stage');
    var holder = $('#epub-viewer');
    holder.hidden = false;
    $('#txt-viewer').hidden = true;
    holder.innerHTML = '';

    return book.file.arrayBuffer().then(function (buf) {
      var epubBook = ePub(buf);
      state.epubBook = epubBook;
      state.txtReader = null;

      return epubBook.ready.then(function () {
        var flow = state.settings.flow === 'scrolled' ? 'scrolled-doc' : 'paginated';
        var rendition = epubBook.renderTo(holder, {
          width: '100%',
          height: '100%',
          flow: flow,
          spread: 'none',
          allowScriptedContent: false
        });
        state.rendition = rendition;

        // 主题 & 字号
        applyEpubTheme(rendition);

        // 目录
        return epubBook.loaded.navigation.then(function (nav) {
          state.toc = flattenToc(nav && nav.toc ? nav.toc : []);
          renderToc();
        }).catch(function () {
          state.toc = [];
          renderToc();
        }).then(function () {
          var target = state.progress && state.progress.location ? state.progress.location : undefined;
          return rendition.display(target);
        });
      }).then(function () {
        bindRenditionEvents(rendition);
        bindEpubAnnotations();
        setTimeout(function () { restoreEpubHighlights(); }, 260);
      });
    });
  }

  function flattenToc(nodes, depth, out) {
    depth = depth || 0; out = out || [];
    (nodes || []).forEach(function (item) {
      out.push({
        label: (item.label || '').trim() || '(无标题)',
        href: item.href || '',
        depth: depth
      });
      if (item.subitems && item.subitems.length) flattenToc(item.subitems, depth + 1, out);
    });
    return out;
  }

  function bindRenditionEvents(rendition) {
    rendition.on('relocated', function (loc) {
      var pct = 0;
      try {
        if (loc && loc.start && loc.start.percentage != null) pct = loc.start.percentage * 100;
      } catch (e) { /* ignore */ }

      var cfi = loc && loc.start ? loc.start.cfi : '';
      var chapIdx = 0, chapLabel = '';

      // 用当前 href 在目录里找章节
      var href = '';
      try { if (loc && loc.start && loc.start.href) href = loc.start.href; } catch (e2) {}

      if (href) {
        var hit = findTocByHref(href);
        chapIdx = hit.index;
        chapLabel = hit.label;
      }

      updateProgressUI(pct, chapLabel);
      scheduleSaveProgress({ location: cfi, percentage: pct, chapterIndex: chapIdx, chapterLabel: chapLabel });
      renderNotesList();
    });

    // 顶栏/底栏在滚动模式下的自动隐藏交给 CSS + 滚动监听
    rendition.on('selected', function (cfiRange, contents) {
      onEpubSelected(cfiRange, contents);
    });

    rendition.on('rendered', function () {
      applyEpubTheme(rendition);
      // 延迟恢复高亮（等布局稳定）
      setTimeout(function () { restoreEpubHighlights(); }, 60);
    });
  }

  function findTocByHref(href) {
    var clean = String(href).split('#')[0];
    var best = { index: -1, label: '' };
    state.toc.forEach(function (t, i) {
      var th = String(t.href).split('#')[0];
      if (th === clean || clean.indexOf(th) === 0 || th.indexOf(clean) === 0) {
        best = { index: i, label: t.label };
      }
    });
    return best;
  }

  function applyEpubTheme(rendition) {
    var th = THEMES[state.settings.theme] || THEMES.light;
    var font = FONTS[state.settings.fontFamily] || FONTS.system;
    var rules = {
      'html': { 'color': th.fg + ' !important' },
      'body': {
        'color': th.fg + ' !important',
        'background': th.bg + ' !important',
        'font-family': font + ' !important',
        'line-height': String(state.settings.lineHeight) + ' !important',
        'padding': '0 8px !important',
        'box-sizing': 'border-box !important'
      },
      'p, div, span, li, td, th': {
        'color': th.fg + ' !important',
        'font-family': 'inherit !important',
        'line-height': 'inherit !important'
      },
      'a': { 'color': '#4b8bf5 !important' },
      'img': { 'max-width': '100% !important', 'height': 'auto !important' },
      'p': { 'font-size': state.settings.fontSize + 'px !important' },
      '::selection': { 'background': 'rgba(255, 214, 102, .55)' }
    };
    try { rendition.themes.register('fkks', rules); rendition.themes.select('fkks'); } catch (e) {}
    try {
      rendition.themes.fontSize(state.settings.fontSize + 'px');
      rendition.themes.override('color', th.fg + ' !important');
      rendition.themes.override('background', th.bg + ' !important');
    } catch (e2) {}
  }

  /* ---- TXT ---- */

  function openTxt(book) {
    $('#epub-viewer').hidden = true;
    $('#epub-viewer').innerHTML = '';
    var holder = $('#txt-viewer');
    holder.hidden = false;

    state.epubBook = null;
    state.rendition = null;

    return book.file.arrayBuffer().then(function (buf) {
      var dec = Parsers.decodeBuffer(buf);
      var chapters = Parsers.splitChapters(dec.text);
      state.txtChapters = chapters;

      var start = state.progress && typeof state.progress.chapterIndex === 'number'
        ? state.progress.chapterIndex : 0;

      var reader = new TxtReader(holder, { flow: state.settings.flow });
      state.txtReader = reader;

      reader.onRelocated = function (loc) {
        updateProgressUI(loc.percentage, loc.chapterLabel);
        scheduleSaveProgress({
          location: 'chapter:' + loc.chapterIndex,
          percentage: loc.percentage,
          chapterIndex: loc.chapterIndex,
          chapterLabel: loc.chapterLabel
        });
        renderNotesList();
      };

      // TXT 目录 = 章节列表
      state.toc = chapters.map(function (c, i) {
        return { label: c.title || ('第 ' + (i + 1) + ' 节'), index: i, depth: 0 };
      });
      renderToc();

      return reader.render(chapters, start).then(function () {
        applyTxtStyle();
        bindTxtSelection();
        restoreTxtHighlights();
      });
    });
  }

  function applyTxtStyle() {
    var th = THEMES[state.settings.theme] || THEMES.light;
    var holder = $('#txt-viewer');
    holder.style.background = th.bg;
    holder.style.color = th.fg;
    holder.style.fontSize = state.settings.fontSize + 'px';
    holder.style.lineHeight = String(state.settings.lineHeight);
    holder.style.fontFamily = FONTS[state.settings.fontFamily] || FONTS.system;
    var stage = $('#reader-stage');
    stage.style.background = th.bg;
    document.documentElement.setAttribute('data-theme', state.settings.theme);
  }

  function updateProgressUI(pct, chapterLabel) {
    pct = Math.max(0, Math.min(100, pct || 0));
    $('#progress-slider').value = pct;
    $('#progress-percent').textContent = pct.toFixed(1) + '%';
    if (chapterLabel) $('#reader-chapter').textContent = chapterLabel;

    var pagesEl = $('#progress-pages');
    if (state.rendition) {
      state.rendition.location && state.rendition.location.start && null;
      var loc = state.rendition.currentLocation && state.rendition.currentLocation();
      if (loc && loc.start && loc.start.displayed) {
        pagesEl.textContent = '第 ' + (loc.start.location || '?') + ' 处';
      } else {
        pagesEl.textContent = '—';
      }
    } else if (state.txtReader) {
      pagesEl.textContent = '第 ' + (state.txtReader.index + 1) + '/' + state.txtReader.chapters.length + ' 章';
    }
  }

  function scheduleSaveProgress(p) {
    state.progress = Object.assign({}, state.progress || {}, p);
    clearTimeout(state.saveProgressTimer);
    state.saveProgressTimer = setTimeout(function () {
      if (!state.book) return;
      DB.saveProgress(state.book.id, p).catch(function () { /* 静默 */ });
    }, 400);
  }

  function destroyReader() {
    if (state.rendition) {
      try { state.rendition.destroy(); } catch (e) {}
      state.rendition = null;
    }
    if (state.epubBook) {
      try { state.epubBook.destroy(); } catch (e2) {}
      state.epubBook = null;
    }
    if (state.txtReader) {
      try { state.txtReader.destroy(); } catch (e3) {}
      state.txtReader = null;
    }
    state.book = null;
    state.book = null;
    state.pendingSelection = null;
    state.annotations = [];
    $('#epub-viewer').innerHTML = '';
    $('#txt-viewer').innerHTML = '';
    hideSelectionBar();
    closeNoteEditor();
  }

  /* ============================================================
   * 6. 阅读设置
   * ============================================================ */

  function applySettingsToUI() {
    var s = state.settings;
    $('#set-fontsize').value = s.fontSize;
    $('#val-fontsize').textContent = s.fontSize + 'px';
    $('#set-lineheight').value = s.lineHeight;
    $('#val-lineheight').textContent = s.lineHeight;
    $('#set-fontfamily').value = s.fontFamily;
    $('#set-flow').value = s.flow;
    $('#set-tapflip').checked = !!s.tapFlip;
    $$('#group-theme .theme-swatch').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-theme') === s.theme);
    });
    applyTxtStyle();
    document.documentElement.setAttribute('data-theme', s.theme);
  }

  function patchSettings(patch) {
    Object.assign(state.settings, patch);
    DB.saveSettings(state.book.id, state.settings).catch(function () {});
    return Promise.resolve();
  }

  /**
   * 关键点：改设置后保持阅读位置不跳动
   * EPUB：先记 CFI，改完再 display 回去
   * TXT ：记章节索引，重绘后回到同一章
   */
  function applyStyleChange(patch) {
    var keepCfi = null;
    if (state.rendition) {
      try {
        var loc = state.rendition.currentLocation();
        keepCfi = loc && loc.start ? loc.start.cfi : null;
      } catch (e) {}
    }
    var keepChapter = state.txtReader ? state.txtReader.index : 0;

    return patchSettings(patch).then(function () {
      applySettingsToUI();

      if (state.rendition) {
        applyEpubTheme(state.rendition);
        if (patch.flow) {
          var flow = patch.flow === 'scrolled' ? 'scrolled-doc' : 'paginated';
          return state.rendition.flow(flow).then(function () {
            return keepCfi ? state.rendition.display(keepCfi) : Promise.resolve();
          }).then(function () {
            setTimeout(function () { restoreEpubHighlights(); }, 120);
          });
        }
        return keepCfi ? state.rendition.display(keepCfi) : Promise.resolve();
      }

      if (state.txtReader) {
        if (patch.flow) {
          state.txtReader.setFlow(patch.flow);
        }
        return state.txtReader.render(state.txtChapters, keepChapter).then(function () {
          restoreTxtHighlights();
        });
      }
    });
  }

  /* ============================================================
   * 7. 标注体系
   * ============================================================ */

  /* ---- EPUB：选中 ---- */

  function onEpubSelected(cfiRange, contents) {
    var text = '';
    try { text = contents.window.getSelection().toString(); } catch (e) {}
    if (!text || !text.trim()) return;

    var chapterIndex = 0, chapterLabel = '';
    try {
      var href = contents.section && contents.section.href ? contents.section.href : '';
      if (href) {
        var hit = findTocByHref(href);
        chapterIndex = hit.index;
        chapterLabel = hit.label;
      }
    } catch (e2) {}

    state.pendingSelection = {
      text: text.trim(),
      cfi: cfiRange,
      chapterIndex: chapterIndex,
      chapterLabel: chapterLabel
    };

    showSelectionBar(contents, cfiRange);
  }

  function showSelectionBar(contents, cfiRange) {
    var bar = $('#selection-bar');
    var rect = null;
    try {
      var range = contents.range(cfiRange);
      rect = range.getBoundingClientRect();
      var iframeRect = contents.document.defaultView.frameElement.getBoundingClientRect();
      rect = {
        top: rect.top + iframeRect.top,
        left: rect.left + iframeRect.left,
        width: rect.width,
        height: rect.height
      };
    } catch (e) { /* fallthrough */ }

    if (!rect) return;
    bar.hidden = false;
    var w = bar.offsetWidth || 260;
    var left = Math.max(8, Math.min(window.innerWidth - w - 8, rect.left + rect.width / 2 - w / 2));
    var top = Math.max(60, rect.top - 52);
    bar.style.left = left + 'px';
    bar.style.top = top + 'px';
    bar.setAttribute('data-color-state', '');
  }

  function hideSelectionBar() {
    $('#selection-bar').hidden = true;
  }

  /* ---- TXT：选中 ---- */

  function bindTxtSelection() {
    var holder = $('#txt-viewer');
    holder.addEventListener('mouseup', txtSelectionHandler);
    holder.addEventListener('touchend', function () { setTimeout(txtSelectionHandler, 120); });
  }

  function txtSelectionHandler() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) { hideSelectionBar(); return; }
    var text = sel.toString();
    if (!text || !text.trim()) { hideSelectionBar(); return; }

    var holder = $('#txt-viewer');
    if (!holder.contains(sel.anchorNode)) return;

    var anchor = sel.anchorNode;
    var chapterIndex = state.txtReader ? state.txtReader.index : 0;
    var chapterLabel = state.txtChapters && state.txtChapters[chapterIndex]
      ? state.txtChapters[chapterIndex].title : '';

    // TXT 用「段落偏移」定位：找到 anchor 所在 <p> 的序号
    var paraIdx = 0;
    try {
      var p = anchor.nodeType === 1 ? anchor : anchor.parentElement;
      while (p && p.tagName !== 'P') p = p.parentElement;
      if (p) {
        var all = Array.prototype.slice.call(holder.querySelectorAll('p'));
        paraIdx = all.indexOf(p);
        if (paraIdx < 0) paraIdx = 0;
      }
    } catch (e) {}

    var rect = sel.getRangeAt(0).getBoundingClientRect();
    state.pendingSelection = {
      text: text.trim(),
      range: 'txt:' + chapterIndex + ':' + paraIdx + ':' + encodeURIComponent(text.trim()),
      chapterIndex: chapterIndex,
      chapterLabel: chapterLabel
    };

    showSelectionBarByRect(rect);
  }

  function showSelectionBarByRect(rect) {
    var bar = $('#selection-bar');
    bar.hidden = false;
    var w = bar.offsetWidth || 260;
    var left = Math.max(8, Math.min(window.innerWidth - w - 8, rect.left + rect.width / 2 - w / 2));
    var top = Math.max(60, rect.top - 52);
    bar.style.left = left + 'px';
    bar.style.top = top + 'px';
  }

  /* ---- 创建标注 ---- */

  function createHighlight(color, withNote) {
    var sel = state.pendingSelection;
    if (!sel || !state.book) { toast('没有选中的内容'); return; }

    var ann = {
      bookId: state.book.id,
      type: withNote ? 'note' : 'highlight',
      color: color,
      range: sel.cfi || sel.range || '',
      text: sel.text,
      note: '',
      chapterIndex: sel.chapterIndex || 0,
      chapterLabel: sel.chapterLabel || ''
    };

    DB.addAnnotation(ann).then(function (rec) {
      state.annotations.push(rec);
      // 清空选区
      try { window.getSelection().removeAllRanges(); } catch (e) {}
      if (state.rendition) {
        try {
          var contents = state.rendition.getContents();
          (contents || []).forEach(function (c) {
            try { c.window.getSelection().removeAllRanges(); } catch (e2) {}
          });
        } catch (e3) {}
      }
      hideSelectionBar();

      if (withNote) {
        openNoteEditor(rec);
      } else {
        paintAnnotation(rec);
        renderNotesList();
        toast('已高亮');
      }
    }).catch(function (err) {
      toast('标注失败：' + (err && err.message ? err.message : '未知错误'));
    });
  }

  function paintAnnotation(ann) {
    if (state.rendition && ann.range && ann.range.indexOf('/') === 0) {
      paintEpubAnnotation(ann);
    } else {
      restoreTxtHighlights();
    }
  }

  /* ---- EPUB 高亮绘制 ---- */

  var HL_STYLE = {
    yellow: { fill: '#ffd666', alpha: 0.45 },
    green:  { fill: '#7ddc8a', alpha: 0.42 },
    blue:   { fill: '#7cb8f7', alpha: 0.42 }
  };

  function paintEpubAnnotation(ann) {
    if (!state.rendition) return;
    var st = HL_STYLE[ann.color] || HL_STYLE.yellow;
    try {
      state.rendition.annotations.highlight(
        ann.range,
        { id: ann.id },
        function (e) { onAnnotationClick(ann.id, e); },
        'fkks-hl',
        { fill: st.fill, 'fill-opacity': String(st.alpha), 'mix-blend-mode': 'multiply' }
      );
    } catch (e) { /* 位置可能已失效，忽略 */ }
  }

  function restoreEpubHighlights() {
    if (!state.rendition) return;
    // 清掉旧的再画，避免重复
    state.annotations.forEach(function (ann) {
      if (ann.range && ann.range.indexOf('/') === 0) {
        try { state.rendition.annotations.remove(ann.range, 'highlight'); } catch (e) {}
      }
    });
    state.annotations.forEach(function (ann) {
      if (ann.range && ann.range.indexOf('/') === 0) paintEpubAnnotation(ann);
    });
  }

  function onAnnotationClick(id, e) {
    var ann = state.annotations.filter(function (a) { return a.id === id; })[0];
    if (!ann) return;
    openNoteEditor(ann);
  }

  /* ---- TXT 高亮绘制 ---- */

  function restoreTxtHighlights() {
    var holder = $('#txt-viewer');
    if (!holder || holder.hidden) return;

    // 清除已有标记：把 mark 拆掉
    Array.prototype.slice.call(holder.querySelectorAll('mark.fkks-hl')).forEach(function (m) {
      var parent = m.parentNode;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      parent.normalize();
    });

    var chapter = state.txtReader ? state.txtReader.index : -1;
    state.annotations.forEach(function (ann) {
      if (!ann.range || ann.range.indexOf('txt:') !== 0) return;
      var parts = ann.range.split(':');
      var ci = parseInt(parts[1], 10);
      if (ci !== chapter) return;
      var plain = ann.text;
      if (!plain) return;

      var paras = holder.querySelectorAll('p');
      for (var i = 0; i < paras.length; i++) {
        var p = paras[i];
        var idx = p.textContent.indexOf(plain);
        if (idx < 0) continue;
        wrapText(p, idx, plain.length, ann);
        break; // 每段只标第一处，避免误伤
      }
    });
  }

  function wrapText(root, start, len, ann) {
    // 收集文本节点，定位 start..start+len
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var pos = 0, nodes = [], n;
    while ((n = walker.nextNode())) {
      var nl = n.nodeValue.length;
      if (pos + nl > start && pos < start + len) nodes.push({ node: n, s: pos, e: pos + nl });
      pos += nl;
      if (pos >= start + len) break;
    }
    if (!nodes.length) return;

    var st = HL_STYLE[ann.color] || HL_STYLE.yellow;

    // 从后往前替换，避免索引错乱
    for (var i = nodes.length - 1; i >= 0; i--) {
      var item = nodes[i];
      var localStart = Math.max(0, start - item.s);
      var localEnd = Math.min(item.node.nodeValue.length, start + len - item.s);
      if (localEnd <= localStart) continue;

      var val = item.node.nodeValue;
      var before = val.slice(0, localStart);
      var mid = val.slice(localStart, localEnd);
      var after = val.slice(localEnd);

      var mark = document.createElement('mark');
      mark.className = 'fkks-hl fkks-hl-' + (ann.color || 'yellow');
      mark.style.background = hexToRgba(st.fill, st.alpha);
      mark.dataset.annId = ann.id;
      mark.title = ann.note || '点击查看/编辑';
      mark.textContent = mid;

      var frag = document.createDocumentFragment();
      if (before) frag.appendChild(document.createTextNode(before));
      frag.appendChild(mark);
      if (after) frag.appendChild(document.createTextNode(after));

      item.node.parentNode.replaceChild(frag, item.node);
    }
  }

  function hexToRgba(hex, a) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return hex;
    return 'rgba(' + parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16) + ',' + a + ')';
  }

  /* ---- 笔记编辑 ---- */

  function openNoteEditor(ann) {
    state.editingAnnotation = ann;
    $('#note-quote').textContent = ann.text || '';
    $('#note-text').value = ann.note || '';
    $('#note-editor').hidden = false;
    setTimeout(function () { $('#note-text').focus(); }, 60);
  }

  function closeNoteEditor() {
    $('#note-editor').hidden = true;
    state.editingAnnotation = null;
  }

  function saveNote() {
    var ann = state.editingAnnotation;
    if (!ann) return;
    var note = $('#note-text').value.trim();
    DB.updateAnnotation(ann.id, { note: note, type: note ? 'note' : 'highlight' }).then(function () {
      ann.note = note;
      ann.type = note ? 'note' : 'highlight';
      paintAnnotation(ann);
      renderNotesList();
      closeNoteEditor();
      toast('已保存');
    });
  }

  function deleteAnnotation(ann) {
    if (!ann) return;
    if (!confirmDialog('删除这条标注？')) return;
    DB.deleteAnnotation(ann.id).then(function () {
      state.annotations = state.annotations.filter(function (a) { return a.id !== ann.id; });
      if (state.rendition && ann.range && ann.range.indexOf('/') === 0) {
        try { state.rendition.annotations.remove(ann.range, 'highlight'); } catch (e) {}
      }
      restoreTxtHighlights();
      renderNotesList();
      closeNoteEditor();
      toast('已删除');
    });
  }

  /* ---- 标注侧栏 ---- */

  function renderNotesList() {
    var listEl = $('#notes-list');
    if (!listEl) return;

    if (!state.annotations.length) {
      listEl.innerHTML = '<div class="notes-empty">还没有标注。<br>选中正文里的文字即可高亮或写笔记。</div>';
      return;
    }

    var groups = {};
    state.annotations.forEach(function (a) {
      var key = a.chapterLabel || ('位置 ' + (a.chapterIndex + 1));
      (groups[key] = groups[key] || []).push(a);
    });

    var html = '';
    Object.keys(groups).forEach(function (key) {
      html += '<div class="notes-group-title">' + esc(key) + '</div>';
      groups[key].forEach(function (a) {
        html +=
          '<div class="note-item fkks-hl-' + esc(a.color) + '" data-ann="' + esc(a.id) + '">' +
            '<div class="note-quote">' + esc(a.text) + '</div>' +
            (a.note ? '<div class="note-body">' + esc(a.note) + '</div>' : '') +
            '<div class="note-foot">' +
              '<span class="note-time">' + fmtTime(a.createdAt) + '</span>' +
              '<button class="note-del" data-del-ann="' + esc(a.id) + '">删除</button>' +
            '</div>' +
          '</div>';
      });
    });
    listEl.innerHTML = html;
  }

  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return d.getMonth() + 1 + '/' + d.getDate() + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  function jumpToAnnotation(id) {
    var ann = state.annotations.filter(function (a) { return a.id === id; })[0];
    if (!ann) return;
    closeAllPanels();

    if (state.rendition && ann.range && ann.range.indexOf('/') === 0) {
      state.rendition.display(ann.range).then(function () {
        setTimeout(function () { restoreEpubHighlights(); }, 100);
      });
      return;
    }
    if (state.txtReader) {
      state.txtReader.goTo(ann.chapterIndex).then ? null : null;
      state.txtReader.goTo(ann.chapterIndex);
      restoreTxtHighlights();
      // 滚动到高亮处
      setTimeout(function () {
        var m = $('#txt-viewer').querySelector('mark[data-ann-id="' + cssEsc(id) + '"]');
        if (m) m.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 120);
    }
  }

  /* ---- 目录渲染 ---- */

  function renderToc() {
    var el = $('#toc-list');
    if (!state.toc.length) {
      el.innerHTML = '<div class="notes-empty">本书没有目录信息</div>';
      return;
    }
    var html = '';
    state.toc.forEach(function (t, i) {
      html += '<button class="toc-item" data-toc="' + i + '" style="padding-left:' + (14 + (t.depth || 0) * 16) + 'px">' +
              esc(t.label) + '</button>';
    });
    el.innerHTML = html;
  }

  function jumpToToc(i) {
    var t = state.toc[i];
    if (!t) return;
    closeAllPanels();

    if (state.rendition && t.href) {
      state.rendition.display(t.href).then(function () {
        setTimeout(function () { restoreEpubHighlights(); }, 120);
      });
      return;
    }
    if (state.txtReader && typeof t.index === 'number') {
      state.txtReader.goTo(t.index);
      restoreTxtHighlights();
    }
  }

  /* ============================================================
   * 8. 面板控制
   * ============================================================ */

  function openPanel(id) {
    closeAllPanels();
    $('#' + id).hidden = false;
    $('#panel-backdrop').hidden = false;
    if (id === 'panel-notes') renderNotesList();
  }

  function closeAllPanels() {
    $$('.side-panel').forEach(function (p) { p.hidden = true; });
    $('#panel-backdrop').hidden = true;
  }

  /* ============================================================
   * 9. 事件绑定
   * ============================================================ */

  function bindEvents() {

    /* ---- 路由 ---- */
    window.addEventListener('hashchange', route);

    /* ---- 书架 ---- */
    $('#btn-import').addEventListener('click', function () { $('#file-input').click(); });
    $('#file-input').addEventListener('change', function (e) {
      handleFiles(e.target.files);
      e.target.value = '';
    });
    $('#btn-backup').addEventListener('click', doBackup);
    $('#btn-restore').addEventListener('click', function () { $('#restore-input').click(); });
    $('#restore-input').addEventListener('change', function (e) {
      if (e.target.files[0]) doRestore(e.target.files[0]);
      e.target.value = '';
    });

    $('#shelf-grid').addEventListener('click', function (e) {
      var delBtn = e.target.closest('[data-del]');
      if (delBtn) {
        e.stopPropagation();
        deleteBook(delBtn.getAttribute('data-del'));
        return;
      }
      var card = e.target.closest('.book-card');
      if (card) navigate('#/read/' + encodeURIComponent(card.getAttribute('data-id')));
    });

    /* ---- 全局拖拽导入 ---- */
    var dragDepth = 0;
    window.addEventListener('dragenter', function (e) {
      if ($('#view-shelf').hidden) return;
      e.preventDefault();
      dragDepth++;
      $('#drop-overlay').hidden = false;
    });
    window.addEventListener('dragover', function (e) {
      if ($('#view-shelf').hidden) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', function (e) {
      if ($('#view-shelf').hidden) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) $('#drop-overlay').hidden = true;
    });
    window.addEventListener('drop', function (e) {
      if ($('#view-shelf').hidden) return;
      e.preventDefault();
      dragDepth = 0;
      $('#drop-overlay').hidden = true;
      if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
    });

    /* ---- 阅读器工具条 ---- */
    $('#btn-back').addEventListener('click', function () { navigate('#/'); });
    $('#btn-toc').addEventListener('click', function () { openPanel('panel-toc'); });
    $('#btn-settings').addEventListener('click', function () { openPanel('panel-settings'); });
    $('#btn-open-notes').addEventListener('click', function () { openPanel('panel-notes'); });
    $('#btn-del-book').addEventListener('click', function () {
      if (!state.book) return;
      var id = state.book.id;
      closeAllPanels();
      if (!confirmDialog('确定删除《' + state.book.title + '》吗？\n\n进度和标注会一并删除，无法恢复。')) return;
      DB.deleteBook(id).then(function () { navigate('#/'); });
    });

    $$('.panel-close').forEach(function (b) {
      b.addEventListener('click', closeAllPanels);
    });
    $('#panel-backdrop').addEventListener('click', closeAllPanels);

    /* ---- 目录点击 ---- */
    $('#toc-list').addEventListener('click', function (e) {
      var item = e.target.closest('[data-toc]');
      if (item) jumpToToc(parseInt(item.getAttribute('data-toc'), 10));
    });

    /* ---- 标注侧栏点击 ---- */
    $('#notes-list').addEventListener('click', function (e) {
      var del = e.target.closest('[data-del-ann]');
      if (del) {
        e.stopPropagation();
        var ann = state.annotations.filter(function (a) { return a.id === del.getAttribute('data-del-ann'); })[0];
        deleteAnnotation(ann);
        return;
      }
      var item = e.target.closest('[data-ann]');
      if (item) jumpToAnnotation(item.getAttribute('data-ann'));
    });

    /* ---- TXT 内点击高亮 ---- */
    $('#txt-viewer').addEventListener('click', function (e) {
      var mark = e.target.closest('mark.fkks-hl');
      if (mark) {
        var ann = state.annotations.filter(function (a) { return a.id === mark.dataset.annId; })[0];
        if (ann) openNoteEditor(ann);
      }
    });

    /* ---- 选中操作条 ---- */
    $('#selection-bar').addEventListener('mousedown', function (e) {
      // 防止点击操作条时选区丢失
      e.preventDefault();
    });
    $$('#selection-bar .hl-btn').forEach(function (b) {
      b.addEventListener('click', function () { createHighlight(b.getAttribute('data-color'), false); });
    });
    $('#sel-note').addEventListener('click', function () { createHighlight('yellow', true); });
    $('#sel-cancel').addEventListener('click', function () {
      try { window.getSelection().removeAllRanges(); } catch (e) {}
      hideSelectionBar();
    });

    /* ---- 笔记编辑 ---- */
    $('#note-save').addEventListener('click', saveNote);
    $('#note-cancel').addEventListener('click', closeNoteEditor);
    $('#note-delete').addEventListener('click', function () { deleteAnnotation(state.editingAnnotation); });
    $('#note-text').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveNote(); }
      if (e.key === 'Escape') closeNoteEditor();
    });

    /* ---- 设置控件 ---- */
    $('#set-fontsize').addEventListener('input', function () {
      var v = parseInt(this.value, 10);
      $('#val-fontsize').textContent = v + 'px';
      state.settings.fontSize = v;
    });
    $('#set-fontsize').addEventListener('change', function () {
      applyStyleChange({ fontSize: parseInt(this.value, 10) });
    });

    $('#set-lineheight').addEventListener('input', function () {
      var v = parseFloat(this.value);
      $('#val-lineheight').textContent = v.toFixed(1);
      state.settings.lineHeight = v;
    });
    $('#set-lineheight').addEventListener('change', function () {
      applyStyleChange({ lineHeight: parseFloat(this.value) });
    });

    $('#group-theme').addEventListener('click', function (e) {
      var b = e.target.closest('[data-theme]');
      if (!b) return;
      $$('#group-theme .theme-swatch').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      applyStyleChange({ theme: b.getAttribute('data-theme') });
    });

    $('#set-fontfamily').addEventListener('change', function () {
      applyStyleChange({ fontFamily: this.value });
    });
    $('#set-flow').addEventListener('change', function () {
      applyStyleChange({ flow: this.value });
    });
    $('#set-tapflip').addEventListener('change', function () {
      patchSettings({ tapFlip: this.checked });
    });

    /* ---- 进度条拖动 ---- */
    $('#progress-slider').addEventListener('change', function () {
      var pct = parseFloat(this.value) / 100;
      if (state.rendition) {
        state.rendition.book.locations.length().then ? null : null;
        try {
          var cfi = state.rendition.book.locations.cfiFromPercentage(pct);
          if (cfi) state.rendition.display(cfi).then(function () {
            setTimeout(function () { restoreEpubHighlights(); }, 120);
          });
        } catch (e) {}
      } else if (state.txtReader && state.txtChapters) {
        var idx = Math.floor(pct * state.txtChapters.length);
        state.txtReader.goTo(idx);
        restoreTxtHighlights();
      }
    });

    /* ---- 键盘 ---- */
    document.addEventListener('keydown', function (e) {
      if ($('#view-reader').hidden) return;
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'textarea' || tag === 'input' || tag === 'select') return;

      if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault();
        state.rendition ? state.rendition.next() : (state.txtReader && state.txtReader.next());
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        state.rendition ? state.rendition.prev() : (state.txtReader && state.txtReader.prev());
      } else if (e.key === 'Escape') {
        closeAllPanels();
        hideSelectionBar();
        closeNoteEditor();
      }
    });

    /* ---- 点击左右区域翻页 ---- */
    /* EPUB 的点击交给 rendition 的 iframe 内部处理（见 bindRenditionEvents 补充） */
    $('#reader-stage').addEventListener('click', function (e) {
      if (!state.settings || !state.settings.tapFlip) return;
      if (!state.txtReader) return;
      if (e.target.closest('mark.fkks-hl')) return;
      var rect = this.getBoundingClientRect();
      var x = e.clientX - rect.left;
      if (x < rect.width * 0.25) state.txtReader.prev();
      else if (x > rect.width * 0.75) state.txtReader.next();
    });

    /* ---- 移动端触摸翻页（TXT） ---- */
    var touchX = 0, touchY = 0, touchT = 0;
    $('#txt-viewer').addEventListener('touchstart', function (e) {
      var t = e.touches[0];
      touchX = t.clientX; touchY = t.clientY; touchT = Date.now();
    }, { passive: true });
    $('#txt-viewer').addEventListener('touchend', function (e) {
      if (!state.settings || !state.settings.tapFlip) return;
      var t = e.changedTouches[0];
      var dx = t.clientX - touchX, dy = t.clientY - touchY;
      if (Date.now() - touchT > 600) return;
      if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy)) return;
      if (dx < 0) state.txtReader.next(); else state.txtReader.prev();
    });
  }

  /* ============================================================
   * 启动
   * ============================================================ */

  function init() {
    DB.open().then(function () {
      document.documentElement.setAttribute('data-theme', 'light');
      bindEvents();
      route();
      window.__APP_BOOTED__ = true;
    }).catch(function (err) {
      alert('数据库初始化失败：' + (err && err.message ? err.message : '未知错误'));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

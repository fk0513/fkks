/**
 * parsers.js —— 导入解析
 *
 * 职责：
 *   1. 识别文件类型（epub / txt）
 *   2. EPUB：提取书名、作者、封面、目录、章节数
 *   3. TXT ：识别编码、自动分章
 *
 * EPUB 的元数据解析走 ePub() API；TXT 走自研启发式规则。
 */
(function (global) {
  'use strict';

  /* ================= 通用 ================= */

  function extOf(name) {
    var m = /\.([a-z0-9]+)$/i.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }

  function baseName(name) {
    return (name || '').replace(/\.[a-z0-9]+$/i, '').trim() || '未命名';
  }

  /**
   * 解析一个 File 对象，返回书籍记录（不含 id）
   * @param {File} file
   * @returns {Promise<Object>}
   */
  function parseFile(file) {
    var ext = extOf(file.name);
    if (ext === 'epub') return parseEpub(file);
    if (ext === 'txt') return parseTxt(file);
    return Promise.reject(new Error('不支持的格式：.' + ext + '（目前支持 EPUB 和 TXT）'));
  }

  /* ================= EPUB ================= */

  function parseEpub(file) {
    // ePub 需要 ArrayBuffer
    return file.arrayBuffer().then(function (buf) {
      var book = ePub(buf);
      return book.ready.then(function () {
        return book.loaded.metadata;
      }).then(function (meta) {
        var info = {
          title: (meta && meta.title) || baseName(file.name),
          author: (meta && meta.creator) || '',
          format: 'epub',
          file: file,
          fileSize: file.size
        };

        // 封面（失败不阻断导入）
        return book.coverUrl().then(function (url) {
          if (!url) return null;
          return fetch(url).then(function (r) { return r.blob(); });
        }).catch(function () { return null; })
          .then(function (coverBlob) {
            info.cover = coverBlob;
            // 目录，用于统计章节数
            return book.loaded.navigation.catch(function () { return null; });
          })
          .then(function (nav) {
            var flat = nav && nav.toc ? countToc(nav.toc) : 0;
            info.chapterCount = flat;
            if (nav && nav.toc && nav.toc.length) {
              info._toc = flattenToc(nav.toc);
            }
            return info;
          });
      });
    }).catch(function (err) {
      throw new Error('EPUB 解析失败：' + (err && err.message ? err.message : '文件可能已损坏'));
    });
  }

  function countToc(nodes) {
    var n = 0;
    (nodes || []).forEach(function (item) {
      n += 1;
      if (item.subitems && item.subitems.length) n += countToc(item.subitems);
    });
    return n;
  }

  function flattenToc(nodes, depth, out) {
    depth = depth || 0;
    out = out || [];
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

  /* ================= TXT ================= */

  /**
   * 编码识别：优先 UTF-8 严格解码，失败则回退 GBK
   * （DOMTextDecoder 不支持 gbk 时用 TextDecoder 的别名尝试）
   */
  function decodeBuffer(buf) {
    // BOM 检测
    var bytes = new Uint8Array(buf);
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      return { text: new TextDecoder('utf-8').decode(buf), encoding: 'utf-8 (BOM)' };
    }
    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
      return { text: new TextDecoder('utf-16le').decode(buf), encoding: 'utf-16le' };
    }
    if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
      return { text: new TextDecoder('utf-16be').decode(buf), encoding: 'utf-16be' };
    }

    // 严格 UTF-8
    try {
      var text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      return { text: text, encoding: 'utf-8' };
    } catch (e) {
      // 回退 GBK
    }

    var aliases = ['gbk', 'gb18030', 'gb2312'];
    for (var i = 0; i < aliases.length; i++) {
      try {
        var t = new TextDecoder(aliases[i]).decode(buf);
        // 解码结果含大量替换字符则视为不可信
        if (t.indexOf('\uFFFD') === -1) {
          return { text: t, encoding: aliases[i] };
        }
      } catch (e2) { /* 浏览器不支持该别名，继续 */ }
    }

    // 最后兜底：非严格 utf-8
    return { text: new TextDecoder('utf-8').decode(buf), encoding: 'utf-8 (fallback)' };
  }

  // 常见章节标题规则
  var CHAPTER_PATTERNS = [
    /^\s*第\s*[0-9零一二三四五六七八九十百千万两]+\s*[章回节篇卷部]\s*[^\n]{0,40}$/,
    /^\s*Chapter\s+[0-9IVXLC]+\b[^\n]{0,40}$/i,
    /^\s*CHAPTER\s+[0-9IVXLC]+\b[^\n]{0,40}$/,
    /^\s*[0-9]{1,4}\s*[、.．]\s*[^\n]{1,40}$/,
    /^\s*【[^\n]{1,30}】\s*$/,
    /^\s*序\s*章?\s*$/,
    /^\s*前\s*言\s*$/,
    /^\s*后\s*记\s*$/,
    /^\s*尾\s*声\s*$/
  ];

  function isChapterTitle(line) {
    var t = line.trim();
    if (!t || t.length > 50) return false;
    for (var i = 0; i < CHAPTER_PATTERNS.length; i++) {
      if (CHAPTER_PATTERNS[i].test(t)) return true;
    }
    return false;
  }

  /**
   * 文本分章
   * @returns {Array<{title:string, content:string}>}
   */
  function splitChapters(text) {
    var normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // 按换行切行，但保留空行结构
    var lines = normalized.split('\n');
    var chapters = [];
    var cur = null;
    var curLines = [];

    function flush() {
      if (cur) {
        cur.content = curLines.join('\n').trim();
        chapters.push(cur);
      }
      curLines = [];
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (isChapterTitle(line)) {
        flush();
        cur = { title: line.trim(), content: '' };
      } else {
        if (!cur) cur = { title: '', content: '' };
        curLines.push(line);
      }
    }
    flush();

    // 完全没识别出章节 → 按固定长度切分
    if (chapters.length <= 1) {
      return chunkByLength(normalized);
    }

    // 首个无标题章节：加上「开始」占位，避免目录里出现空白项
    if (chapters[0] && !chapters[0].title) {
      chapters[0].title = '开始';
    }
    // 过滤掉内容为空的章节
    chapters = chapters.filter(function (c) { return c.content || c.title; });
    return chapters;
  }

  /** 兜底：按约 3000 字切一节 */
  function chunkByLength(text, size) {
    size = size || 3000;
    var out = [];
    var total = text.length;
    if (total === 0) return [{ title: '正文', content: '' }];
    var idx = 0, part = 1;
    while (idx < total) {
      var slice = text.slice(idx, idx + size);
      out.push({ title: '第 ' + part + ' 节', content: slice.trim() });
      idx += size;
      part++;
    }
    return out;
  }

  function parseTxt(file) {
    return file.arrayBuffer().then(function (buf) {
      var dec = decodeBuffer(buf);
      var chapters = splitChapters(dec.text);
      return {
        title: baseName(file.name),
        author: '',
        format: 'txt',
        file: file,
        fileSize: file.size,
        encoding: dec.encoding,
        chapters: chapters,
        chapterCount: chapters.length,
        cover: null
      };
    }).catch(function (err) {
      throw new Error('TXT 解析失败：' + (err && err.message ? err.message : '未知错误'));
    });
  }

  global.Parsers = {
    parseFile: parseFile,
    extOf: extOf,
    decodeBuffer: decodeBuffer,
    splitChapters: splitChapters,
    isChapterTitle: isChapterTitle
  };
})(window);

/**
 * txt-reader.js —— TXT 渲染器
 *
 * 把纯文本按章节渲染成可翻页/可滚动的 HTML。
 * 与 epub.js 一样对外暴露：render / next / prev / goTo / destroy
 */
(function (global) {
  'use strict';

  function TxtReader(container, options) {
    this.container = container;
    this.opts = options || {};
    this.chapters = [];
    this.index = 0;
    this.flow = this.opts.flow || 'paginated';
    this.onRelocated = null;
  }

  TxtReader.prototype.render = function (chapters, startChapter) {
    this.chapters = chapters || [];
    this.index = Math.max(0, Math.min(startChapter || 0, this.chapters.length - 1));
    this.container.classList.toggle('flow-scrolled', this.flow === 'scrolled');
    this._paint();
    return Promise.resolve();
  };

  TxtReader.prototype._paint = function () {
    var ch = this.chapters[this.index];
    var html = '';

    if (!ch) {
      html = '<p class="txt-empty">（本章无内容）</p>';
    } else {
      html += '<h2 class="txt-chapter-title">' + esc(ch.title) + '</h2>';
      var paras = (ch.content || '').split(/\n+/);
      paras.forEach(function (p) {
        var t = p.trim();
        if (t) html += '<p>' + esc(t) + '</p>';
      });
    }

    this.container.innerHTML = html;
    this.container.scrollTop = 0;

    if (this.onRelocated) {
      this.onRelocated(this._location());
    }
  };

  TxtReader.prototype._location = function () {
    var ch = this.chapters[this.index];
    var pct = this.chapters.length ? (this.index / this.chapters.length) * 100 : 0;
    return {
      chapterIndex: this.index,
      chapterLabel: ch ? ch.title : '',
      percentage: pct,
      totalChapters: this.chapters.length
    };
  };

  TxtReader.prototype.next = function () {
    if (this.index < this.chapters.length - 1) {
      // 滚动模式下先尝试页内滚动
      if (this.flow === 'scrolled') {
        var el = this.container;
        if (el.scrollTop + el.clientHeight < el.scrollHeight - 8) {
          el.scrollBy({ top: el.clientHeight * 0.9, behavior: 'smooth' });
          return;
        }
      }
      this.index++;
      this._paint();
    }
  };

  TxtReader.prototype.prev = function () {
    if (this.flow === 'scrolled') {
      var el = this.container;
      if (el.scrollTop > 8) {
        el.scrollBy({ top: -el.clientHeight * 0.9, behavior: 'smooth' });
        return;
      }
    }
    if (this.index > 0) {
      this.index--;
      this._paint();
    }
  };

  TxtReader.prototype.goTo = function (chapterIndex) {
    this.index = Math.max(0, Math.min(chapterIndex, this.chapters.length - 1));
    this._paint();
  };

  TxtReader.prototype.setFlow = function (flow) {
    this.flow = flow;
    this.container.classList.toggle('flow-scrolled', flow === 'scrolled');
  };

  /** 导出本书全文（供搜索/备份用，MVP 未使用但保留） */
  TxtReader.prototype.getChapters = function () { return this.chapters; };

  TxtReader.prototype.destroy = function () {
    this.container.innerHTML = '';
    this.chapters = [];
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  global.TxtReader = TxtReader;
})(window);

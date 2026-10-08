/**
 * db.js —— 原生 IndexedDB 封装
 *
 * 四张表：
 *   books       书籍（含原始文件 Blob、封面）
 *   progress    阅读进度
 *   annotations 标注（高亮 / 笔记）
 *   settings    阅读偏好（按书存）
 *
 * 不依赖任何第三方库。
 */
(function (global) {
  'use strict';

  var DB_NAME = 'fkks-reader';
  var DB_VERSION = 1;
  var STORES = ['books', 'progress', 'annotations', 'settings'];

  var _db = null;

  /** 打开数据库（幂等） */
  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = function (e) {
        var db = e.target.result;

        // books
        if (!db.objectStoreNames.contains('books')) {
          var books = db.createObjectStore('books', { keyPath: 'id' });
          books.createIndex('lastReadAt', 'lastReadAt');
          books.createIndex('importedAt', 'importedAt');
        }

        // progress
        if (!db.objectStoreNames.contains('progress')) {
          db.createObjectStore('progress', { keyPath: 'bookId' });
        }

        // annotations
        if (!db.objectStoreNames.contains('annotations')) {
          var ann = db.createObjectStore('annotations', { keyPath: 'id' });
          ann.createIndex('bookId', 'bookId');
          ann.createIndex('bookId_chapter', ['bookId', 'chapterIndex']);
        }

        // settings
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'bookId' });
        }
      };

      req.onsuccess = function () {
        _db = req.result;
        _db.onversionchange = function () { _db.close(); _db = null; };
        resolve(_db);
      };
      req.onerror = function () { reject(req.error); };
    });
  }

  /** 通用事务包装 */
  function tx(storeName, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(storeName, mode);
        var store = t.objectStore(storeName);
        var out;
        try {
          out = fn(store);
        } catch (err) {
          reject(err);
          return;
        }
        t.oncomplete = function () {
          resolve(out && out.__req ? out.__req.result : out);
        };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('transaction aborted')); };
      });
    });
  }

  /** 包一个 request，便于取出 result */
  function wrap(req) {
    return { __req: req };
  }

  function uid() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  /* ------------------------------------------------------------------ *
   * books
   * ------------------------------------------------------------------ */

  /**
   * 新增书籍
   * @param {Object} book {title, author, format, cover, file, fileSize, chapterCount}
   * @returns {Promise<Object>} 完整的书籍记录（含生成的 id）
   */
  function addBook(book) {
    var now = Date.now();
    var rec = {
      id: book.id || uid(),
      title: book.title || '未命名',
      author: book.author || '',
      format: book.format || 'txt',
      cover: book.cover || null,
      file: book.file || null,
      fileSize: book.fileSize || 0,
      chapterCount: book.chapterCount || 0,
      importedAt: now,
      lastReadAt: now
    };
    return tx('books', 'readwrite', function (s) {
      return wrap(s.put(rec));
    }).then(function () { return rec; });
  }

  /** 全部书籍，按 lastReadAt 倒序 */
  function getBooks() {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction('books', 'readonly');
        var idx = t.objectStore('books').index('lastReadAt');
        var req = idx.openCursor(null, 'prev');
        var list = [];
        req.onsuccess = function () {
          var cur = req.result;
          if (cur) { list.push(cur.value); cur.continue(); }
          else resolve(list);
        };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function getBook(id) {
    return tx('books', 'readonly', function (s) { return wrap(s.get(id)); });
  }

  /**
   * 删除书籍，级联清除 progress / annotations / settings
   */
  function deleteBook(id) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORES, 'readwrite');

        t.objectStore('books').delete(id);
        t.objectStore('progress').delete(id);
        t.objectStore('settings').delete(id);

        // annotations 按 bookId 索引删除
        var idx = t.objectStore('annotations').index('bookId');
        var req = idx.openKeyCursor(IDBKeyRange.only(id));
        req.onsuccess = function () {
          var cur = req.result;
          if (cur) {
            t.objectStore('annotations').delete(cur.primaryKey);
            cur.continue();
          }
        };

        t.oncomplete = function () { resolve(true); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('delete aborted')); };
      });
    });
  }

  /** 更新最近阅读时间 */
  function touchBook(id) {
    return getBook(id).then(function (b) {
      if (!b) return null;
      b.lastReadAt = Date.now();
      return tx('books', 'readwrite', function (s) { return wrap(s.put(b)); }).then(function () { return b; });
    });
  }

  /* ------------------------------------------------------------------ *
   * progress
   * ------------------------------------------------------------------ */

  function getProgress(bookId) {
    return tx('progress', 'readonly', function (s) { return wrap(s.get(bookId)); });
  }

  /**
   * 保存阅读进度
   * @param {string} bookId
   * @param {Object} p {location, percentage, chapterIndex, chapterLabel}
   */
  function saveProgress(bookId, p) {
    var rec = {
      bookId: bookId,
      location: p.location || '',
      percentage: typeof p.percentage === 'number' ? p.percentage : 0,
      chapterIndex: typeof p.chapterIndex === 'number' ? p.chapterIndex : 0,
      chapterLabel: p.chapterLabel || '',
      updatedAt: Date.now()
    };
    return tx('progress', 'readwrite', function (s) { return wrap(s.put(rec)); }).then(function () { return rec; });
  }

  /* ------------------------------------------------------------------ *
   * annotations
   * ------------------------------------------------------------------ */

  function getAnnotations(bookId) {
    return tx('annotations', 'readonly', function (s) {
      var idx = s.index('bookId');
      var req = idx.getAll(IDBKeyRange.only(bookId));
      return wrap(req);
    }).then(function (list) {
      list = list || [];
      list.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
      return list;
    });
  }

  function addAnnotation(a) {
    var rec = {
      id: a.id || uid(),
      bookId: a.bookId,
      type: a.type || 'highlight',         // highlight | note
      color: a.color || 'yellow',
      range: a.range || '',                 // EPUB CFI 或 TXT:chapter:start-end
      text: a.text || '',
      note: a.note || '',
      chapterIndex: typeof a.chapterIndex === 'number' ? a.chapterIndex : 0,
      chapterLabel: a.chapterLabel || '',
      createdAt: Date.now()
    };
    return tx('annotations', 'readwrite', function (s) { return wrap(s.put(rec)); }).then(function () { return rec; });
  }

  function updateAnnotation(id, patch) {
    return tx('annotations', 'readwrite', function (s) {
      var req = s.get(id);
      req.onsuccess = function () {
        var rec = req.result;
        if (!rec) return;
        Object.keys(patch).forEach(function (k) { rec[k] = patch[k]; });
        s.put(rec);
      };
      return wrap(req);
    });
  }

  function deleteAnnotation(id) {
    return tx('annotations', 'readwrite', function (s) { return wrap(s.delete(id)); }).then(function () { return true; });
  }

  /* ------------------------------------------------------------------ *
   * settings
   * ------------------------------------------------------------------ */

  var DEFAULT_SETTINGS = {
    fontSize: 18,
    lineHeight: 1.8,
    theme: 'light',
    fontFamily: 'system',
    flow: 'paginated',
    tapFlip: true
  };

  function getSettings(bookId) {
    return tx('settings', 'readonly', function (s) { return wrap(s.get(bookId)); })
      .then(function (rec) {
        return Object.assign({}, DEFAULT_SETTINGS, rec || {}, { bookId: bookId });
      });
  }

  function saveSettings(bookId, s) {
    var rec = Object.assign({}, s, { bookId: bookId });
    return tx('settings', 'readwrite', function (st) { return wrap(st.put(rec)); }).then(function () { return rec; });
  }

  /* ------------------------------------------------------------------ *
   * 备份 / 恢复
   * ------------------------------------------------------------------ */

  /** 导出全部数据为 JSON 字符串（Blob 转 base64） */
  function exportAll() {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORES, 'readonly');
        var out = { version: DB_VERSION, exportedAt: new Date().toISOString(), books: [], progress: [], annotations: [], settings: [] };
        var pending = STORES.length;
        var failed = false;

        function done() {
          if (failed) return;
          if (--pending === 0) resolve(JSON.stringify(out));
        }

        STORES.forEach(function (name) {
          var req = t.objectStore(name).getAll();
          req.onsuccess = function () {
            out[name] = (req.result || []).map(function (r) {
              var c = Object.assign({}, r);
              if (c.file instanceof Blob) {
                c.__fileB64 = null; // 大文件不内联，见下方说明
                c.file = null;
              }
              if (c.cover instanceof Blob) {
                c.__coverB64 = null;
                c.cover = null;
              }
              return c;
            });
            done();
          };
          req.onerror = function () { failed = true; reject(req.error); };
        });
      });
    }).then(function (json) {
      // Blob 单独异步转 base64（书籍文件可能较大）
      return blobify(json);
    });
  }

  /** 把外置的 Blob 转成 base64 内联进 JSON */
  function blobify(jsonStr) {
    return open().then(function (db) {
      var data = JSON.parse(jsonStr);
      var jobs = [];

      data.books.forEach(function (b) {
        jobs.push(
          readBlobField(db, 'books', b.id, 'file').then(function (b64) { b.fileB64 = b64; }),
          readBlobField(db, 'books', b.id, 'cover').then(function (b64) { b.coverB64 = b64; })
        );
      });

      return Promise.all(jobs).then(function () { return JSON.stringify(data); });
    });
  }

  function readBlobField(db, storeName, key, field) {
    return new Promise(function (resolve) {
      var t = db.transaction(storeName, 'readonly');
      var req = t.objectStore(storeName).get(key);
      req.onsuccess = function () {
        var rec = req.result;
        var blob = rec && rec[field];
        if (!blob) return resolve(null);
        var fr = new FileReader();
        fr.onload = function () { resolve(fr.result); };
        fr.onerror = function () { resolve(null); };
        fr.readAsDataURL(blob);
      };
      req.onerror = function () { resolve(null); };
    });
  }

  function dataURLtoBlob(dataurl) {
    if (!dataurl) return null;
    try {
      var parts = dataurl.split(',');
      var mime = (parts[0].match(/:(.*?);/) || [])[1] || 'application/octet-stream';
      var bin = atob(parts[1]);
      var len = bin.length;
      var u8 = new Uint8Array(len);
      for (var i = 0; i < len; i++) u8[i] = bin.charCodeAt(i);
      return new Blob([u8], { type: mime });
    } catch (e) {
      return null;
    }
  }

  /**
   * 从备份 JSON 恢复（合并模式：已存在的 id 覆盖）
   * @param {string} jsonStr
   * @param {Object} opts {merge:boolean}
   */
  function importAll(jsonStr, opts) {
    opts = opts || {};
    var data;
    try { data = JSON.parse(jsonStr); } catch (e) { return Promise.reject(new Error('备份文件格式不正确')); }
    if (!data || !Array.isArray(data.books)) return Promise.reject(new Error('备份文件缺少 books 数据'));

    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORES, 'readwrite');

        // books：还原 Blob
        data.books.forEach(function (b) {
          var rec = Object.assign({}, b);
          rec.file = dataURLtoBlob(b.fileB64);
          rec.cover = dataURLtoBlob(b.coverB64);
          delete rec.fileB64;
          delete rec.coverB64;
          delete rec.__fileB64;
          delete rec.__coverB64;
          if (!rec.id) rec.id = uid();
          t.objectStore('books').put(rec);
        });

        ['progress', 'settings', 'annotations'].forEach(function (name) {
          (data[name] || []).forEach(function (r) {
            t.objectStore(name).put(r);
          });
        });

        t.oncomplete = function () {
          resolve({
            books: data.books.length,
            annotations: (data.annotations || []).length
          });
        };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('恢复失败')); };
      });
    });
  }

  /** 清空所有数据（危险操作，供调试用） */
  function clearAll() {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORES, 'readwrite');
        STORES.forEach(function (n) { t.objectStore(n).clear(); });
        t.oncomplete = function () { resolve(true); };
        t.onerror = function () { reject(t.error); };
      });
    });
  }

  /** 估算存储占用 */
  function estimate() {
    if (!navigator.storage || !navigator.storage.estimate) {
      return Promise.resolve(null);
    }
    return navigator.storage.estimate().then(function (e) {
      return { usage: e.usage || 0, quota: e.quota || 0 };
    });
  }

  global.DB = {
    open: open,
    uid: uid,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,

    addBook: addBook,
    getBooks: getBooks,
    getBook: getBook,
    deleteBook: deleteBook,
    touchBook: touchBook,

    getProgress: getProgress,
    saveProgress: saveProgress,

    getAnnotations: getAnnotations,
    addAnnotation: addAnnotation,
    updateAnnotation: updateAnnotation,
    deleteAnnotation: deleteAnnotation,

    getSettings: getSettings,
    saveSettings: saveSettings,

    exportAll: exportAll,
    importAll: importAll,
    clearAll: clearAll,
    estimate: estimate
  };
})(window);

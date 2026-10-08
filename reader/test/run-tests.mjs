/**
 * run-tests.mjs —— fkks-reader 自动化测试
 *
 * 运行：node test/run-tests.mjs
 *
 * 覆盖：
 *   A. 解析层（parsers.js）—— 纯函数，直接测
 *   B. 存储层（db.js）—— 用内存 IndexedDB 替身，验证逻辑契约
 *
 * 说明：真正的浏览器端到端测试需在真实浏览器里打开 test/test.html。
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/* ============================================================
 * 测试框架（极简）
 * ============================================================ */

const results = [];
let currentSuite = '';

function suite(name) {
  currentSuite = name;
  results.push({ type: 'suite', name });
}

function test(name, fn) {
  try {
    fn();
    results.push({ type: 'pass', suite: currentSuite, name });
  } catch (err) {
    results.push({ type: 'fail', suite: currentSuite, name, detail: err.message });
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    results.push({ type: 'pass', suite: currentSuite, name });
  } catch (err) {
    results.push({ type: 'fail', suite: currentSuite, name, detail: err.message });
  }
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label || '断言失败'}：期望 ${b}，实际 ${a}`);
}

function ok(cond, label) {
  if (!cond) throw new Error(label || '断言失败');
}

/* ============================================================
 * A. 加载 parsers.js（纯函数，无需 DOM）
 * ============================================================ */

const parsersSrc = fs.readFileSync(path.join(ROOT, 'lib', 'parsers.js'), 'utf8');

// parsers.js 里用了 TextDecoder / TextEncoder，Node 22 原生支持
const parsersCtx = {
  console,
  TextDecoder,
  TextEncoder,
  Blob,
  window: {},
};

parsersCtx.window = parsersCtx;
vm.createContext(parsersCtx);
vm.runInContext(parsersSrc, parsersCtx);
const Parsers = parsersCtx.Parsers;

/* ============================================================
 * B. 加载 db.js —— 需要 IndexedDB 替身
 * ============================================================ */

/**
 * 内存版 IndexedDB 替身，只实现 db.js 用到的接口：
 *   indexedDB.open / createObjectStore / createIndex
 *   transaction / objectStore / put / get / delete / getAll / clear
 *   index / openCursor / openKeyCursor / getAll
 *   IDBKeyRange.only
 *
 * 目标不是完整实现规范，而是验证 db.js 的业务逻辑契约。
 */

function makeMemoryIDB() {
  /** storeName -> Map(key -> record) */
  const data = {};
  /** storeName -> { indexes: { name -> keyPath } } */
  const schema = {};

  function keyToStr(k) { return typeof k === 'object' && k !== null ? JSON.stringify(k) : String(k); }

  /** 从记录中取出索引键 */
  function indexKey(record, keyPath) {
    if (Array.isArray(keyPath)) return keyPath.map((p) => record[p]);
    return record[keyPath];
  }

  class FakeRequest {
    constructor() { this.readyState = 'pending'; this.result = undefined; this.error = null; }
    _resolve(value) {
      this.readyState = 'done';
      this.result = value;
      queueMicrotask(() => { if (this.onsuccess) this.onsuccess({ target: this }); });
    }
  }

  class FakeIndex {
    constructor(storeName, name, keyPath) {
      this.storeName = storeName; this.name = name; this.keyPath = keyPath;
    }
    getAll(range) {
      const req = new FakeRequest();
      queueMicrotask(() => {
        const map = data[this.storeName] || new Map();
        let out = [];
        for (const rec of map.values()) {
          const k = indexKey(rec, this.keyPath);
          if (range && range.__only !== undefined) {
            if (keyToStr(k) !== keyToStr(range.__only)) continue;
          }
          out.push(rec);
        }
        req._resolve(out);
      });
      return req;
    }
    openCursor(range) {
      const req = new FakeRequest();
      queueMicrotask(() => {
        const map = data[this.storeName] || new Map();
        const list = [];
        for (const [pk, rec] of map.entries()) {
          const k = indexKey(rec, this.keyPath);
          if (range && range.__only !== undefined && keyToStr(k) !== keyToStr(range.__only)) continue;
          list.push({ primaryKey: pk, value: rec });
        }
        let i = 0;
        const step = () => {
          if (i >= list.length) { req._resolve(undefined); return; }
          const cur = list[i++];
          req.result = {
            primaryKey: cur.primaryKey, value: cur.value,
            continue: () => queueMicrotask(step),
          };
          if (req.onsuccess) req.onsuccess({ target: req });
        };
        step();
      });
      return req;
    }
    openKeyCursor(range) {
      const req = new FakeRequest();
      queueMicrotask(() => {
        const map = data[this.storeName] || new Map();
        const list = [];
        for (const [pk, rec] of map.entries()) {
          const k = indexKey(rec, this.keyPath);
          if (range && range.__only !== undefined && keyToStr(k) !== keyToStr(range.__only)) continue;
          list.push(pk);
        }
        let i = 0;
        const step = () => {
          if (i >= list.length) { req._resolve(undefined); return; }
          const pk = list[i++];
          req.result = { primaryKey: pk, key: pk, continue: () => queueMicrotask(step) };
          if (req.onsuccess) req.onsuccess({ target: req });
        };
        step();
      });
      return req;
    }
  }

  class FakeStore {
    constructor(name) { this.name = name; this.keyPath = schema[name].keyPath; }
    _map() { if (!data[this.name]) data[this.name] = new Map(); return data[this.name]; }
    put(rec) {
      const req = new FakeRequest();
      queueMicrotask(() => {
        const k = rec[this.keyPath];
        this._map().set(k, structuredClone(rec));
        req._resolve(k);
      });
      return req;
    }
    get(key) {
      const req = new FakeRequest();
      queueMicrotask(() => { req._resolve(this._map().get(key)); });
      return req;
    }
    getAll() {
      const req = new FakeRequest();
      queueMicrotask(() => { req._resolve([...this._map().values()]); });
      return req;
    }
    delete(key) {
      const req = new FakeRequest();
      queueMicrotask(() => { this._map().delete(key); req._resolve(undefined); });
      return req;
    }
    clear() {
      const req = new FakeRequest();
      queueMicrotask(() => { this._map().clear(); req._resolve(undefined); });
      return req;
    }
    index(name) {
      const s = schema[this.name].indexes[name];
      if (!s) throw new Error('没有索引 ' + name);
      return new FakeIndex(this.name, name, s);
    }
    createIndex(name, keyPath) {
      schema[this.name].indexes[name] = keyPath;
      return new FakeIndex(this.name, name, keyPath);
    }
  }

  class FakeTransaction {
    constructor(stores, mode) {
      this.stores = new Set([].concat(stores));
      this.mode = mode;
      this.error = null;
      this.oncomplete = null;
      this.onerror = null;
      this.onabort = null;
      // 所有微任务完成后触发 oncomplete
      queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => {
        if (this.oncomplete) this.oncomplete();
      })));
    }
    objectStore(name) {
      if (!this.stores.has(name)) throw new Error('事务未包含 store: ' + name);
      return new FakeStore(name);
    }
  }

  const db = {
    version: 1,
    objectStoreNames: {
      _names: [],
      contains(n) { return this._names.includes(n); },
      [Symbol.iterator]() { return this._names[Symbol.iterator](); },
    },
    createObjectStore(name, opts) {
      this.objectStoreNames._names.push(name);
      schema[name] = { keyPath: opts.keyPath, indexes: {} };
      data[name] = new Map();
      const store = new FakeStore(name);
      return {
        createIndex: (n, kp) => { schema[name].indexes[n] = kp; },
      };
    },
    transaction(stores, mode) { return new FakeTransaction(stores, mode); },
    close() {},
  };

  const indexedDB = {
    open(name, version) {
      const req = new FakeRequest();
      queueMicrotask(() => {
        // 模拟首次升级
        if (db.objectStoreNames._names.length === 0) {
          if (req.onupgradeneeded) req.onupgradeneeded({ target: { result: db } });
        }
        req.result = db;
        if (req.onsuccess) req.onsuccess({ target: req });
      });
      return req;
    },
  };

  return { indexedDB, db };
}

/* structuredClone 在 Node 17+ 原生可用 */
const dbSrc = fs.readFileSync(path.join(ROOT, 'lib', 'db.js'), 'utf8');
const { indexedDB: fakeIDB } = makeMemoryIDB();

const dbCtx = {
  console,
  Blob,
  FileReader: class {
    readAsDataURL() { /* 内存替身：不实际转换 */ }
  },
  IDBKeyRange: { only: (v) => ({ __only: v }) },
  indexedDB: fakeIDB,
  navigator: { storage: undefined },
  crypto: globalThis.crypto,
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  structuredClone,
  Promise,
  Object,
  Array,
  Date,
  Math,
  JSON,
  String,
  Number,
  Error,
  setTimeout,
  clearTimeout,
};
dbCtx.window = dbCtx;
vm.createContext(dbCtx);
vm.runInContext(dbSrc, dbCtx);
const DB = dbCtx.DB;

/* ============================================================
 * 开始测试
 * ============================================================ */

async function main() {

  /* ---------------- A. 解析层 ---------------- */

  suite('Parsers · 文件类型识别');

  test('extOf 识别 epub', () => eq(Parsers.extOf('book.epub'), 'epub'));
  test('extOf 识别大写 EPUB', () => eq(Parsers.extOf('BOOK.EPUB'), 'epub'));
  test('extOf 识别 txt', () => eq(Parsers.extOf('a.txt'), 'txt'));
  test('extOf 无扩展名返回空', () => eq(Parsers.extOf('noext'), ''));
  test('extOf 多点文件名取最后一段', () => eq(Parsers.extOf('v1.2.final.epub'), 'epub'));

  suite('Parsers · 编码识别');

  test('识别 UTF-8 中文', () => {
    const buf = new TextEncoder().encode('第一章 开始').buffer;
    const r = Parsers.decodeBuffer(buf);
    eq(r.encoding, 'utf-8', '编码');
    eq(r.text, '第一章 开始', '内容');
  });

  test('识别并剥离 UTF-8 BOM', () => {
    const body = new TextEncoder().encode('你好世界');
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...body]);
    const r = Parsers.decodeBuffer(withBom.buffer);
    ok(r.encoding.includes('BOM'), '应识别为 BOM');
    eq(r.text, '你好世界', 'BOM 应被剥离');
  });

  test('回退识别 GBK（「你好」= C4E3 BAC3）', () => {
    const buf = new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]).buffer;
    const r = Parsers.decodeBuffer(buf);
    ok(!r.encoding.startsWith('utf-8'), '不应识别为 utf-8，实际 ' + r.encoding);
    eq(r.text, '你好', 'GBK 解码结果');
  });

  test('识别 UTF-16LE BOM', () => {
    const body = new Uint8Array([0x6c, 0x00, 0x69, 0x00]); // "li" LE
    const buf = new Uint8Array([0xff, 0xfe, ...body]).buffer;
    const r = Parsers.decodeBuffer(buf);
    eq(r.encoding, 'utf-16le', '编码');
    eq(r.text, 'li', '内容');
  });

  suite('Parsers · 章节标题识别');

  test('识别「第一章 风起」', () => ok(Parsers.isChapterTitle('第一章 风起')));
  test('识别「第1章 启程」', () => ok(Parsers.isChapterTitle('第1章 启程')));
  test('识别「第十二回」', () => ok(Parsers.isChapterTitle('第十二回')));
  test('识别「Chapter 3 The Road」', () => ok(Parsers.isChapterTitle('Chapter 3 The Road')));
  test('识别「CHAPTER IV」', () => ok(Parsers.isChapterTitle('CHAPTER IV')));
  test('识别「序章」', () => ok(Parsers.isChapterTitle('序章')));
  test('识别「前言」', () => ok(Parsers.isChapterTitle('前言')));
  test('识别「1. 开篇」', () => ok(Parsers.isChapterTitle('1. 开篇')));
  test('识别「【楔子】」', () => ok(Parsers.isChapterTitle('【楔子】')));
  test('普通句子不误判', () => ok(!Parsers.isChapterTitle('他走进了那间屋子。')));
  test('超长行不误判', () => ok(!Parsers.isChapterTitle('第一章 ' + '很长'.repeat(40))));
  test('空行不误判', () => ok(!Parsers.isChapterTitle('')));
  test('空格行不误判', () => ok(!Parsers.isChapterTitle('   ')));

  suite('Parsers · 文本分章');

  test('标准三章切分', () => {
    const text = '第一章 开端\n\n内容一\n\n第二章 发展\n\n内容二\n\n第三章 结尾\n\n内容三';
    const ch = Parsers.splitChapters(text);
    eq(ch.length, 3, '章节数');
    eq(ch[0].title, '第一章 开端', '首章标题');
    eq(ch[2].title, '第三章 结尾', '末章标题');
    ok(ch[1].content.includes('内容二'), '第二章内容');
  });

  test('章节内容正确归属', () => {
    const text = '第一章 A\n正文A\n第二章 B\n正文B';
    const ch = Parsers.splitChapters(text);
    eq(ch[0].content, '正文A', '第一章内容');
    eq(ch[1].content, '正文B', '第二章内容');
  });

  test('CRLF 换行正常处理', () => {
    const text = '第一章 A\r\n内容A\r\n第二章 B\r\n内容B';
    const ch = Parsers.splitChapters(text);
    eq(ch.length, 2, '章节数');
    ok(!ch[0].content.includes('\r'), '不应残留 \\r');
  });

  test('无章节标记时兜底分块', () => {
    const text = '啊'.repeat(7000);
    const ch = Parsers.splitChapters(text);
    ok(ch.length >= 2, '应至少切成 2 块，实际 ' + ch.length);
  });

  test('短文本兜底为 1 节', () => {
    const ch = Parsers.splitChapters('只有一段文字，没有任何章节标记。');
    eq(ch.length, 1, '节数');
  });

  test('空文本不崩溃', () => {
    const ch = Parsers.splitChapters('');
    ok(Array.isArray(ch) && ch.length >= 1, '应返回至少 1 节');
  });

  test('首章无标题时补「开始」', () => {
    const text = '前言内容\n第一章 A\n正文A';
    const ch = Parsers.splitChapters(text);
    eq(ch[0].title, '开始', '首章标题');
  });

  test('兜底分块标题格式正确', () => {
    const ch = Parsers.splitChapters('啊'.repeat(7000));
    ok(/^第 \d+ 节$/.test(ch[0].title), '标题应为「第 N 节」，实际 ' + ch[0].title);
  });

  /* ---------------- B. 存储层 ---------------- */

  suite('DB · 初始化');

  await testAsync('open 成功返回 db 实例', async () => {
    const db = await DB.open();
    ok(db && typeof db.version === 'number', '应返回 db 实例');
  });

  await testAsync('四张表均已创建', async () => {
    const db = await DB.open();
    const names = [...db.objectStoreNames];
    for (const n of ['books', 'progress', 'annotations', 'settings']) {
      ok(names.includes(n), `缺少表 ${n}，实际 ${names.join(', ')}`);
    }
  });

  suite('DB · books');

  let bookId = null;

  await testAsync('addBook 写入并返回完整记录', async () => {
    const rec = await DB.addBook({
      title: '测试书', author: '张三', format: 'txt',
      file: new Blob(['测试内容']), fileSize: 12, chapterCount: 3,
    });
    bookId = rec.id;
    ok(rec.id, '应生成 id');
    eq(rec.title, '测试书', '标题');
    eq(rec.author, '张三', '作者');
    ok(typeof rec.importedAt === 'number', '应有 importedAt');
    ok(typeof rec.lastReadAt === 'number', '应有 lastReadAt');
  });

  await testAsync('addBook 缺省值兜底', async () => {
    const rec = await DB.addBook({ format: 'txt' });
    eq(rec.title, '未命名', '默认标题');
    eq(rec.author, '', '默认作者');
    eq(rec.chapterCount, 0, '默认章节数');
    await DB.deleteBook(rec.id);
  });

  await testAsync('getBook 能取回', async () => {
    const b = await DB.getBook(bookId);
    eq(b.title, '测试书', '标题');
    ok(b.file instanceof Blob, 'file 应为 Blob');
  });

  await testAsync('getBook 不存在的 id 返回 undefined', async () => {
    const b = await DB.getBook('not-exist-id');
    eq(b, undefined, '应返回 undefined');
  });

  await testAsync('getBooks 返回全部', async () => {
    const list = await DB.getBooks();
    ok(list.length >= 1, '应至少 1 本');
    ok(list.some((b) => b.id === bookId), '应包含刚添加的书');
  });

  await testAsync('touchBook 更新 lastReadAt', async () => {
    const before = (await DB.getBook(bookId)).lastReadAt;
    await new Promise((r) => setTimeout(r, 5));
    await DB.touchBook(bookId);
    const after = (await DB.getBook(bookId)).lastReadAt;
    ok(after >= before, 'lastReadAt 应不早于原先');
  });

  suite('DB · progress');

  await testAsync('saveProgress / getProgress 往返', async () => {
    await DB.saveProgress(bookId, {
      location: 'chapter:2', percentage: 33.3, chapterIndex: 2, chapterLabel: '第三章',
    });
    const p = await DB.getProgress(bookId);
    eq(p.percentage, 33.3, '百分比');
    eq(p.chapterIndex, 2, '章节索引');
    eq(p.chapterLabel, '第三章', '章节标签');
    ok(typeof p.updatedAt === 'number', '应有 updatedAt');
  });

  await testAsync('saveProgress 缺省值兜底', async () => {
    const tmp = await DB.addBook({ title: '进度测试', format: 'txt' });
    await DB.saveProgress(tmp.id, {});
    const p = await DB.getProgress(tmp.id);
    eq(p.percentage, 0, '默认百分比');
    eq(p.location, '', '默认位置');
    await DB.deleteBook(tmp.id);
  });

  suite('DB · annotations');

  let annId = null;

  await testAsync('addAnnotation 写入', async () => {
    const a = await DB.addAnnotation({
      bookId, color: 'green', range: 'txt:2:5:测试文本',
      text: '测试文本', chapterIndex: 2, chapterLabel: '第三章',
    });
    annId = a.id;
    ok(a.id, '应生成 id');
    eq(a.type, 'highlight', '默认类型');
    eq(a.color, 'green', '颜色');
    eq(a.note, '', '默认笔记为空');
    ok(typeof a.createdAt === 'number', '应有 createdAt');
  });

  await testAsync('getAnnotations 只返回本书的', async () => {
    const other = await DB.addBook({ title: '别的书', format: 'txt' });
    await DB.addAnnotation({ bookId: other.id, text: '别的标注' });

    const list = await DB.getAnnotations(bookId);
    eq(list.length, 1, '本书标注数');
    ok(list.every((a) => a.bookId === bookId), '不应混入其他书的标注');

    await DB.deleteBook(other.id);
  });

  await testAsync('getAnnotations 按 createdAt 升序', async () => {
    await new Promise((r) => setTimeout(r, 5));
    await DB.addAnnotation({ bookId, text: '第二条', color: 'blue' });
    const list = await DB.getAnnotations(bookId);
    eq(list.length, 2, '标注数');
    ok(list[0].createdAt <= list[1].createdAt, '应按时间升序');
  });

  await testAsync('updateAnnotation 更新笔记与类型', async () => {
    await DB.updateAnnotation(annId, { note: '我的批注', type: 'note' });
    const list = await DB.getAnnotations(bookId);
    const target = list.find((a) => a.id === annId);
    eq(target.note, '我的批注', '笔记内容');
    eq(target.type, 'note', '类型');
  });

  await testAsync('deleteAnnotation 删除', async () => {
    await DB.deleteAnnotation(annId);
    const list = await DB.getAnnotations(bookId);
    ok(!list.some((a) => a.id === annId), '应已删除');
  });

  suite('DB · settings');

  await testAsync('无记录时返回默认设置', async () => {
    const tmp = await DB.addBook({ title: '设置测试', format: 'txt' });
    const s = await DB.getSettings(tmp.id);
    eq(s.fontSize, 18, '默认字号');
    eq(s.lineHeight, 1.8, '默认行距');
    eq(s.theme, 'light', '默认主题');
    eq(s.fontFamily, 'system', '默认字体');
    eq(s.flow, 'paginated', '默认翻页方式');
    eq(s.tapFlip, true, '默认点击翻页');
    eq(s.bookId, tmp.id, '应带 bookId');
    await DB.deleteBook(tmp.id);
  });

  await testAsync('saveSettings / getSettings 往返', async () => {
    await DB.saveSettings(bookId, {
      fontSize: 24, lineHeight: 2.0, theme: 'dark',
      fontFamily: 'serif', flow: 'scrolled', tapFlip: false,
    });
    const s = await DB.getSettings(bookId);
    eq(s.fontSize, 24, '字号');
    eq(s.theme, 'dark', '主题');
    eq(s.flow, 'scrolled', '翻页方式');
    eq(s.tapFlip, false, '点击翻页');
  });

  await testAsync('部分字段保存后仍有完整默认值', async () => {
    const tmp = await DB.addBook({ title: '部分设置', format: 'txt' });
    await DB.saveSettings(tmp.id, { fontSize: 30 });
    const s = await DB.getSettings(tmp.id);
    eq(s.fontSize, 30, '自定义字号');
    eq(s.theme, 'light', '未指定的主题应回落默认');
    eq(s.lineHeight, 1.8, '未指定的行距应回落默认');
    await DB.deleteBook(tmp.id);
  });

  suite('DB · 级联删除');

  await testAsync('deleteBook 清除书籍本身', async () => {
    const tmp = await DB.addBook({ title: '待删除', format: 'txt' });
    await DB.deleteBook(tmp.id);
    eq(await DB.getBook(tmp.id), undefined, '书籍应已删除');
  });

  await testAsync('deleteBook 级联清除 progress', async () => {
    const tmp = await DB.addBook({ title: '待删除2', format: 'txt' });
    await DB.saveProgress(tmp.id, { percentage: 50, chapterIndex: 1 });
    await DB.deleteBook(tmp.id);
    eq(await DB.getProgress(tmp.id), undefined, '进度应已删除');
  });

  await testAsync('deleteBook 级联清除 annotations', async () => {
    const tmp = await DB.addBook({ title: '待删除3', format: 'txt' });
    await DB.addAnnotation({ bookId: tmp.id, text: '标注A' });
    await DB.addAnnotation({ bookId: tmp.id, text: '标注B' });
    await DB.deleteBook(tmp.id);
    const list = await DB.getAnnotations(tmp.id);
    eq(list.length, 0, '标注应全部清除');
  });

  await testAsync('deleteBook 级联清除 settings', async () => {
    const tmp = await DB.addBook({ title: '待删除4', format: 'txt' });
    await DB.saveSettings(tmp.id, { fontSize: 26 });
    await DB.deleteBook(tmp.id);
    const s = await DB.getSettings(tmp.id);
    eq(s.fontSize, 18, '设置应回到默认值（说明记录已删）');
  });

  await testAsync('删除不存在的书不报错', async () => {
    await DB.deleteBook('ghost-id');
  });

  suite('DB · uid');

  test('uid 生成唯一值', () => {
    const set = new Set();
    for (let i = 0; i < 200; i++) set.add(DB.uid());
    eq(set.size, 200, '200 次生成应互不相同');
  });

  test('uid 为非空字符串', () => {
    const u = DB.uid();
    ok(typeof u === 'string' && u.length > 0, '应为非空字符串');
  });

  suite('DB · 常量');

  test('DEFAULT_SETTINGS 字段完整', () => {
    const d = DB.DEFAULT_SETTINGS;
    for (const k of ['fontSize', 'lineHeight', 'theme', 'fontFamily', 'flow', 'tapFlip']) {
      ok(k in d, `缺少字段 ${k}`);
    }
  });

  suite('UI · CSS 回归守卫');

  test('styles.css 必须包含 [hidden] 兜底规则', () => {
    const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
    const re = /\[hidden\]\s*\{[^}]*display:\s*none\s*!important[^}]*\}/;
    ok(re.test(css), '缺少 [hidden] { display:none !important } —— 没有它，'
      + 'display:flex/grid 的浮层类会压过 hidden 属性，导致目录/设置/笔记等浮层全部常驻显示');
  });

  test('index.html 引用的本地脚本全部存在', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const srcs = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
    ok(srcs.length >= 5, '应有至少 5 个本地脚本，实际 ' + srcs.length);
    for (const src of srcs) {
      const p = path.join(ROOT, src);
      ok(fs.existsSync(p), '脚本不存在: ' + src);
    }
  });

  test('index.html 引用的样式表存在', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const hrefs = [...html.matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)"/g)].map((m) => m[1]);
    for (const href of hrefs) {
      ok(fs.existsSync(path.join(ROOT, href)), '样式不存在: ' + href);
    }
  });

  /* ---------------- 输出 ---------------- */

  printResults();
}

function printResults() {
  let passed = 0, failed = 0;
  const lines = [];

  for (const r of results) {
    if (r.type === 'suite') {
      lines.push('');
      lines.push('▌ ' + r.name);
    } else if (r.type === 'pass') {
      passed++;
      lines.push('  ✓ ' + r.name);
    } else {
      failed++;
      lines.push('  ✗ ' + r.name);
      lines.push('      → ' + r.detail);
    }
  }

  console.log(lines.join('\n'));
  console.log('');
  console.log('═'.repeat(64));
  const summary = `通过 ${passed} / ${passed + failed}` + (failed ? `，失败 ${failed}` : '　✅ 全部通过');
  console.log(summary);
  console.log('═'.repeat(64));

  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('测试运行器异常：', err);
  process.exit(2);
});

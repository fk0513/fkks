# fkks-reader

一个**零构建、纯静态**的网页版电子书阅读器。把 EPUB 或 TXT 拖进浏览器就能读，支持进度记忆和标注。

## 怎么跑

### 方式一：本地起个静态服务（**推荐**）

```bash
cd reader
python -m http.server 8777
```

然后浏览器打开 <http://127.0.0.1:8777>

### 方式二：直接双击 index.html

⚠️ **不推荐**。Chrome / Edge 在 `file://` 协议下会**禁用 IndexedDB**，导致导入和进度保存全部失效。Firefox 可以，但不通用。

**结论：一定要用 HTTP 服务跑。**

### 方式三：丢到 GitHub Pages

把 `reader/` 目录设为 Pages 根目录即可，纯静态零配置。

## 功能

| 模块 | 已实现 |
|---|---|
| 导入 | EPUB、TXT；拖拽或文件选择；多选批量导入 |
| TXT | 自动识别 UTF-8 / GBK / UTF-16 编码；自动分章（识别「第X章」「Chapter N」等） |
| 书架 | 封面（EPUB 自动提取，缺失时生成占位）、书名作者、阅读进度条、按最近阅读排序 |
| 阅读 | 分页 / 滚动两种模式；点击左右区域、键盘方向键、移动端左右滑动翻页 |
| 目录 | 解析 EPUB nav/NCX，TXT 按章节生成；点击跳转 |
| 进度 | 自动记录，下次打开自动续读；进度条可拖动跳转 |
| 标注 | 选中文本 → 三色高亮；可加笔记；侧栏查看/跳转/删除 |
| 设置 | 字号、行距、主题（浅色/护眼/深色）、字体、翻页方式、点击翻页开关 |
| 备份 | 导出全部数据为 JSON；从 JSON 恢复（含书籍文件与封面） |

## 技术栈

**零依赖构建**，只有两个运行时库，都在 `lib/` 本地放着，不走 CDN：

- `epub.js` 0.3.93 —— EPUB 解析与渲染
- `jszip` 3.10.1 —— epub.js 的 zip 依赖

其余全部原生：

- **存储**：IndexedDB（`lib/db.js`，手写封装，无第三方库）
- **路由**：hash 路由（`#/` 书架、`#/read/:bookId` 阅读器）
- **样式**：原生 CSS + CSS 变量（主题切换）
- **框架**：无

## 目录结构

```
reader/
├── index.html          唯一页面，含全部视图
├── app.js              主逻辑（路由、书架、阅读器、标注、设置）
├── styles.css          样式 + 主题变量
├── lib/
│   ├── db.js           IndexedDB 封装（books/progress/annotations/settings）
│   ├── parsers.js      EPUB/TXT 解析、编码识别、自动分章
│   ├── txt-reader.js   TXT 渲染器
│   ├── epub.min.js     epub.js
│   └── jszip.min.js    jszip
└── test/
    ├── run-tests.mjs   自动化测试（Node 运行）
    └── test.html       浏览器端测试页（可视化）
```

## 测试

### 自动化测试（Node，56 个用例）

```bash
node test/run-tests.mjs
```

覆盖解析层（编码识别、章节识别、分章逻辑）与存储层（四张表 CRUD、级联删除、默认值兜底）。

存储层测试使用内存版 IndexedDB 替身，验证的是**业务逻辑契约**。

### 浏览器端测试

起服务后打开 <http://127.0.0.1:8777/test/test.html>，页面会显示通过/失败明细。

## 数据存储说明

- 所有数据存在浏览器本地（IndexedDB），**没有服务端、没有账号**
- **换浏览器或清缓存会导致数据丢失** —— 请定期用顶栏「备份」按钮导出 JSON
- 存储配额受浏览器限制；导入时若剩余空间不足会给出提示

## 已知限制

- 不支持 PDF / MOBI / AZW3
- 不支持跨设备同步
- 标注定位依赖 EPUB 的 CFI，极少数排版异常的 EPUB 可能定位不准
- 单机使用设计，无多人协作

## 开发约定

见项目根目录 `AGENTS.md`：每次改动必须提交 commit，且交付前测试必须全部通过。

# 贝壳音乐 · 曲谱库

一个纯静态的曲谱检索站：输入歌名、歌手、拼音或首字母片段就能搜，点开直接看谱。部署在 GitHub Pages。

## 特性

- 模糊搜索：歌名、作者、拼音全拼、拼音首字母、目录名
- PDF 与图片谱在线预览，支持翻页、缩放、下载
- 没有分类和筛选，只有搜索框
- 图片入库时自动转 WebP（最长边 1800px），源目录不改
- 内容完全相同的副本自动去重，并在报告里列出
- ZIP 自动解压，修复 Windows 压缩包中文文件名乱码，防路径穿越；`xx1.jpg / xx2.jpg` 会按页码合并

## 本地预览

```bash
python -m http.server 8000
# 打开 http://localhost:8000
```

不要直接双击 `index.html`，浏览器会拦截模块和 fetch。

## 入库

```bash
python scripts/ingest.py --src "D:\BaiduNetdiskDownload" --prune
```

- `--src`：下载目录，只读；脚本不会改源文件
- `--prune`：显式清理 `scores/`、`thumbs/` 里这次没有生成的旧文件
- `--no-extract`：不解压 ZIP
- `--dry-run`：只统计不写文件

输出：

- `scores/`：站点用的曲谱副本（图片已转 WebP）
- `thumbs/`：首图缩略图
- `data/scores.json`：搜索索引
- `reports/ingest-report.json`：跳过项、重复项、压缩包、警告、超大文件
- `source-extracted/`：ZIP 解压缓存（已被 git 忽略）
- 旧索引备份在 `data/.backup/`

### 文件命名

- `歌名.jpg`、`歌名1.jpg`、`歌名2.jpg` → 同一份谱的第 1、2 页
- `歌名_01.jpg`、`歌名-2.jpg`、`歌名 第2页.jpg` 同样识别
- `歌名/1.jpg`、`歌名/2.jpg` → 整个文件夹是一份多页谱
- `歌名 - 作者.pdf` → 拆成标题和作者
- `歌名1.pdf`、`歌名2.pdf` 会合并成一份 PDF

### 手工修正

编辑 `meta/overrides.json`：

```json
{
  "手写乐队总谱+键盘谱+英文/乐队全部谱子/晴天.jpg": {
    "title": "晴天",
    "composer": "周杰伦",
    "tags": ["流行"],
    "aliases": ["晴天 乐队版"]
  }
}
```

键可以是源路径、文件名或条目 id。`"hide": true` 可以隐藏某条。

## 部署到 GitHub Pages

仓库按 `beike-music` 命名：

```bash
git init -b main
git add .
git commit -m "贝壳音乐曲谱库"
gh repo create zisonzishen0415-stack/beike-music --public --source=. --remote=origin --push
gh api --method POST repos/zisonzishen0415-stack/beike-music/pages \
  -f "source[branch]=main" -f "source[path]=/"
```

站点地址：`https://zisonzishen0415-stack.github.io/beike-music/`

## 体积

GitHub 仓库建议 <1GB，单文件 <100MB，Pages 站点上限也是 1GB。图片转 WebP 后能压掉大部分体积；如果全部曲谱超过上限，需要缩减上传范围，或只把预览图放 GitHub、原图留在网盘。

## 目录

```
index.html              页面
assets/style.css        样式
assets/app.js           搜索、筛选、预览
assets/brand-logo.png   logo（透明背景）
assets/brand-mark.png   favicon
assets/vendor/          pdf.js 运行时（npm run vendor 生成）
assets/fonts/           JetBrains Mono
data/scores.json        搜索索引（入库生成）
scores/                 曲谱副本（入库生成）
thumbs/                 缩略图（入库生成）
scripts/ingest.py       扫描、解压、去重、转码、入库
scripts/prepare-logo.py 处理 logo 白边和透明背景
meta/overrides.json     元数据修正
```

## 许可

代码可自由使用。曲谱仅用于学习与交流，版权归原作者及出版方所有；公开部署前请确认你拥有分享权利。

字体 JetBrains Mono 使用 SIL Open Font License 1.1，见 `assets/fonts/OFL.txt`。

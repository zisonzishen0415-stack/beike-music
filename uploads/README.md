# 上传曲谱

把 PDF / JPG / JPEG / PNG / WebP / ZIP 拖到这个文件夹（可以新建子文件夹），提交后 GitHub Actions 会自动：

- 解压 ZIP
- 把 `歌名1.jpg`、`歌名2.jpg` 按页码合并
- 图片转 WebP、去重、生成缩略图和搜索索引
- 提交 `scores/`、`thumbs/`、`data/scores.json`，并更新 GitHub Pages

大约 1–2 分钟后刷新站点即可看到。歌单里的「待补谱」可以用「挂谱」接到新上传的曲谱上。

不支持的文件会被跳过并记录在 Actions 日志 / `reports/` 里。

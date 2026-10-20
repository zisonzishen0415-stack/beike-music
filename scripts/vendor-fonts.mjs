// 把 JetBrains Mono 的拉丁字形复制进 assets/fonts。中文由系统字体回退。
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "node_modules/@fontsource/jetbrains-mono/files");
const target = resolve(root, "assets/fonts");

await mkdir(target, { recursive: true });
for (const weight of [200, 400, 600, 700]) {
  await copyFile(
    resolve(source, `jetbrains-mono-latin-${weight}-normal.woff2`),
    resolve(target, `jetbrains-mono-${weight}.woff2`)
  );
  console.log(`copied jetbrains-mono-${weight}.woff2`);
}

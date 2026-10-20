// 把 pdf.js 的运行时文件复制进 assets/vendor，站点不依赖 CDN。
import { copyFile, cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "node_modules/pdfjs-dist");
const target = resolve(root, "assets/vendor");

await mkdir(target, { recursive: true });
for (const file of ["build/pdf.min.mjs", "build/pdf.worker.min.mjs"]) {
  await copyFile(resolve(source, file), resolve(target, file.split("/").pop()));
}
for (const folder of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  await cp(resolve(source, folder), resolve(target, folder), { recursive: true });
  console.log(`copied ${folder}/`);
}
console.log("pdf.js runtime ready");

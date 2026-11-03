import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await cp("extension", "dist", { recursive: true });
for (const entry of ["background", "main", "content", "ui"]) {
  await build({ entryPoints: [`src/${entry}.js`], bundle: true, outfile: `dist/${entry}.js`,
    format: entry === "background" ? "esm" : "iife", target: "chrome120", sourcemap: false,
    legalComments: "none", minify: false });
}
console.log("Built dist/ — load this folder as an unpacked extension.");

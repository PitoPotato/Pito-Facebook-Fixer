import "./build.mjs";
import { mkdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
const manifest = JSON.parse(await readFile("dist/manifest.json", "utf8"));
await mkdir("release", { recursive: true });
const output = path.resolve(`release/PitoFacebookFixer-${manifest.version}.zip`);
execFileSync("python", ["-c", `import pathlib,sys,zipfile
root=pathlib.Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED) as archive:
 for item in sorted(root.rglob('*')):
  if item.is_file(): archive.write(item,item.relative_to(root).as_posix())
 for document in sys.argv[3:]:
  item=pathlib.Path(document)
  archive.write(item,('docs/'+item.name) if item.parent.name=='docs' else item.name)
`, path.resolve("dist"), output, ...["README.md", "QA.md", "TEST_RESULTS.md","UI_RESEARCH.md","docs/brand-guidelines.md"].map(file => path.resolve(file))], { stdio: "inherit" });
console.log(output);

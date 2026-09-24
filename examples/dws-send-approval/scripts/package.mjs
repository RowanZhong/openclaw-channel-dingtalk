import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "artifacts");
const staging = await mkdtemp(join(tmpdir(), "dws-approval-pack-"));
try {
  const included = new Set([
    "package.json",
    "openclaw.plugin.json",
    "config.example.json",
    "config.kubernetes.example.json",
    "README.md",
    "LICENSE",
    "tests",
    "scripts",
    "templates",
    "channel",
  ]);
  for (const name of await readdir(root)) {
    if (name.endsWith(".mjs") || included.has(name)) {
      await cp(join(root, name), join(staging, name), { recursive: true });
    }
  }
  const documents = [
    ["docs/contributor/dws-reply-assistant-deployment", "DEVELOPER"],
    ["docs/user/dws-reply-assistant-manual", "USER-MANUAL"],
  ];
  for (const [source, target] of documents) {
    for (const extension of ["md", "html"]) {
      let document;
      try {
        document = await readFile(
          new URL(`../../../${source}.${extension}`, import.meta.url),
          "utf8",
        );
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        document = await readFile(join(root, `${target}.${extension}`), "utf8");
      }
      document = document
        .replaceAll("../contributor/dws-reply-assistant-deployment.html", "DEVELOPER.html")
        .replaceAll("../user/dws-reply-assistant-manual.html", "USER-MANUAL.html");
      await writeFile(join(staging, `${target}.${extension}`), document);
    }
  }
  await writeFile(
    join(staging, "GUIDE.md"),
    "# 文档入口\n\n- [技术方案与安装配置](DEVELOPER.html)\n- [员工使用手册](USER-MANUAL.html)\n",
  );
  await writeFile(
    join(staging, "GUIDE.html"),
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>文档入口</title><h1>钉钉个人代回复助手</h1><p><a href="DEVELOPER.html">技术方案与安装配置</a></p><p><a href="USER-MANUAL.html">员工使用手册</a></p></html>',
  );
  await mkdir(output, { recursive: true });
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", output], {
      cwd: staging,
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: join(staging, ".npm-cache") },
    }),
  );
  process.stdout.write(join(output, packed[0].filename) + "\n");
} finally {
  await rm(staging, { recursive: true, force: true });
}

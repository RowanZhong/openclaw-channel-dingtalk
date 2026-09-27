import { rm } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });

await build({
  bundle: true,
  entryPoints: { index: "index.ts", "card-extensions": "src/card/card-extension-api.ts" },
  format: "esm",
  logLevel: "info",
  outdir: "dist",
  packages: "external",
  platform: "node",
  sourcemap: false,
  target: "node22",
  tsconfigRaw: {
    compilerOptions: {
      esModuleInterop: true,
      module: "ESNext",
      moduleResolution: "bundler",
      target: "ES2023",
    },
  },
});

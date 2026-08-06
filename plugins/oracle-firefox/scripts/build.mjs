import { build } from "esbuild";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";

await import("./generate-build-info.mjs");

await rm("dist", { recursive: true, force: true });

await build({
  entryPoints: {
    server: "src/server.mjs",
    cli: "src/cli.mjs",
    broker: "src/broker.mjs",
    "oracle-claudex": "src/oracle-claudex.mjs",
  },
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outExtension: { ".js": ".mjs" },
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  sourcemap: false,
  legalComments: "linked",
  logLevel: "info",
});

for (const filename of await readdir("dist")) {
  if (!filename.endsWith(".mjs")) continue;
  const target = `dist/${filename}`;
  const source = await readFile(target, "utf8");
  await writeFile(target, source.replace(/[ \t]+$/gmu, ""));
}

await import("./generate-harnesses.mjs");

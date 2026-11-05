// Test-only module resolution for pi's host packages.
//
// Two environments have to work:
//
// 1. A normal checkout with devDependencies installed (`npm install`, CI): plain
//    Node resolution finds the host packages and this file does nothing.
// 2. A checkout without node_modules, testing against the user's own pi install:
//    pi ships as a self-contained bundle whose dependencies live in hashed
//    `node_modules/.mise/@earendil-works+<pkg>@<version>_.../node_modules/...`
//    directories, so bare `@earendil-works/*` and `typebox` specifiers need a
//    mapper. That copy is what the tests then use.
//
// The extension itself never imports this file.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const localHost = join(pkgRoot, "node_modules", "@earendil-works", "pi-coding-agent");

if (!existsSync(localHost)) {
  installHostMapper();
}

function installHostMapper() {
  const miseDir = findMiseDir();
  const packages = new Map();

  for (const entry of readdirSync(miseDir)) {
    const nested = join(miseDir, entry, "node_modules");
    if (!existsSync(nested)) continue;
    const scoped = join(nested, "@earendil-works");
    if (existsSync(scoped))
      for (const name of readdirSync(scoped)) packages.set(`@earendil-works/${name}`, join(scoped, name));
    if (existsSync(join(nested, "typebox"))) packages.set("typebox", join(nested, "typebox"));
  }

  registerHooks({
    resolve(specifier, context, nextResolve) {
      const [name, ...rest] =
        specifier.startsWith("@")
          ? [specifier.split("/").slice(0, 2).join("/"), ...specifier.split("/").slice(2)]
          : [specifier.split("/")[0], ...specifier.split("/").slice(1)];
      const dir = packages.get(name);
      if (!dir) return nextResolve(specifier, context);
      return { url: pathToFileURL(entryPoint(dir, rest.join("/"))).href, shortCircuit: true };
    },
  });
}

/** Directory holding pi's hashed dependency tree, found from the `pi` executable. */
function findMiseDir() {
  let bin;
  try {
    bin = realpathSync(execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf-8" }).trim());
  } catch {
    throw new Error(
      "host packages not found: run `npm install` in this checkout, or put pi on PATH " +
        "(npm i -g @earendil-works/pi-coding-agent)",
    );
  }
  let dir = dirname(bin);
  while (dir !== "/") {
    const candidate = join(dir, "node_modules", ".mise");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`no node_modules/.mise directory above ${bin}: run \`npm install\` in this checkout`);
}

/** Resolve a package entry point through its `exports` map (patterns included). */
function entryPoint(dir, subpath) {
  const pkgFile = join(dir, "package.json");
  const pkg = existsSync(pkgFile) ? JSON.parse(readFileSync(pkgFile, "utf-8")) : {};
  const pick = (v) => (typeof v === "string" ? v : v?.import ?? v?.default);
  const rel = subpath ? `./${subpath}` : ".";
  let target;
  const exportsField = pkg.exports;
  if (exportsField && typeof exportsField === "object") {
    target = pick(exportsField[rel]);
    if (!target) {
      const patterns = Object.keys(exportsField)
        .filter((k) => k.includes("*"))
        .sort((a, b) => b.split("*")[0].length - a.split("*")[0].length);
      for (const key of patterns) {
        const [pre, post = ""] = key.split("*");
        const stem = post.endsWith(".js") ? rel.slice(0, -3) : rel;
        if (!stem.startsWith(pre) || !stem.endsWith(post)) continue;
        const star = stem.slice(pre.length, stem.length - post.length);
        target = pick(exportsField[key])?.replace("*", star);
        if (target) break;
      }
    }
  }
  if (!target) target = subpath ? subpath : pkg.main ?? "index.js";
  return join(dir, target);
}

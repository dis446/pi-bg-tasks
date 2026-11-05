// Test-only module resolution for pi's host packages.
//
// pi ships as a self-contained bundle whose dependencies live in hashed
// `node_modules/.mise/@earendil-works+<pkg>@<version>_.../node_modules/...`
// directories, so a plain `node --test` cannot resolve `@earendil-works/*` or
// `typebox`. This hook maps those bare specifiers to the copy pi itself uses,
// discovered from the resolved `pi` executable. Nothing here is used at runtime
// by the extension.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

function findMiseDir() {
  const bin = realpathSync(execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf-8" }).trim());
  let dir = dirname(bin);
  while (dir !== "/") {
    const candidate = join(dir, "node_modules", ".mise");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error("could not locate pi's node_modules/.mise directory");
}

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

function entryPoint(dir, subpath) {
  const pkgFile = join(dir, "package.json");
  const pkg = existsSync(pkgFile) ? JSON.parse(readFileSync(pkgFile, "utf-8")) : {};
  const exportsField = pkg.exports;
  const pick = (v) => (typeof v === "string" ? v : v?.import ?? v?.default);
  const rel = subpath ? `./${subpath}` : ".";
  let target;
  if (exportsField && typeof exportsField === "object") {
    target = pick(exportsField[rel]);
    if (!target) {
      // wildcard keys, longest prefix first (Node's own precedence rule)
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
  return pathToFileURL(join(dir, target)).href;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const [name, ...rest] = specifier.startsWith("@") ? [specifier.split("/").slice(0, 2).join("/"), ...specifier.split("/").slice(2)] : [specifier.split("/")[0], ...specifier.split("/").slice(1)];
    const dir = packages.get(name);
    if (dir) return { url: entryPoint(dir, rest.join("/")), shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

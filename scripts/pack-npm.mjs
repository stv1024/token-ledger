import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Packs the npm tarball that the release workflow publishes. The source
// package.json stays `private` so a stray `npm publish` in the repository
// fails; the staged copy drops `private` and the development scripts.
const run = promisify(execFile);
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "Run this script with npm run pack:npm");
const npm = (args, cwd) => run(process.execPath, [npmCli, ...args], { cwd });

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
delete pkg.private;
delete pkg.scripts;

// npm resolves the `files` globs; copy exactly the files it would pack.
const { stdout: listed } = await npm(["pack", "--dry-run", "--ignore-scripts", "--json"], root);
const files = JSON.parse(listed)[0].files.map((file) => file.path);

const output = await mkdtemp(join(tmpdir(), `${pkg.name}-npm-`));
const staging = join(output, "package");
await mkdir(staging);
for (const file of files) {
  await cp(join(root, file), join(staging, file));
}
await writeFile(join(staging, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

const { stdout } = await npm(["pack", "--ignore-scripts", "--json", "--pack-destination", output], staging);
const [packed] = JSON.parse(stdout);
console.log(JSON.stringify({
  artifact: join(output, packed.filename),
  name: packed.name,
  version: packed.version,
  integrity: packed.integrity,
  files: packed.files.map((file) => file.path),
}, null, 2));

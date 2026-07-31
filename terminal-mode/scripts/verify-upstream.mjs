import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(await readFile(join(root, "upstream-lock.json"), "utf8"));
const packageRoot = join(root, "node_modules", "@evenrealities", "even-terminal");

for (const [relativePath, expected] of Object.entries(lock.files)) {
  const content = await readFile(join(packageRoot, relativePath));
  const actual = createHash("sha256").update(content).digest("hex");
  if (actual !== expected) {
    throw new Error(
      `Upstream contract drift for ${relativePath}: expected ${expected}, received ${actual}`,
    );
  }
}

const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
if (pkg.name !== lock.package || pkg.version !== lock.version) {
  throw new Error(
    `Unexpected upstream package ${pkg.name}@${pkg.version}; expected ${lock.package}@${lock.version}`,
  );
}

console.log(`verified ${lock.package}@${lock.version}`);

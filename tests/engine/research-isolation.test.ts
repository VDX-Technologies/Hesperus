import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(process.cwd(), "app/research");
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.[jt]sx?$/.test(name) ? [path] : [];
  });
}

describe("Research console isolation", () => {
  it("does not import or link to Terra", () => {
    for (const path of sourceFiles(root)) {
      const source = readFileSync(path, "utf8");
      expect(source, path).not.toMatch(/from\s+["'][^"']*terra|import\s*\(["'][^"']*terra|\/terra(?:\/|["'`])/i);
    }
  });
});

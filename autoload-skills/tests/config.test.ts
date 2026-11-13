import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  CONFIG_FILENAME,
  loadAutoloadConfig,
  parseSkillSpecs,
} from "../src/autoload-skills/config.ts";

const tempDirs: string[] = [];

function tempAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "autoload-skills-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop() ?? "", { recursive: true, force: true });
});

describe("parseSkillSpecs", () => {
  it("accepts an object with string skill names", () => {
    expect(parseSkillSpecs({ skills: [" review ", "pdf"] }, "cfg")).toEqual([
      { name: "review" },
      { name: "pdf" },
    ]);
  });

  it("accepts a top-level array and object entries with args", () => {
    expect(parseSkillSpecs(["alpha", { name: "beta", args: "focus tests" }], "cfg")).toEqual([
      { name: "alpha" },
      { name: "beta", args: "focus tests" },
    ]);
  });

  it("rejects duplicates and empty names", () => {
    expect(() => parseSkillSpecs({ skills: ["a", "a"] }, "cfg")).toThrow(/Duplicate skill "a"/);
    expect(() => parseSkillSpecs({ skills: [""] }, "cfg")).toThrow(/non-empty name/);
  });

  it("rejects a missing skills field", () => {
    expect(() => parseSkillSpecs({}, "cfg")).toThrow(/must have a "skills" array/);
  });
});

describe("loadAutoloadConfig", () => {
  it("returns undefined when the file is absent", () => {
    expect(loadAutoloadConfig(tempAgentDir())).toBeUndefined();
  });

  it("reads autoload-skills.json from the agent directory", () => {
    const dir = tempAgentDir();
    writeFileSync(join(dir, CONFIG_FILENAME), JSON.stringify({ skills: ["code-review"] }));
    expect(loadAutoloadConfig(dir)).toEqual({
      path: join(dir, CONFIG_FILENAME),
      skills: [{ name: "code-review" }],
    });
  });

  it("throws on invalid JSON", () => {
    const dir = tempAgentDir();
    writeFileSync(join(dir, CONFIG_FILENAME), "{");
    expect(() => loadAutoloadConfig(dir)).toThrow(/Unable to read autoload skills config/);
  });
});

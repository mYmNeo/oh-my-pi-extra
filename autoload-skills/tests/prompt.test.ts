import { describe, expect, it } from "bun:test";
import {
  stripAutoloadedSkillsFromPrompt,
  stripAutoloadedSkillsFromSystemPrompt,
} from "../src/autoload-skills/prompt.ts";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent";

const hostSkill = (name: string) => ({
  name,
  description: `${name} desc`,
  filePath: `/s/${name}/SKILL.md`,
  baseDir: `/s/${name}`,
  source: "native" as const,
});

const DEFAULT_SKILLS_SECTION =
  /# Skills & Rules\nMatching skill → MUST read `skill:\/\/<name>` first\.\n<skills>\n[\s\S]*?\n<\/skills>/;

describe("stripAutoloadedSkillsFromPrompt", () => {
  it("keeps the header, intro, and remaining entries when stripping one skill", async () => {
    const { systemPrompt } = await buildSystemPrompt({
      skills: [hostSkill("alpha"), hostSkill("beta")],
    });
    const next = stripAutoloadedSkillsFromPrompt(systemPrompt[0] ?? "", new Set(["alpha"]));
    expect(next).toContain("# Skills & Rules");
    expect(next).toContain("Matching skill → MUST read `skill://<name>` first.");
    expect(next).toContain("- beta: beta desc");
    expect(next).not.toContain("- alpha:");
  });

  it("drops block, intro, and header when every skill is stripped — matching the host zero-skill render", async () => {
    const withSkills = await buildSystemPrompt({
      skills: [hostSkill("alpha"), hostSkill("beta")],
    });
    const withoutSkills = await buildSystemPrompt({
      skills: [],
    });
    const next = stripAutoloadedSkillsFromPrompt(
      withSkills.systemPrompt[0] ?? "",
      new Set(["alpha", "beta"]),
    );
    expect(next).not.toMatch(DEFAULT_SKILLS_SECTION);
    expect(next).not.toContain("# Skills & Rules");
    expect(next).not.toContain("Matching skill");
    // The join between the surrounding sections survives the strip.
    expect(next).toContain("§ Runtime");
    expect(next).toContain("# Internal URLs");
    expect(next.split("§ Runtime").length).toBe(
      (withoutSkills.systemPrompt[0] ?? "").split("§ Runtime").length,
    );
  });

  it("drops the custom-template intro sentences when the SYSTEM.md block empties", async () => {
    const { systemPrompt } = await buildSystemPrompt({
      customPrompt: "Custom user line.\n",
      skills: [hostSkill("only")],
    });
    const next = stripAutoloadedSkillsFromPrompt(systemPrompt[0] ?? "", new Set(["only"]));
    expect(next.trim()).toBe("Custom user line.");
  });

  it("keeps user SYSTEM.md lines that sit directly above the skills intro", async () => {
    const { systemPrompt } = await buildSystemPrompt({
      customPrompt: "Para one.\n\nLine A\nLine B",
      skills: [hostSkill("only")],
    });
    const next = stripAutoloadedSkillsFromPrompt(systemPrompt[0] ?? "", new Set(["only"]));
    expect(next).toContain("Para one.\n\nLine A\nLine B");
    expect(next).not.toContain("Skills are specialized knowledge");
    expect(next).not.toContain("<skills>");
  });

  it("keeps the # Skills & Rules header when rules still follow the emptied block", () => {
    const text =
      "§ Runtime\n# Skills & Rules\nMatching skill → MUST read `skill://<name>` first.\n<skills>\n- only: d\n</skills>\n\n<generic-rules>\nRULE\n</generic-rules>\n# Internal URLs\n";
    const next = stripAutoloadedSkillsFromPrompt(text, new Set(["only"]));
    expect(next).toContain("§ Runtime\n# Skills & Rules\n");
    expect(next).toContain("<generic-rules>\nRULE\n</generic-rules>");
    expect(next).not.toContain("Matching skill");
    expect(next).not.toContain("<skills>");
  });

  it("leaves text byte-identical when no listed name matches", async () => {
    const { systemPrompt } = await buildSystemPrompt({
      skills: [hostSkill("keep")],
    });
    const text = systemPrompt[0] ?? "";
    expect(stripAutoloadedSkillsFromPrompt(text, new Set(["other"]))).toBe(text);
  });

  it("drops wrapped continuation lines together with their dash entry", () => {
    const text = [
      "# Skills & Rules",
      "Matching skill → MUST read `skill://<name>` first.",
      "<skills>",
      "- alpha: first line",
      "  wrapped detail line",
      "- beta: b",
      "</skills>",
    ].join("\n");
    const next = stripAutoloadedSkillsFromPrompt(text, new Set(["alpha"]));
    expect(next).toContain("- beta: b");
    expect(next).not.toContain("alpha");
    expect(next).not.toContain("wrapped detail line");
  });
});

describe("stripAutoloadedSkillsFromSystemPrompt", () => {
  it("returns undefined when nothing changes", () => {
    expect(stripAutoloadedSkillsFromSystemPrompt(["hello"], new Set(["gone"]))).toBeUndefined();
  });

  it("rewrites only blocks that contain the catalog", async () => {
    const { systemPrompt } = await buildSystemPrompt({
      skills: [hostSkill("alpha"), hostSkill("beta")],
    });
    const next = stripAutoloadedSkillsFromSystemPrompt(
      ["preamble", systemPrompt[0] ?? ""],
      new Set(["alpha"]),
    );
    expect(next?.[0]).toBe("preamble");
    expect(next?.[1]).not.toContain("- alpha:");
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  resetActiveSkillsForTests,
  setActiveSkills,
  SKILL_PROMPT_MESSAGE_TYPE,
  type CustomMessagePayload,
  type ExtensionContext,
  type SessionEntry,
  type SessionMessageEntry,
  type Skill,
} from "@oh-my-pi/pi-coding-agent";
import {
  AUTOLOAD_SKILLS_MESSAGE_TYPE,
  autoloadSkillsNotifyText,
  createAutoloadSkillsExtension,
  inContextSkillNames,
  reorderAutoloadSkillsMessages,
  resolveAutoloadSkills,
} from "../src/autoload-skills/autoload.ts";
import { fakeCtx, fakePi, type FakePi } from "./helpers.ts";

const tempDirs: string[] = [];
const activeSkills: Skill[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `autoload-skills-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

/** Write a real skill file so the unstubbed host renderer can load its body. */
function makeRealSkill(name: string, body: string): Skill {
  const dir = tempDir(name);
  const filePath = join(dir, "SKILL.md");
  writeFileSync(
    filePath,
    ["---", `name: ${name}`, `description: ${name} skill`, "---", "", body].join("\n"),
  );
  return { name, description: `${name} skill`, filePath, baseDir: dir, source: "native" };
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop() ?? "", { recursive: true, force: true });
  while (activeSkills.length > 0) activeSkills.pop();
  resetActiveSkillsForTests();
});

let entryCounter = 0;

function userMessageEntry(text: string): SessionMessageEntry {
  entryCounter++;
  return {
    type: "message",
    id: `e-${entryCounter}`,
    parentId: entryCounter === 1 ? null : `e-${entryCounter - 1}`,
    timestamp: new Date().toISOString(),
    message: {
      role: "user",
      content: text,
      timestamp: Date.now(),
    } as SessionMessageEntry["message"],
  };
}

function resetBoundaryEntry(): SessionEntry {
  entryCounter++;
  return {
    type: "reset_boundary",
    id: `e-${entryCounter}`,
    parentId: `e-${entryCounter - 1}`,
    timestamp: new Date().toISOString(),
  };
}

function hostSkillPromptEntry(name: string): SessionEntry {
  entryCounter++;
  return {
    type: "custom_message",
    id: `e-${entryCounter}`,
    parentId: `e-${entryCounter - 1}`,
    timestamp: new Date().toISOString(),
    customType: SKILL_PROMPT_MESSAGE_TYPE,
    content: `body of ${name}`,
    display: false,
    details: { name, path: `/skills/${name}/SKILL.md` },
  };
}

/** Persisted custom_message entry mirroring what the host writes for the combined message. */
function autoloadMessageEntry(payload: CustomMessagePayload): SessionEntry {
  entryCounter++;
  return {
    type: "custom_message",
    id: `e-${entryCounter}`,
    parentId: `e-${entryCounter - 1}`,
    timestamp: new Date().toISOString(),
    customType: AUTOLOAD_SKILLS_MESSAGE_TYPE,
    content: typeof payload === "string" ? payload : (payload.content ?? ""),
    display: false,
    details: typeof payload === "string" ? undefined : payload.details,
  };
}

/** Narrow the `before_agent_start` result to its message payload. */
function resultMessage(result: unknown): CustomMessagePayload | undefined {
  if (typeof result !== "object" || result === null || !("message" in result)) return undefined;
  const message: unknown = result.message;
  return typeof message === "string" || message === undefined
    ? message
    : (message as CustomMessagePayload);
}

/** `customType` of a result message, when the payload is the object form. */
function messageCustomType(result: unknown): string | undefined {
  const message = resultMessage(result);
  return typeof message === "object" ? message.customType : undefined;
}

describe("resolveAutoloadSkills", () => {
  it("matches discovered names and reports missing ones", () => {
    const { resolved, missing } = resolveAutoloadSkills(
      [{ name: "keep" }, { name: "gone" }],
      [makeRealSkill("keep", "body")],
    );
    expect(resolved.map((item) => item.skill.name)).toEqual(["keep"]);
    expect(missing).toEqual(["gone"]);
  });
});

describe("inContextSkillNames", () => {
  it("collects host skill-prompt names and own combined-message names", () => {
    const payload: CustomMessagePayload = {
      customType: AUTOLOAD_SKILLS_MESSAGE_TYPE,
      content: "bodies",
      display: false,
      details: {
        skills: [
          { name: "own-a", path: "/a" },
          { name: "own-b", path: "/b" },
        ],
      },
    };
    const { host, own } = inContextSkillNames([
      hostSkillPromptEntry("host-1"),
      autoloadMessageEntry(payload),
    ]);
    expect(host).toEqual(new Set(["host-1"]));
    expect(own).toEqual(new Set(["own-a", "own-b"]));
  });
});

describe("reorderAutoloadSkillsMessages", () => {
  const autoload = { role: "custom", customType: AUTOLOAD_SKILLS_MESSAGE_TYPE, content: "bodies" };
  const user = { role: "user", content: "hi" };
  const assistant = { role: "assistant", content: [] };

  it("moves the injection ahead of the prompt it followed", () => {
    expect(reorderAutoloadSkillsMessages([user, autoload, assistant])).toEqual([
      autoload,
      user,
      assistant,
    ]);
  });

  it("moves ahead of the prompt across intervening turn context", () => {
    const mention = { role: "custom", customType: "file-mention", content: "f" };
    expect(reorderAutoloadSkillsMessages([user, mention, autoload])).toEqual([
      autoload,
      user,
      mention,
    ]);
  });

  it("leaves the order alone without an autoload message", () => {
    expect(reorderAutoloadSkillsMessages([user, assistant])).toBeUndefined();
  });

  it("leaves a leading injection in place", () => {
    expect(reorderAutoloadSkillsMessages([autoload, user])).toBeUndefined();
  });

  it("moves ahead of a user-invoked skill prompt", () => {
    const skillPrompt = {
      role: "custom",
      customType: SKILL_PROMPT_MESSAGE_TYPE,
      attribution: "user",
      content: "task",
    };
    expect(reorderAutoloadSkillsMessages([skillPrompt, autoload])).toEqual([
      autoload,
      skillPrompt,
    ]);
  });

  it("anchors on the current skill prompt, not an older user turn", () => {
    const earlierUser = { role: "user", content: "earlier" };
    const skillPrompt = {
      role: "custom",
      customType: SKILL_PROMPT_MESSAGE_TYPE,
      attribution: "user",
      content: "task",
    };
    expect(reorderAutoloadSkillsMessages([earlierUser, skillPrompt, autoload])).toEqual([
      earlierUser,
      autoload,
      skillPrompt,
    ]);
  });
});

describe("createAutoloadSkillsExtension", () => {
  const configWith = (names: string[]) => ({
    path: "/agent/autoload-skills.json",
    skills: names.map((name) => ({ name })),
  });

  async function startedExtension(
    names: string[],
    kind: "main" | "sub" = "main",
  ): Promise<{ extension: FakePi; ctx: ReturnType<typeof fakeCtx> }> {
    const extension = fakePi();
    createAutoloadSkillsExtension({
      agentDir: "/agent",
      loadConfig: () => configWith(names),
    })(extension.pi);
    const ctx = fakeCtx({ kind });
    await extension.emit("session_start", { type: "session_start" }, ctx);
    return { extension, ctx };
  }

  it("injects one combined message via the before_agent_start result on the first turn", async () => {
    const skill = makeRealSkill("fresh", "TOKEN_FRESH_BODY");
    setActiveSkills([skill]);
    const { extension, ctx } = await startedExtension(["fresh"]);

    const result = await extension.emit(
      "before_agent_start",
      { type: "before_agent_start", prompt: "hi", systemPrompt: [] },
      ctx,
    );
    const message = resultMessage(result);
    if (typeof message !== "object") throw new Error("expected object payload");
    expect(message).toMatchObject({
      customType: AUTOLOAD_SKILLS_MESSAGE_TYPE,
      display: true,
      attribution: "agent",
    });
    const content = typeof message.content === "string" ? message.content : "";
    expect(content).toContain("TOKEN_FRESH_BODY");
    expect(ctx.notifies).toEqual([]);
    const render = extension.renderers.get(AUTOLOAD_SKILLS_MESSAGE_TYPE);
    if (!render) throw new Error("expected a registered message renderer");
    const plainTheme = { fg: (_color: string, text: string) => text } as unknown as Parameters<
      typeof render
    >[2];
    const note = render(
      {
        role: "custom",
        timestamp: 0,
        customType: AUTOLOAD_SKILLS_MESSAGE_TYPE,
        content,
        display: true,
        details: message.details,
      },
      { expanded: false },
      plainTheme,
    );
    const rendered = note?.render(80).join("\n") ?? "";
    expect(rendered).toContain(autoloadSkillsNotifyText(["fresh"]));
    expect(rendered).not.toContain("TOKEN_FRESH_BODY");
  });

  it("reorders the injection ahead of the user prompt in the request context", async () => {
    const { extension, ctx } = await startedExtension(["fresh"]);
    const user = { role: "user", content: "hi" };
    const autoload = {
      role: "custom",
      customType: AUTOLOAD_SKILLS_MESSAGE_TYPE,
      content: "bodies",
    };
    const result = await extension.emit(
      "context",
      { type: "context", messages: [user, autoload] },
      ctx,
    );
    expect(result).toEqual({ messages: [autoload, user] });
  });

  it("leaves the request context untouched when no autoload message is present", async () => {
    const { extension, ctx } = await startedExtension(["fresh"]);
    const user = { role: "user", content: "hi" };
    expect(
      await extension.emit("context", { type: "context", messages: [user] }, ctx),
    ).toBeUndefined();
  });

  it("leaves the request context untouched when no skills are configured", async () => {
    const { extension, ctx } = await startedExtension([]);
    const user = { role: "user", content: "hi" };
    const autoload = {
      role: "custom",
      customType: AUTOLOAD_SKILLS_MESSAGE_TYPE,
      content: "bodies",
    };
    expect(
      await extension.emit("context", { type: "context", messages: [user, autoload] }, ctx),
    ).toBeUndefined();
  });

  it("dedupes against skill bodies already in the model context and still strips the catalog", async () => {
    const skill = makeRealSkill("resident", "TOKEN_RESIDENT_BODY");
    setActiveSkills([skill]);
    const entries = [userMessageEntry("hi"), hostSkillPromptEntry("resident")];
    const { extension, ctx } = await startedExtension(["resident"]);
    const ctxWithHistory = fakeCtx({ entries });

    const result = await extension.emit(
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "hi",
        systemPrompt: ["# Skills & Rules\n<skills>\n- resident: resident skill\n</skills>"],
      },
      ctxWithHistory,
    );
    expect(resultMessage(result)).toBeUndefined();
    const systemPrompt = (result as { systemPrompt?: string[] }).systemPrompt;
    expect(systemPrompt?.[0]).not.toContain("- resident:");
    expect(ctx.notifies).toEqual([]);
  });

  it("re-injects after a reset_boundary because the body left the model context", async () => {
    const skill = makeRealSkill("reload", "TOKEN_RELOAD_BODY");
    setActiveSkills([skill]);
    const payload: CustomMessagePayload = {
      customType: AUTOLOAD_SKILLS_MESSAGE_TYPE,
      content: "body",
      display: false,
      details: { skills: [{ name: "reload", path: skill.filePath }] },
    };
    // Before reset: body in context (deduped). After reset boundary: gone (re-injected).
    const beforeReset = [userMessageEntry("hi"), autoloadMessageEntry(payload)];
    const afterReset = [...beforeReset, resetBoundaryEntry(), userMessageEntry("fresh start")];
    const { extension } = await startedExtension(["reload"]);

    const deduped = await extension.emit(
      "before_agent_start",
      { type: "before_agent_start", prompt: "hi", systemPrompt: [] },
      fakeCtx({ entries: beforeReset }),
    );
    expect(resultMessage(deduped)).toBeUndefined();

    const reinjected = await extension.emit(
      "before_agent_start",
      { type: "before_agent_start", prompt: "fresh start", systemPrompt: [] },
      fakeCtx({ entries: afterReset }),
    );
    expect(messageCustomType(reinjected)).toBe(AUTOLOAD_SKILLS_MESSAGE_TYPE);
  });

  it("re-injects when the branch leaf excludes the earlier injection", async () => {
    const skill = makeRealSkill("branchy", "TOKEN_BRANCHY_BODY");
    setActiveSkills([skill]);
    const payload: CustomMessagePayload = {
      customType: AUTOLOAD_SKILLS_MESSAGE_TYPE,
      content: "body",
      display: false,
      details: { skills: [{ name: "branchy", path: skill.filePath }] },
    };
    // Two siblings off the same parent; the leaf (last entry) selects the
    // branch WITHOUT the injection.
    const withInjection = [userMessageEntry("a"), autoloadMessageEntry(payload)];
    const siblingBranch = [userMessageEntry("a"), userMessageEntry("b, different branch")];
    const { extension } = await startedExtension(["branchy"]);

    const onInjectionBranch = await extension.emit(
      "before_agent_start",
      { type: "before_agent_start", prompt: "a", systemPrompt: [] },
      fakeCtx({ entries: withInjection }),
    );
    expect(resultMessage(onInjectionBranch)).toBeUndefined();

    const onSiblingBranch = await extension.emit(
      "before_agent_start",
      { type: "before_agent_start", prompt: "b", systemPrompt: [] },
      fakeCtx({ entries: siblingBranch }),
    );
    expect(messageCustomType(onSiblingBranch)).toBe(AUTOLOAD_SKILLS_MESSAGE_TYPE);
  });

  it("injects nothing for subagents", async () => {
    const skill = makeRealSkill("mainly", "TOKEN_MAINLY_BODY");
    setActiveSkills([skill]);
    const { extension, ctx } = await startedExtension(["mainly"], "sub");

    const result = await extension.emit(
      "before_agent_start",
      { type: "before_agent_start", prompt: "hi", systemPrompt: [] },
      ctx,
    );
    expect(result).toBeUndefined();
    expect(ctx.notifies).toEqual([]);
  });

  it("does not depend on session_start ordering: skills config loaded before first turn only", async () => {
    const extension = fakePi();
    createAutoloadSkillsExtension({
      agentDir: "/agent",
      loadConfig: () => ({ path: "/agent/autoload-skills.json", skills: [{ name: "late" }] }),
    })(extension.pi);
    // No session_start fired yet: no config, no injection, no error.
    const ctx = fakeCtx();
    const result = await extension.emit(
      "before_agent_start",
      { type: "before_agent_start", prompt: "hi", systemPrompt: [] },
      ctx,
    );
    expect(result).toBeUndefined();
    expect(extension.errors).toEqual([]);
  });

  it("reports a broken config file without injecting", async () => {
    const extension = fakePi();
    createAutoloadSkillsExtension({
      agentDir: "/agent",
      loadConfig: () => {
        throw new Error(
          "Unable to read autoload skills config /agent/autoload-skills.json: bad json",
        );
      },
    })(extension.pi);
    const ctx = fakeCtx();
    await extension.emit("session_start", { type: "session_start" }, ctx);

    expect(extension.errors).toEqual([
      "Unable to read autoload skills config /agent/autoload-skills.json: bad json",
    ]);
    expect(ctx.notifies).toEqual([
      {
        message: "Unable to read autoload skills config /agent/autoload-skills.json: bad json",
        type: "error",
      },
    ]);

    const result = await extension.emit(
      "before_agent_start",
      { type: "before_agent_start", prompt: "hi", systemPrompt: [] },
      ctx,
    );
    expect(result).toBeUndefined();
  });

  it("warns once per session id for missing skills and still injects the rest", async () => {
    const skill = makeRealSkill("present", "TOKEN_PRESENT_BODY");
    setActiveSkills([skill]);
    const extension = fakePi();
    const sessionIds = ["sess-1"];
    createAutoloadSkillsExtension({
      agentDir: "/agent",
      loadConfig: () => configWith(["present", "ghost"]),
    })(extension.pi);
    const ctx = fakeCtx({ sessionId: sessionIds[0] });
    await extension.emit("session_start", { type: "session_start" }, ctx);

    await extension.emit(
      "before_agent_start",
      { type: "before_agent_start", prompt: "hi", systemPrompt: [] },
      ctx,
    );
    expect(extension.warnings.filter((w) => w.includes('"ghost"'))).toHaveLength(1);
    // Second turn of the same session: body already in context, no new warning.
    await extension.emit(
      "before_agent_start",
      { type: "before_agent_start", prompt: "hi again", systemPrompt: [] },
      ctx,
    );
    expect(extension.warnings.filter((w) => w.includes('"ghost"'))).toHaveLength(1);

    // New session id: warning repeats.
    const ctx2 = fakeCtx({ sessionId: "sess-2" });
    await extension.emit(
      "session_switch",
      { type: "session_switch", reason: "new", previousSessionFile: undefined },
      ctx2,
    );
    await extension.emit(
      "before_agent_start",
      { type: "before_agent_start", prompt: "hi", systemPrompt: [] },
      ctx2,
    );
    expect(extension.warnings.filter((w) => w.includes('"ghost"'))).toHaveLength(2);
  });

  it("renders real skill bodies end to end through the host loader", async () => {
    const skillDir = tempDir("real");
    mkdirSync(skillDir, { recursive: true });
    const filePath = join(skillDir, "SKILL.md");
    writeFileSync(
      filePath,
      [
        "---",
        "name: live-skill",
        "description: end-to-end autoload",
        "---",
        "",
        "TOKEN_LIVE_SKILL",
      ].join("\n"),
    );
    setActiveSkills([
      {
        name: "live-skill",
        description: "end-to-end autoload",
        filePath,
        baseDir: skillDir,
        source: "native",
      },
    ]);
    const { extension, ctx } = await startedExtension(["live-skill"]);
    const result = await extension.emit(
      "before_agent_start",
      { type: "before_agent_start", prompt: "hi", systemPrompt: [] },
      ctx,
    );
    const message = resultMessage(result);
    expect(
      message && typeof message === "object" && typeof message.content === "string"
        ? message.content
        : "",
    ).toContain("TOKEN_LIVE_SKILL");
    const details = (message as { details?: { skills?: Array<{ path: string }> } } | undefined)
      ?.details;
    expect(details?.skills?.[0]?.path).toBe(filePath);
  });
});

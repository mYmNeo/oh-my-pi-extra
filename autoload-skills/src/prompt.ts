const SKILLS_BLOCK = /<skills>\n([\s\S]*?)\n<\/skills>/;

const XML_SKILL = /<skill name="([^"]+)">[\s\S]*?<\/skill>/g;

/** A dash-list entry line names its skill; following non-entry lines belong to it. */
const DASH_ENTRY = /^- ([^:\n]+):/;

/**
 * Remove `names` from a `<skills>` catalog body. Handles the default dash list
 * (`- name: desc` plus its wrapped continuation lines) and the custom SYSTEM.md
 * XML form (`<skill name="…">…</skill>`).
 */
function filterSkillsBody(body: string, names: ReadonlySet<string>): { lines: string[]; removed: number } {
	const xml = [...body.matchAll(XML_SKILL)];
	if (xml.length > 0) {
		const kept = xml.filter((match) => !names.has(match[1] ?? ""));
		return { lines: kept.map((match) => match[0]), removed: xml.length - kept.length };
	}

	const lines = body.split("\n");
	const kept: string[] = [];
	let removed = 0;
	let dropping = false;
	for (const line of lines) {
		const match = DASH_ENTRY.exec(line);
		if (match) {
			// Every `- name:` line starts an entry; continuation lines never do.
			dropping = names.has(match[1]?.trim() ?? "");
			if (dropping) removed++;
			if (!dropping) kept.push(line);
			continue;
		}
		if (dropping) continue; // wrapped description lines of a dropped entry
		kept.push(line);
	}
	return { lines: kept, removed };
}

/** Host intro sentences rendered directly above a `<skills>` block (default and SYSTEM.md templates). */
const INTRO_LINES: Record<string, true> = {
	"Matching skill → MUST read `skill://<name>` first.": true,
	"Skills are specialized knowledge. Scan descriptions for your task domain.": true,
	"If a skill applies, you MUST read `skill://<name>` before proceeding.": true,
};

const SKILLS_HEADER = "# Skills & Rules";

/**
 * Drop the host intro lines directly above an emptied `<skills>` block, plus the
 * `# Skills & Rules` header when the section has nothing left after the block.
 * Only exact host wording is removed, so user-authored SYSTEM.md text survives.
 */
function dropIntroLines(prefix: string, rest: string): string {
	const lines = prefix.split("\n");
	let end = lines.length;
	while (end > 0 && lines[end - 1]?.trim() === "") end--; // separator before the block
	while (end > 0 && INTRO_LINES[lines[end - 1] ?? ""] === true) end--;
	const next = rest.split("\n").find((line) => line.trim() !== "") ?? "";
	const sectionEmpty = next === "" || next.startsWith("#") || next.startsWith("§");
	if (sectionEmpty && lines[end - 1] === SKILLS_HEADER) end--;
	return lines.slice(0, end).join("\n");
}

/**
 * Drop autoloaded skills from the system-prompt catalog so the model is not
 * told to `read skill://<name>` for bodies already in context.
 *
 * Only `<skills>…</skills>` blocks are touched. When a block empties, it is
 * removed together with the intro sentence(s) and header directly above it;
 * all other text stays byte-identical.
 */
export function stripAutoloadedSkillsFromPrompt(text: string, names: ReadonlySet<string>): string {
	if (names.size === 0 || !text.includes("<skills>")) return text;

	let result = "";
	let rest = text;
	for (;;) {
		const match = SKILLS_BLOCK.exec(rest);
		if (!match) {
			result += rest;
			break;
		}
		result += rest.slice(0, match.index);
		rest = rest.slice(match.index + match[0].length);
		const { lines, removed } = filterSkillsBody(match[1] ?? "", names);
		if (removed === 0) {
			result += match[0];
		} else if (lines.length > 0) {
			result += `<skills>\n${lines.join("\n")}\n</skills>`;
		} else {
			result = dropIntroLines(result, rest);
		}
	}
	return result;
}

export function stripAutoloadedSkillsFromSystemPrompt(
	systemPrompt: readonly string[],
	names: ReadonlySet<string>,
): string[] | undefined {
	if (names.size === 0) return undefined;
	const next = systemPrompt.map((block) => stripAutoloadedSkillsFromPrompt(block, names));
	return next.some((block, index) => block !== systemPrompt[index]) ? next : undefined;
}

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";

/** Filename under the default agent directory (`getAgentDir()`, typically `~/.omp/agent`). */
export const CONFIG_FILENAME = "autoload-skills.json";

export interface AutoloadSkillSpec {
	readonly name: string;
	readonly args?: string;
}

export interface AutoloadConfig {
	readonly skills: readonly AutoloadSkillSpec[];
	readonly path: string;
}

export function configPath(agentDir = getAgentDir()): string {
	return join(agentDir, CONFIG_FILENAME);
}

/**
 * Read and parse `autoload-skills.json`. Missing file → `undefined`.
 * Invalid JSON or schema throws.
 */
export function loadAutoloadConfig(agentDir = getAgentDir()): AutoloadConfig | undefined {
	const path = configPath(agentDir);

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		// ENOENT = no config file, which is not an error; anything else surfaces.
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return undefined;
		}
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Unable to read autoload skills config ${path}: ${reason}`);
	}

	return { skills: parseSkillSpecs(parsed, path), path };
}

export function parseSkillSpecs(parsed: unknown, path: string): AutoloadSkillSpec[] {
	const rawSkills = rawSkillList(parsed, path);
	const skills: AutoloadSkillSpec[] = [];
	const seen = new Set<string>();

	for (const [index, entry] of rawSkills.entries()) {
		const spec = parseSkillSpec(entry, path, index);
		if (seen.has(spec.name)) {
			throw new Error(`Duplicate skill ${JSON.stringify(spec.name)} in ${path}`);
		}
		seen.add(spec.name);
		skills.push(spec);
	}

	return skills;
}

function rawSkillList(parsed: unknown, path: string): unknown[] {
	if (Array.isArray(parsed)) return parsed;
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error(`Autoload skills config must be a JSON object or array: ${path}`);
	}
	const record = parsed as Record<string, unknown>;
	if (!Object.hasOwn(record, "skills")) {
		throw new Error(`Autoload skills config must have a "skills" array: ${path}`);
	}
	if (!Array.isArray(record.skills)) {
		throw new Error(`Autoload skills config "skills" must be an array: ${path}`);
	}
	return record.skills;
}

function parseSkillSpec(entry: unknown, path: string, index: number): AutoloadSkillSpec {
	if (typeof entry === "string") {
		const name = entry.trim();
		if (!name) throw new Error(`Autoload skills config skills[${index}] must be a non-empty name: ${path}`);
		return { name };
	}
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
		throw new Error(`Autoload skills config skills[${index}] must be a string or object: ${path}`);
	}
	const record = entry as Record<string, unknown>;
	if (typeof record.name !== "string" || record.name.trim().length === 0) {
		throw new Error(`Autoload skills config skills[${index}].name must be a non-empty string: ${path}`);
	}
	if (record.args !== undefined && typeof record.args !== "string") {
		throw new Error(`Autoload skills config skills[${index}].args must be a string: ${path}`);
	}
	return {
		name: record.name.trim(),
		...(record.args !== undefined ? { args: record.args } : {}),
	};
}

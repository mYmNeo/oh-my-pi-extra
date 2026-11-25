import {
	buildSessionContext,
	buildSkillPromptMessage,
	getAgentDir,
	getActiveSkills,
	isUserAuthoredMessage,
	SKILL_PROMPT_MESSAGE_TYPE,
	type BeforeAgentStartEventResult,
	type CustomMessagePayload,
	type ExtensionAPI,
	type ExtensionContext,
	type Skill,
} from "@oh-my-pi/pi-coding-agent";
import { jsx } from "@oh-my-pi/pi-tui";
import { loadAutoloadConfig, type AutoloadConfig, type AutoloadSkillSpec } from "./config.ts";
import { stripAutoloadedSkillsFromSystemPrompt } from "./prompt.ts";

/** Hidden custom message carrying the combined autoloaded-skill bodies. */
export const AUTOLOAD_SKILLS_MESSAGE_TYPE = "autoload-skills";

export interface ResolvedAutoloadSkill {
	readonly spec: AutoloadSkillSpec;
	readonly skill: Skill;
}

export interface InContextSkillNames {
	/** Names delivered as host `skill-prompt` messages (user `/skill:` calls). */
	readonly host: Set<string>;
	/** Names injected by this extension's combined message. */
	readonly own: Set<string>;
}

/**
 * Names whose skill bodies are in the current model context, derived from the
 * session's active branch after reset boundaries and compaction — not from
 * every entry ever written.
 */
export function inContextSkillNames(messages: readonly unknown[]): InContextSkillNames {
	const host = new Set<string>();
	const own = new Set<string>();
	for (const message of messages) {
		if (typeof message !== "object" || message === null || !("customType" in message) || !("details" in message)) {
			continue;
		}
		const customType = message.customType;
		const details = message.details;
		if (
			customType === SKILL_PROMPT_MESSAGE_TYPE &&
			typeof details === "object" &&
			details !== null &&
			"name" in details
		) {
			const name = details.name;
			if (typeof name === "string" && name.length > 0) host.add(name);
		} else if (
			customType === AUTOLOAD_SKILLS_MESSAGE_TYPE &&
			typeof details === "object" &&
			details !== null &&
			"skills" in details
		) {
			const skills = details.skills;
			if (Array.isArray(skills)) {
				for (const item of skills) {
					if (typeof item === "object" && item !== null && "name" in item) {
						const name = item.name;
						if (typeof name === "string" && name.length > 0) own.add(name);
					}
				}
			}
		}
	}
	return { host, own };
}

/** Structural view of request messages; only the fields the reorder needs. */
interface RequestMessageLike {
	role?: string;
	customType?: string;
}

/**
 * A user-authored turn boundary, using the host's own definition so `/skill:`
 * invocations and user-attributed collab prompts count too. Request messages
 * are AgentMessages at runtime; the structural view lets tests pass plain
 * objects with only the fields the reorder reads.
 */
function isPromptMessage(message: RequestMessageLike): boolean {
	return isUserAuthoredMessage(message as Parameters<typeof isUserAuthoredMessage>[0]);
}

/**
 * Move each autoload-skills message in front of the user prompt it accompanies.
 *
 * The host appends `before_agent_start` messages after the prompt, so the model
 * would read the skill bodies after the request. Applying this to the request
 * context puts them first without changing the session transcript. Returns
 * `undefined` when no message needs moving.
 */
export function reorderAutoloadSkillsMessages<M extends RequestMessageLike>(
	messages: readonly M[],
): M[] | undefined {
	let changed = false;
	const output: M[] = [];
	for (const message of messages) {
		if (message.role !== "custom" || message.customType !== AUTOLOAD_SKILLS_MESSAGE_TYPE) {
			output.push(message);
			continue;
		}
		const promptIndex = output.findLastIndex(isPromptMessage);
		if (promptIndex < 0) {
			output.push(message);
			continue;
		}
		output.splice(promptIndex, 0, message);
		changed = true;
	}
	return changed ? output : undefined;
}

export function resolveAutoloadSkills(
	specs: readonly AutoloadSkillSpec[],
	discovered: readonly Skill[],
): { resolved: ResolvedAutoloadSkill[]; missing: string[] } {
	const byName = new Map(discovered.map((skill) => [skill.name, skill]));
	const resolved: ResolvedAutoloadSkill[] = [];
	const missing: string[] = [];
	for (const spec of specs) {
		const skill = byName.get(spec.name);
		if (!skill) {
			missing.push(spec.name);
			continue;
		}
		resolved.push({ spec, skill });
	}
	return { resolved, missing };
}

/** Combined message details: which autoloaded skill bodies it carries. */
export interface AutoloadSkillsDetails {
	readonly skills: ReadonlyArray<{ name: string; path: string }>;
}

/**
 * One combined message with every pending skill body, delivered via the
 * `before_agent_start` result so the host pushes it into THIS turn's messages.
 */
export async function buildAutoloadSkillsMessage(
	resolved: readonly ResolvedAutoloadSkill[],
	options: { buildPrompt?: typeof buildSkillPromptMessage } = {},
): Promise<{ message: CustomMessagePayload; names: string[] }> {
	const buildPrompt = options.buildPrompt ?? buildSkillPromptMessage;
	const names: string[] = [];
	const bodies: string[] = [];
	const skills: Array<{ name: string; path: string }> = [];
	for (const { spec, skill } of resolved) {
		const { message, details } = await buildPrompt(skill, { args: spec.args ?? "" }, "autoload");
		names.push(skill.name);
		bodies.push(message);
		skills.push({ name: details.name, path: details.path });
	}
	return {
		message: {
			customType: AUTOLOAD_SKILLS_MESSAGE_TYPE,
			content: bodies.join("\n\n"),
			display: true,
			attribution: "agent",
			details: { skills } satisfies AutoloadSkillsDetails,
		},
		names,
	};
}

export function autoloadSkillsNotifyText(names: readonly string[]): string {
	if (names.length === 1) return `Autoloaded skill: ${names[0]}`;
	return `Autoloaded skills: ${names.join(", ")}`;
}

/** Everything the injection needs from the extension host; narrow for tests. */
export interface AutoloadHost {
	/** Report a configured skill that was not discovered (caller dedupes). */
	warnMissing(name: string): void;
}

export interface AutoloadSessionView {
	sessionManager: Pick<ExtensionContext["sessionManager"], "getEntries" | "getLeafId">;
}

/**
 * Compute the `before_agent_start` result for the configured skills: inject
 * bodies not yet in context and strip injected/in-context names from the
 * `skill://` catalog. Pure with respect to the passed session view; missing
 * skills are reported through `host.warnMissing` on every call — once-per-session
 * dedupe is the caller's concern.
 */
export async function computeAutoloadTurn(
	host: AutoloadHost,
	session: AutoloadSessionView,
	specs: readonly AutoloadSkillSpec[],
	options: {
		discovered?: readonly Skill[];
		buildPrompt?: typeof buildSkillPromptMessage;
		systemPrompt?: readonly string[];
	} = {},
): Promise<BeforeAgentStartEventResult | undefined> {
	const inContext = inContextSkillNames(
		buildSessionContext(session.sessionManager.getEntries(), session.sessionManager.getLeafId() ?? undefined).messages,
	);
	const pendingSpecs = specs.filter((spec) => !inContext.host.has(spec.name) && !inContext.own.has(spec.name));
	if (pendingSpecs.length === 0) {
		return {
			systemPrompt: stripAutoloadedSkillsFromSystemPrompt(
				options.systemPrompt ?? [],
				new Set([...inContext.host, ...inContext.own]),
			),
		};
	}

	const discovered = options.discovered ?? getActiveSkills();
	const { resolved, missing } = resolveAutoloadSkills(pendingSpecs, discovered);
	for (const name of missing) host.warnMissing(name);

	let message: CustomMessagePayload | undefined;
	let injected: string[] = [];
	if (resolved.length > 0) {
		const built = await buildAutoloadSkillsMessage(resolved, { buildPrompt: options.buildPrompt });
		message = built.message;
		injected = built.names;
	}

	const systemPrompt = stripAutoloadedSkillsFromSystemPrompt(
		options.systemPrompt ?? [],
		new Set([...inContext.host, ...inContext.own, ...injected]),
	);
	const result: BeforeAgentStartEventResult = {};
	if (message) result.message = message;
	if (systemPrompt) result.systemPrompt = systemPrompt;
	return result;
}

export interface AutoloadSkillsExtensionOptions {
	agentDir?: string;
	loadConfig?: (agentDir: string) => AutoloadConfig | undefined;
}

/**
 * Skills are injected by returning a custom message from
 * `before_agent_start`; session lifecycle events only (re)load the config.
 * Deriving "already in context" from the session's active branch per turn
 * keeps `/reset`, compaction, and branch switches correct without caching.
 * The message is displayed as a one-line transcript note naming the skills;
 * the bodies stay out of the transcript.
 *
 * The host appends that message after the user prompt, so the `context` hook
 * moves it in front of the prompt for the request while the transcript keeps
 * the host's order.
 */
export function createAutoloadSkillsExtension(options: AutoloadSkillsExtensionOptions = {}): (pi: ExtensionAPI) => void {
	const loadConfig = options.loadConfig ?? loadAutoloadConfig;
	const agentDir = options.agentDir ?? getAgentDir();
	return (pi) => {
		pi.registerMessageRenderer<AutoloadSkillsDetails>(AUTOLOAD_SKILLS_MESSAGE_TYPE, (message) => {
			const names = message.details?.skills.map((skill) => skill.name) ?? [];
			return jsx("text", { spans: [{ t: autoloadSkillsNotifyText(names), s: "muted" }] });
		});
		let specs: readonly AutoloadSkillSpec[] = [];
		/** Missing names already warned about, per session id. */
		const warnedMissingBySession = new Map<string, Set<string>>();

		const reloadConfig = async (ctx: ExtensionContext): Promise<void> => {
			try {
				const config = loadConfig(agentDir);
				specs = config?.skills ?? [];
				warnedMissingBySession.clear();
			} catch (error) {
				specs = [];
				const reason = error instanceof Error ? error.message : String(error);
				pi.logger.error(reason);
				ctx.ui.notify(reason, "error");
			}
		};

		pi.on("context", (event) => {
			if (specs.length === 0) return undefined;
			const messages = reorderAutoloadSkillsMessages(event.messages);
			return messages ? { messages } : undefined;
		});

		// `/new`, fork, and resume emit `session_switch`, not `session_start`.
		pi.on("session_start", (_event, ctx) => reloadConfig(ctx));
		pi.on("session_switch", (_event, ctx) => reloadConfig(ctx));

		pi.on("before_agent_start", async (event, ctx) => {
			if (specs.length === 0 || ctx.agent.kind !== "main") return undefined;
			try {
				const session = { sessionManager: ctx.sessionManager };
				const sessionId = ctx.sessionManager.getSessionId();
				const warnedMissing = warnedMissingBySession.get(sessionId) ?? new Set<string>();
				warnedMissingBySession.set(sessionId, warnedMissing);
				return await computeAutoloadTurn(
					{
						warnMissing: (name) => {
							if (warnedMissing.has(name)) return;
							warnedMissing.add(name);
							const message = `autoload-skills: skill ${JSON.stringify(name)} is listed in config but was not discovered`;
							pi.logger.warn(message);
							if (ctx.hasUI) ctx.ui.notify(message, "warning");
						},
					},
					session,
					specs,
					{ systemPrompt: event.systemPrompt },
				);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				const message = `autoload-skills: failed to inject skills: ${reason}`;
				pi.logger.error(message);
				if (ctx.hasUI) ctx.ui.notify(message, "error");
				return undefined;
			}
		});
	};
}

export default function autoloadSkillsExtension(pi: ExtensionAPI): void {
	createAutoloadSkillsExtension()(pi);
}

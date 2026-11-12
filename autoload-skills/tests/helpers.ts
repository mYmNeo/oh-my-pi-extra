import type { ExtensionAPI, ExtensionContext, MessageRenderer, SessionEntry } from "@oh-my-pi/pi-coding-agent";

// Event/ctx in the emit seam are stub shapes; handlers accept the extension's own event types.
type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

export interface FakePi {
	pi: ExtensionAPI;
	handlers: Map<string, EventHandler[]>;
	renderers: Map<string, MessageRenderer>;
	warnings: string[];
	errors: string[];
	emit(event: string, ev: unknown, ctx: ExtensionContext): Promise<unknown>;
}

/** Minimal ExtensionAPI stub capturing handlers and log output. */
export function fakePi(): FakePi {
	const handlers = new Map<string, EventHandler[]>();
	const warnings: string[] = [];
	const errors: string[] = [];
	const renderers = new Map<string, MessageRenderer>();
	const pi = {
		setLabel: () => undefined,
		registerMessageRenderer: (customType: string, renderer: MessageRenderer) => {
			renderers.set(customType, renderer);
		},
		logger: {
			warn: (message: string) => warnings.push(message),
			error: (message: string) => errors.push(message),
		},
		on: (event: string, handler: EventHandler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	} as unknown as ExtensionAPI; // stub: only the surfaces the extension registers need to exist
	return {
		pi,
		handlers,
		renderers,
		warnings,
		errors,
		async emit(event, ev, ctx) {
			const list = handlers.get(event) ?? [];
			let last: unknown;
			for (const handler of list) last = await handler(ev, ctx);
			return last;
		},
	};
}

export interface Notified {
	message: string;
	type?: string;
}

export interface FakeCtxOptions {
	sessionId?: string;
	entries?: SessionEntry[];
	leafId?: string | null;
	kind?: "main" | "sub";
	hasUI?: boolean;
}

/**
 * Minimal ExtensionContext stub for the surfaces the extension touches.
 * Returned as a Partial so tests can also read the recorded notifies.
 */
export function fakeCtx(options: FakeCtxOptions = {}): ExtensionContext & { notifies: Notified[] } {
	const notifies: Notified[] = [];
	const ctx = {
		agent: { kind: options.kind ?? "main", id: "Main", name: "main", depth: 0 },
		hasUI: options.hasUI ?? true,
		sessionManager: {
			getSessionId: () => options.sessionId ?? "sess-1",
			getEntries: () => options.entries ?? [],
			getLeafId: () => options.leafId ?? null,
		},
		ui: {
			notify: (message: string, type?: string) => {
				notifies.push({ message, type });
			},
		},
		notifies,
	};
	// Test stub: only the surfaces the extension touches are real; the rest of
	// the ExtensionContext contract is never invoked.
	return ctx as ExtensionContext & { notifies: Notified[] };
}

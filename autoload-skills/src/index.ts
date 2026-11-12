import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import autoloadSkillsExtension, { createAutoloadSkillsExtension } from "./autoload.ts";

export { createAutoloadSkillsExtension, default, type AutoloadSkillsExtensionOptions } from "./autoload.ts";

// Keep the named form working for `import { autoloadSkillsExtension }` without re-running the factory.
export { autoloadSkillsExtension };

// ExtensionAPI is the handler contract this module implements; re-exported for consumers.
export type { ExtensionAPI };

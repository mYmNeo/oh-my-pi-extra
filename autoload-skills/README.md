# autoload-skills

omp extension that reads `autoload-skills.json` from the default agent directory and injects the listed skills into the model context on the first prompt of each context.

Injection happens in `before_agent_start`: the extension returns one hidden custom message carrying all pending skill bodies, which the host pushes into the current turn. Injection is context-aware — a skill is injected only when its body is not already in the model context, so it re-appears after `/reset`, compaction, or a branch switch (the body left context there), and is not duplicated on later turns of the same context.

Skill bodies use the same provenance-only format as subagent `autoloadSkills`: bodies are in the conversation, not claimed as a user `/skill:` invocation. Autoloaded skills are also stripped from the system-prompt `skill://<name>` catalog (the model already has the body), including the SYSTEM.md `<skill name="…">` listing — but only while their bodies are actually in context. Main session only: subagents never inject.

## Config

Place this file in the active agent directory (`getAgentDir()`, typically `~/.omp/agent/autoload-skills.json`; named profiles use `~/.omp/profiles/<name>/agent/`):

```json
{
  "skills": ["code-review", "go-import-grouping"]
}
```

Optional per-skill args:

```json
{
  "skills": [
    "code-review",
    { "name": "i-have-adhd", "args": "keep replies short" }
  ]
}
```

A top-level JSON array of names is also accepted. Missing config is a no-op. Names are resolved against the host's active skill list (custom directories, ignore/disable filters included). Unknown skill names log a warning and are skipped (warned once per session). Skills already present in the model context are not injected again. When skills are injected, the transcript shows one `Autoloaded skill: <name>` (or `Autoloaded skills: a, b`) note in place of the hidden skill bodies. The note stays after reload or resume, and appears again whenever a skill is re-injected. Because the message is displayed, session history text (`history://`, advisor transcripts) also lists it as an `[autoload-skills] …` line previewing the bodies; that formatting is host-owned.

## Install

From this checkout:

```
omp plugin link .
```

Or register the path:

```yaml
# ~/.omp/agent/config.yml
extensions:
  - /absolute/path/to/autoload-skills
```

Or load once:

```
omp -e /absolute/path/to/autoload-skills
```

The package declares `omp.extensions` → `./src/index.ts`.

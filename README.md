# valet-contextmanager

Defines and provides context@1: persona file loading, preamble, context build.

A [valet](https://github.com/valethq/valet-core) plugin. Imports `@valethq/sdk` only.

Also names sessions: after a session's first completed run it asks the run provider's Utility model (`UtilityModel` on the inference provider) for a short title. It only replaces a missing title or the placeholder valet-agent recorded in `session.settings.titlePlaceholder` (and only while the title still equals it), never a title a person set. Toggle it with "Name sessions automatically" in the Context settings panel.

Per-project persona files live in the project's `persona` settings. `files` lists exact paths (with optional `role` and `minRole`), and `patterns` is an array of regexes matched against each file's path relative to the project's workspace (forward slashes, `.git` and `node_modules` skipped). Every matching file is loaded into context, in pattern order and alphabetically within a pattern, at the per-file byte cap. Matched files are readable by every role. Anchor a pattern with `^` and `$` to match a whole path. When neither `files` nor `patterns` is set, the default persona set applies. Example: `"persona": { "patterns": ["^AGENTS\\.md$", "^docs/.*\\.md$"] }`.

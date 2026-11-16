# valet-contextmanager

Defines and provides context@1: persona file loading, preamble, context build.

A [valet](https://github.com/valethq/valet-core) plugin. Imports `@valethq/sdk` only.

Also names sessions: after a session's first completed run it asks the run provider's Utility model (`UtilityModel` on the inference provider) for a short title. It only replaces a missing title or the placeholder valet-agent recorded in `session.settings.titlePlaceholder` (and only while the title still equals it), never a title a person set. Toggle it with "Name sessions automatically" in the Context settings panel.

Per-project persona files live in the project's `persona` settings. `files` lists exact paths (with optional `role` and `minRole`), and `patterns` is an array of regexes matched against each file's path relative to the project's workspace (forward slashes, `.git` and `node_modules` skipped). Every matching file is loaded into context, in pattern order and alphabetically within a pattern, at the per-file byte cap. Matched files are readable by every role. Anchor a pattern with `^` and `$` to match a whole path. When neither `files` nor `patterns` is set, the default persona set applies. Example: `"persona": { "patterns": ["^AGENTS\\.md$", "^docs/.*\\.md$"] }`.

Provides `tools@1` (owner role only): `view_image`, `session_search` and `session_view`. `session_search` is full-text search (SQLite FTS5, porter stemming, ranked) over every session's messages, compaction summaries and attached file names, across all projects. It lists the session id, title and message number of each hit, and falls back to any-word matching when no message has every word. `session_view` reads one session: the latest messages by default, `around` a message number from a search hit, or `from` a number to page forward. Reasoning and tool output are left out and tool calls show as one-line stubs. The index lives in the plugin's own `p_contextmanager_*` tables, is kept current from `message.create`, `message.complete` and `session.delete`, and catches up on existing sessions at boot.

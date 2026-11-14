# valet-contextmanager

Defines and provides context@1: persona file loading, preamble, context build.

A [valet](https://github.com/valethq/valet-core) plugin. Imports `@valethq/sdk` only.

Also names sessions: after a session's first completed run it asks the run provider's Utility model (`UtilityModel` on the inference provider) for a short title. It only replaces a missing title or the placeholder valet-agent recorded in `session.settings.titlePlaceholder` (and only while the title still equals it), never a title a person set. Toggle it with "Name sessions automatically" in the Context settings panel.

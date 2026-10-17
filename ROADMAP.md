# Roadmap and deferred decisions

Decisions recorded on 2026-10-11:

1. **Claude and Gemini adapters:** Claude was added by a Claude user (`src/providers/claude.mjs`, verified with a Claude Pro login). Gemini still waits for a pull request from someone who actually uses it, implemented and tested against the [provider contract](docs/provider-adapters.md). Do not build a speculative Gemini integration in the meantime.
2. **Switching services within one task:** Defer this until at least one non-Codex adapter has been added and verified. Then design provider selection and switching around real capabilities. Keep each provider's session history separate, mark the switch in the task timeline, and transfer context explicitly. Never treat one provider's session ID as another provider's session.
3. **Start before Windows sign-in:** Keep the current per-user Startup shortcut. Running the web server regardless of whether the user has signed in is a future improvement candidate, not an active change. Before implementing it, verify Codex authentication, access to the user's profile and workspaces, process recovery, and Tailscale Serve availability in the chosen Windows Task Scheduler or service context.

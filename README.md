# claude-mod-blast-radius-ps

Holds risky Bash and PowerShell commands (recursive deletes, git clean/reset/force-push, migrations) and shows what they would change, with Proceed and Cancel. PowerShell-aware port of Anthropic's Blast Radius sample mod.

## Install

```bash
claude plugin marketplace add smhasan-yad/claude-mod-blast-radius-ps
claude plugin install blast-radius-ps@claude-mod-blast-radius-ps
```

A new chat or /reload-plugins picks it up. Written for the Windows desktop app and terminal (Claude Code mods API); not tested elsewhere.

## License

Apache-2.0. Derived from Anthropic's sample mod (Copyright 2026 Anthropic PBC, Apache-2.0). Changes: PowerShell/Windows support. Original file headers are kept.

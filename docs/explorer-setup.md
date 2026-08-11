# Explorer model setup

Explorer model selection is local configuration. Do not commit provider choices:
Anthropic, Azure OpenAI, and gateway credentials differ between environments.

## Fast setup

Set `PI_EXPLORER_MODEL` before starting pi:

```bash
# Azure OpenAI Responses environment
export PI_EXPLORER_MODEL=azure-openai-responses/gpt-5.6-luna

# Anthropic environment
export PI_EXPLORER_MODEL=anthropic/claude-sonnet-5
```

Set `PI_EXPLORER_THINKING` only when needed. Default is `low`.

## Persistent per-machine setup

Create `~/.pi/agent/extensions/explorer-models.json`:

```json
{
  "candidates": [
    "azure-openai-responses/gpt-5.6-luna"
  ]
}
```

Use `anthropic/claude-sonnet-5` instead on Anthropic-only machines. If
`PI_CODING_AGENT_DIR` is set, place file under
`$PI_CODING_AGENT_DIR/extensions/explorer-models.json` instead.

`PI_EXPLORER_MODEL` overrides file candidates. Within `candidates`, first model
present in local model registry wins. This is provider/model selection, not
runtime failover after a request fails.

## Warning behavior

If no configured model resolves, Explorer uses parent model and emits a loud TUI
warning plus warning text in tool result. This fallback is functional but not
recommended: parent may be expensive, unavailable to child session, or unsuitable
for readonly exploration. Configure one model before using Explorer.

`explorer-models.json` is ignored by terminal-setup's Git configuration. Keep
machine-specific values local.

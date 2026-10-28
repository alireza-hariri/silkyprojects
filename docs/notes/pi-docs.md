# Offline pi docs

- **Resume by session ID:** [README → Sessions](/home/alireza/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/README.md#sessions). Run `pi --session <id>` from the project folder; a session file path also works. `--resume` opens a picker, not an ID-based resume.
- **JSON mode:** [JSON event stream](/home/alireza/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/json.md). Example: `pi --mode json --session <id> "Your prompt"`. Outputs JSONL events; the session header includes the ID, and `message_end` contains the final message.
- **Bot / manager integration:** Persistent agent protocol: `/home/alireza/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`. Manager SDK: `/home/alireza/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md`. RPC (`pi --mode rpc`) is distinct from JSON output mode.

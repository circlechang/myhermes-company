#!/bin/sh
# 假 Codex：codex exec --json 樣本。最後一個參數是 prompt。
if [ -n "$FAKE_ARGV_OUT" ]; then printf '%s\n' "$@" > "$FAKE_ARGV_OUT"; env | grep -E '^MHC_' >> "$FAKE_ARGV_OUT" || true; fi
for a in "$@"; do PROMPT="$a"; done
printf '%s\n' '{"type":"thread.started","thread_id":"thread-fake-1"}'
printf '%s\n' '{"type":"turn.started"}'
printf '%s\n' '{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"ls","status":"in_progress"}}'
printf '%s\n' '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"ls","aggregated_output":"a.txt\n","exit_code":0,"status":"completed"}}'
case "$PROMPT" in
  *FAIL*) printf '%s\n' '{"type":"turn.failed","error":{"message":"codex boom"}}'; exit 1 ;;
esac
printf '%s\n' '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"hello from codex"}}'
printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":5}}'

#!/bin/sh
# 假 Claude Code：印出 stream-json 樣本。prompt 含 WRITE_FILE 會寫 hello.py；FAIL 會失敗；SLEEP 會停 30 秒。
PROMPT=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-p" ]; then PROMPT="$a"; fi
  prev="$a"
done
if [ -n "$FAKE_ARGV_OUT" ]; then printf '%s\n' "$@" > "$FAKE_ARGV_OUT"; env | grep -E '^ANTHROPIC_|^MHC_' >> "$FAKE_ARGV_OUT" || true; fi
SID="fake-claude-session-1"
printf '%s\n' '{"type":"system","subtype":"init","cwd":"/tmp","session_id":"'"$SID"'","model":"claude-fake","tools":["Bash"]}'
case "$PROMPT" in
  *SLEEP*) sleep 30 ;;
esac
case "$PROMPT" in
  *WRITE_FILE*)
    printf 'print("hello")\n' > hello.py
    printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Write","input":{"file_path":"hello.py","content":"print(\"hello\")\n"}}]},"session_id":"'"$SID"'"}'
    printf '%s\n' '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"File written"}]},"session_id":"'"$SID"'"}'
    ;;
esac
case "$PROMPT" in
  *FAIL*)
    printf '%s\n' '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"boom","session_id":"'"$SID"'"}'
    exit 1 ;;
esac
printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Here is hello:"}]},"session_id":"'"$SID"'"}'
printf 'not json line on stderr\n' >&2
printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"\n```python\nprint(\"hello\")\n```"}]},"session_id":"'"$SID"'"}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"Here is hello:\n```python\nprint(\"hello\")\n```","session_id":"'"$SID"'","total_cost_usd":0.001,"usage":{"input_tokens":10,"output_tokens":20}}'

#!/bin/sh
printf '%s\n' '{"type":"agent_start","sessionId":"pi-sess-1"}'
printf '%s\n' '{"type":"tool_execution_start","toolCallId":"c1","toolName":"bash","args":{"command":"ls"}}'
printf '%s\n' '{"type":"tool_execution_end","toolCallId":"c1","toolName":"bash","result":"a.txt","isError":false}'
printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"hi "}}'
printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"pi"}}'
printf '%s\n' '{"type":"agent_end","usage":{"input":1,"output":2}}'

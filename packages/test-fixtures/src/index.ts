export const SAMPLE_CODEX_SESSION = `{"timestamp":"2026-03-28T20:00:00.000Z","type":"session_meta","payload":{"id":"session-123","cwd":"C:\\\\repo","source":"vscode"}}
{"timestamp":"2026-03-28T20:00:01.000Z","type":"event_msg","payload":{"type":"user_message","message":"Plan the work and then implement a helper."}}
{"timestamp":"2026-03-28T20:00:02.000Z","type":"event_msg","payload":{"type":"agent_message","message":"1. Add the helper\\n2. Add tests\\n3. Summarize the result"}}
{"timestamp":"2026-03-28T20:00:03.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"pnpm test\\"}"}}
{"timestamp":"2026-03-28T20:00:04.000Z","type":"response_item","payload":{"type":"function_call_output","output":"Process exited with code 0"}}
{"timestamp":"2026-03-28T20:00:05.000Z","type":"event_msg","payload":{"type":"user_message","message":"Now explain the helper."}}
{"timestamp":"2026-03-28T20:00:06.000Z","type":"event_msg","payload":{"type":"agent_message","message":"The helper normalizes the input and returns a stable value."}}`;

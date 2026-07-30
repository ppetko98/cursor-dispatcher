#!/usr/bin/env node
// Fake cursor-agent used in unit tests. Emits NDJSON stream-json events.
const args = process.argv.slice(2);
const promptIndex = args.length - 1;
const prompt = args[promptIndex] ?? "";
const slow = /slow/i.test(prompt);

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  emit({ type: "start", chat_id: "chat-xyz", argv: args, ts: Date.now() });
  if (slow) {
    // Wait long enough for the test to cancel us.
    await sleep(5000);
  } else {
    emit({ type: "assistant", message: { content: [{ type: "text", text: "hello world" }] } });
    emit({ type: "end" });
  }
}

main().catch((err) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});

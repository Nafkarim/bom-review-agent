import { describe, expect, it } from "vitest";
import { dedupeWorkersAiStream } from "../src/ai-stream-fix";

const enc = new TextEncoder();

function streamOf(parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(enc.encode(p));
      c.close();
    }
  });
}

async function events(stream: ReadableStream<Uint8Array>) {
  const text = await new Response(stream).text();
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)));
}

// The text a consumer emits per chunk, the way workers-ai-provider reads it:
// both `response` and `choices[0].delta.content`.
const emitted = (e: {
  response?: string;
  choices?: { delta?: { content?: string } }[];
}) => (e.response ?? "") + (e.choices?.[0]?.delta?.content ?? "");

describe("dedupeWorkersAiStream", () => {
  it("drops delta.content when it repeats response in the same chunk", async () => {
    const out = await events(
      dedupeWorkersAiStream(
        streamOf([
          'data: {"response":"There","choices":[{"delta":{"content":"There"}}]}\n\n',
          'data: {"response":" are 5","choices":[{"delta":{"content":" are 5"}}]}\n\n',
          "data: [DONE]\n\n"
        ])
      )
    );
    expect(out.map(emitted).join("")).toBe("There are 5");
  });

  it("handles events split across network chunks", async () => {
    const out = await events(
      dedupeWorkersAiStream(
        streamOf([
          'data: {"response":"Hel',
          'lo","choices":[{"delta":{"content":"Hello"}}]}\n',
          "\n"
        ])
      )
    );
    expect(out.map(emitted).join("")).toBe("Hello");
  });

  it("leaves chunks with only one text field, tool calls and usage untouched", async () => {
    const lines = [
      'data: {"choices":[{"delta":{"content":"only delta"}}]}',
      'data: {"response":"only response"}',
      'data: {"response":"","choices":[{"delta":{"tool_calls":[{"index":0}]}}]}',
      'data: {"usage":{"prompt_tokens":10}}'
    ];
    const out = await events(
      dedupeWorkersAiStream(streamOf([lines.join("\n\n") + "\n\n"]))
    );
    expect(out).toEqual(lines.map((l) => JSON.parse(l.slice(6))));
  });
});

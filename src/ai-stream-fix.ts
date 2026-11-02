// Workaround for doubled streaming text from Workers AI.
//
// Workers AI streams each SSE event with the same text in both `response` and
// `choices[0].delta.content`. workers-ai-provider (3.3.1 and 4.0.1) emits a
// text delta for each field, so every streamed word appears twice. Non-streaming
// calls are unaffected. This rewrites the stream so a duplicated delta.content is
// removed before the provider sees it.

type SseEvent = {
  response?: unknown;
  choices?: { delta?: { content?: unknown } }[];
};

function fixLine(line: string): string {
  if (!line.startsWith("data: ")) return line;
  const data = line.slice(6).trim();
  if (data === "" || data === "[DONE]") return line;
  let event: SseEvent;
  try {
    event = JSON.parse(data);
  } catch {
    return line;
  }
  const delta = event.choices?.[0]?.delta;
  if (
    delta &&
    typeof event.response === "string" &&
    event.response !== "" &&
    delta.content === event.response
  ) {
    delete delta.content;
    return `data: ${JSON.stringify(event)}`;
  }
  return line;
}

export function dedupeWorkersAiStream(
  stream: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          controller.enqueue(encoder.encode(`${fixLine(line)}\n`));
        }
      },
      flush(controller) {
        pending += decoder.decode();
        if (pending) controller.enqueue(encoder.encode(fixLine(pending)));
      }
    })
  );
}

/** Wraps the AI binding so streamed results pass through dedupeWorkersAiStream. */
export function withDedupedStreams(ai: Ai): Ai {
  return new Proxy(ai, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (prop !== "run") return value.bind(target);
      return async (...args: unknown[]) => {
        const result = await value.apply(target, args);
        return result instanceof ReadableStream
          ? dedupeWorkersAiStream(result)
          : result;
      };
    }
  });
}

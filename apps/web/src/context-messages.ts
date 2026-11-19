export type ContextMessage = {
  key: string;
  role: "user" | "assistant";
  text: string;
};

export function visibleMessages(value: unknown): ContextMessage[] {
  if (!value || typeof value !== "object") return [];
  const runtime = value;
  if (
    !runtime ||
    typeof runtime !== "object" ||
    !Array.isArray((runtime as { messages?: unknown }).messages)
  )
    return [];
  const out: ContextMessage[] = [];
  for (const [position, raw] of (
    runtime as { messages: unknown[] }
  ).messages.entries()) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as {
      role?: unknown;
      content?: unknown;
      timestamp?: unknown;
    };
    if (item.role !== "assistant" && item.role !== "user") continue;
    const parts = Array.isArray(item.content) ? item.content : [];
    const text =
      typeof item.content === "string" && item.role === "user"
        ? item.content
        : parts
            .filter(
              (part): part is { type: "text"; text: string } =>
                !!part &&
                typeof part === "object" &&
                (part as { type?: unknown }).type === "text" &&
                typeof (part as { text?: unknown }).text === "string",
            )
            .map((part) => part.text)
            .join("");
    // Canonical model context has no entry IDs; position disambiguates repeated messages.
    if (text)
      out.push({
        key: `${item.role}:${typeof item.timestamp === "number" ? item.timestamp : "context"}:${position}`,
        role: item.role,
        text,
      });
  }
  return out;
}

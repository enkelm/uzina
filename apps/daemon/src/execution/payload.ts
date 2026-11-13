import { createHash } from "node:crypto";

export function executionPayloadSha256(value: unknown): string {
  function stableJson(item: unknown): string {
    if (Array.isArray(item)) return `[${item.map(stableJson).join(",")}]`;
    if (item !== null && typeof item === "object") {
      const record = item as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
        .join(",")}}`;
    }
    return JSON.stringify(item);
  }
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

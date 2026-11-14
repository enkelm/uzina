export function assertLoopbackHostname(hostname: string): void {
  if (!new Set(["127.0.0.1", "::1", "localhost"]).has(hostname.toLowerCase())) {
    throw new Error("Uzina daemon must bind to a loopback hostname");
  }
}

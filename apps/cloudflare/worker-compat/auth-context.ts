/** Pi AI 1.4.0 host discovery is unavailable in Workers; credentials are injected explicitly. */
export function defaultProviderAuthContext() {
  return {
    async env(_name: string) {
      return undefined;
    },
    async fileExists(_path: string) {
      return false;
    },
  };
}

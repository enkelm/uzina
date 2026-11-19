/** OS-user liveness observation, not process identity or a security attestation. Node/Bun compatible. */
export function localProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

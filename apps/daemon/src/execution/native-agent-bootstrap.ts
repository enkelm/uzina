import {
  constants,
  closeSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { ExecutionError } from "./errors";

export function privateNativeDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new ExecutionError("native_agent_state_not_private");
  return realpathSync(path);
}

export function readNativeBootstrapFile(path: string): string {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 65_536
    )
      throw new ExecutionError("native_agent_bootstrap_not_private");
    const buffer = Buffer.alloc(65_537);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!count) break;
      bytes += count;
    }
    if (bytes > 65_536)
      throw new ExecutionError("native_agent_bootstrap_limit");
    return buffer.subarray(0, bytes).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Private immutable artifacts. Never repair/overwrite a conflicting existing file. */
export function writeNativeBootstrapFile(path: string, text: string): void {
  if (Buffer.byteLength(text) > 65_536)
    throw new ExecutionError("native_agent_bootstrap_limit");
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (readNativeBootstrapFile(path) !== text)
      throw new ExecutionError("native_agent_bootstrap_conflict");
    return;
  }
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

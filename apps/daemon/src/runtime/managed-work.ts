import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ManagedPiWorkOptions } from "@uzina/pi-runtime";
import { ManagedPiWork } from "@uzina/pi-runtime";
import { openBunSqliteStorage } from "./sqlite";

export async function openLocalManagedPiWork(
  path: string,
  options: Omit<ManagedPiWorkOptions, "storage">,
  context: Context = BACKGROUND_CONTEXT,
): Promise<ManagedPiWork> {
  const storage = await openBunSqliteStorage(path);
  try {
    return await ManagedPiWork.open({ ...options, storage }, context);
  } catch (error) {
    await storage.close(context).catch(() => {});
    throw error;
  }
}

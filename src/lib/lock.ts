import { paths } from "./paths";
import { LockAcquisitionError } from "./errors";
import { unlink } from "node:fs/promises";

export async function acquirePublishLock(): Promise<() => Promise<void>> {
  const lockPath = paths.publishLock;
  const file = Bun.file(lockPath);

  if (await file.exists()) {
    const content = await file.text();
    const holderPid = parseInt(content.trim(), 10);
    if (!isNaN(holderPid) && isProcessAlive(holderPid)) {
      throw new LockAcquisitionError(
        `Another pkgl pub is running (PID ${holderPid})`
      );
    }
  }

  await Bun.write(lockPath, String(process.pid));

  return async () => {
    await unlink(lockPath).catch(() => {});
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

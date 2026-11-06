import { lstat, realpath, stat, open, type FileHandle } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { config } from "../config.js";

export function fsToolsEnabled(): boolean {
  return config.fsRoots.length > 0;
}

async function canonicalRoots(): Promise<string[]> {
  const roots: string[] = [];
  for (const root of config.fsRoots) {
    const st = await lstat(root).catch(() => {
      throw new Error("Configured filesystem root does not exist");
    });
    if (!st.isDirectory()) throw new Error("Configured filesystem root is not a directory");
    roots.push(await realpath(root));
  }
  return roots;
}

function inside(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export async function readFromAllowedPath(filePath: string): Promise<Uint8Array<ArrayBuffer>> {
  if (!path.isAbsolute(filePath)) throw new Error("file_path must be an absolute path");
  const roots = await canonicalRoots();
  const st = await lstat(filePath).catch(() => {
    throw new Error("file_path does not exist");
  });
  if (st.isSymbolicLink()) throw new Error("file_path is a symlink; refusing to follow it");
  const real = await realpath(filePath);
  if (!roots.some((r) => inside(real, r)))
    throw new Error("file_path is outside the configured filesystem roots");
  // O_NOFOLLOW rejects a final-component symlink swapped in after the realpath
  // check; intermediate-directory races remain possible on a hostile local
  // filesystem and are documented as out of scope.
  const handle = await open(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch((e) => {
    if ((e as NodeJS.ErrnoException).code === "ELOOP")
      throw new Error("file_path is a symlink; refusing to follow it");
    throw e;
  });
  try {
    // fstat the open handle: the size limit applies to the file actually read,
    // not a stat taken before the read.
    const st = await handle.stat();
    if (!st.isFile()) throw new Error("file_path is not a regular file");
    const max = config.fsMaxReadBytes;
    if (st.size > max)
      throw new Error(
        `file_path is larger than the configured read limit (${st.size} > ${max} bytes)`,
      );
    // Read at most max+1 bytes so a file that grows during the read is still
    // caught; a short read simply ends the loop.
    const chunks: Buffer[] = [];
    let total = 0;
    let position = 0;
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(
        buf,
        0,
        Math.min(buf.length, max + 1 - total),
        position,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > max)
        throw new Error(
          `file_path exceeds the configured read limit while being read (grew past ${max} bytes)`,
        );
      chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
      position += bytesRead;
    }
    const out = Buffer.concat(chunks);
    const result = new Uint8Array(out.byteLength);
    result.set(out);
    return result;
  } finally {
    await handle.close();
  }
}

export async function openExclusiveWrite(outputPath: string): Promise<FileHandle> {
  if (!path.isAbsolute(outputPath)) throw new Error("output_path must be an absolute path");
  const roots = await canonicalRoots();
  const parent = path.dirname(outputPath);
  const parentReal = await realpath(parent).catch((e) => {
    throw new Error("output_path's directory does not exist", { cause: e });
  });
  if (!roots.some((r) => inside(parentReal, r)))
    throw new Error("output_path is outside the configured filesystem roots");
  const pst = await stat(parentReal);
  if (!pst.isDirectory()) throw new Error("output_path's parent is not a directory");
  const target = path.join(parentReal, path.basename(outputPath));
  try {
    return await open(target, "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("output_path already exists; exclusive writes refuse to overwrite", {
        cause: e,
      });
    throw e;
  }
}

export async function writeToAllowedPath(outputPath: string, data: Buffer | Uint8Array) {
  const handle = await openExclusiveWrite(outputPath);
  try {
    // handle.write may write fewer bytes than requested; loop until all data
    // is flushed so a silent partial write can never be reported as success.
    let offset = 0;
    const view = Buffer.isBuffer(data) ? data : Buffer.from(data);
    while (offset < view.byteLength) {
      const { bytesWritten } = await handle.write(view, offset, view.byteLength - offset);
      if (bytesWritten <= 0) throw new Error("write made no progress");
      offset += bytesWritten;
    }
  } finally {
    await handle.close();
  }
}

import { describe, it, expect, vi } from "vitest";
import { mkdir, symlink, writeFile, rm, readFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = mkdtempSync(join(tmpdir(), "fs-guard-"));
vi.stubEnv("PAPERLESS_URL", "https://p.example.com");
vi.stubEnv("PAPERLESS_TOKEN", "admin-tok");
vi.stubEnv("PAPERLESS_FS_ROOTS", join(base, "roots"));
vi.stubEnv("PAPERLESS_FS_MAX_READ_BYTES", "1000");

const { readFromAllowedPath, openExclusiveWrite, writeToAllowedPath, fsToolsEnabled } =
  await import("../security/fs.js");

const roots = join(base, "roots");
const outside = join(base, "outside");

describe("fsToolsEnabled", () => {
  it("is true when roots are configured", () => {
    expect(fsToolsEnabled()).toBe(true);
  });
});

describe("readFromAllowedPath", () => {
  it("rejects relative paths", async () => {
    await expect(readFromAllowedPath("relative/file.txt")).rejects.toThrow("absolute");
  });

  it("reads a regular file inside a root", async () => {
    await mkdir(roots, { recursive: true });
    const p = join(roots, "doc.txt");
    await writeFile(p, "hello");
    expect(Buffer.from(await readFromAllowedPath(p)).toString()).toBe("hello");
  });

  it("reads files in subdirectories of a root", async () => {
    const sub = join(roots, "sub");
    await mkdir(sub, { recursive: true });
    const p = join(sub, "doc.txt");
    await writeFile(p, "hi");
    expect(Buffer.from(await readFromAllowedPath(p)).toString()).toBe("hi");
  });

  it("rejects paths outside the roots", async () => {
    await mkdir(outside, { recursive: true });
    const p = join(outside, "secret.txt");
    await writeFile(p, "no");
    await expect(readFromAllowedPath(p)).rejects.toThrow("outside");
  });

  it("rejects symlink escapes even when the link lives inside a root", async () => {
    const link = join(roots, "escape.txt");
    await rm(link, { force: true });
    await symlink(join(outside, "secret.txt"), link);
    await expect(readFromAllowedPath(link)).rejects.toThrow(/symlink|outside/);
  });

  it("rejects non-regular files such as directories", async () => {
    await expect(readFromAllowedPath(roots)).rejects.toThrow("regular file");
  });

  it("enforces the configured read size limit", async () => {
    const p = join(roots, "big.txt");
    await writeFile(p, "x".repeat(1500));
    await expect(readFromAllowedPath(p)).rejects.toThrow("read limit");
  });
});

describe("openExclusiveWrite / writeToAllowedPath", () => {
  it("writes inside a root and refuses to overwrite existing files", async () => {
    const p = join(roots, "out.zip");
    await writeToAllowedPath(p, Buffer.from("one"));
    expect(await readFile(p, "utf8")).toBe("one");
    await expect(openExclusiveWrite(p)).rejects.toThrow("already exists");
  });

  it("refuses to write through a pre-existing symlink at the target path", async () => {
    const link = join(roots, "link-out.bin");
    await rm(link, { force: true });
    await symlink(join(outside, "victim.txt"), link);
    await expect(openExclusiveWrite(link)).rejects.toThrow();
  });

  it("refuses paths outside the roots", async () => {
    await expect(writeToAllowedPath(join(outside, "out.zip"), Buffer.from("x"))).rejects.toThrow(
      "outside",
    );
  });

  it("refuses to write into a directory that does not exist", async () => {
    await expect(
      writeToAllowedPath(join(roots, "missing-dir", "out.zip"), Buffer.from("x")),
    ).rejects.toThrow("does not exist");
  });

  it("does not follow a symlinked directory component that escapes the roots", async () => {
    const linkDir = join(roots, "linked");
    await rm(linkDir, { force: true, recursive: true });
    await symlink(outside, linkDir);
    await expect(openExclusiveWrite(join(linkDir, "out.zip"))).rejects.toThrow(/outside|already/);
  });

  it("writes large multi-chunk payloads completely", async () => {
    const p = join(roots, "big-out.bin");
    const data = Buffer.from(Array.from({ length: 2 * 1024 * 1024 + 17 }, (_, i) => i % 251));
    await writeToAllowedPath(p, data);
    const back = await readFile(p);
    expect(back.byteLength).toBe(data.byteLength);
    expect(back.equals(data)).toBe(true);
  });

  it("reads a file exactly at the read limit and refuses one byte more", async () => {
    const okPath = join(roots, "exact.bin");
    await writeFile(okPath, Buffer.alloc(1000, 7));
    const read = await readFromAllowedPath(okPath);
    expect(read.byteLength).toBe(1000);
    const overPath = join(roots, "over.bin");
    await writeFile(overPath, Buffer.alloc(1001, 7));
    await expect(readFromAllowedPath(overPath)).rejects.toThrow("read limit");
  });

  it("rejects a symlink swapped in as the final path component", async () => {
    const target = join(roots, "real.txt");
    await writeFile(target, "real");
    const linkPath = join(roots, "swap.txt");
    await rm(linkPath, { force: true });
    await symlink(join(outside, "secret.txt"), linkPath);
    await expect(readFromAllowedPath(linkPath)).rejects.toThrow(/symlink|outside/);
  });
});

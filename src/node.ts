/**
 * Node-only entry — the ONLY module in the library that touches node:fs.
 * Published as the "./node" subpath so the core stays runtime-agnostic.
 */
import { readdir, readFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';

import type { SkillSource } from './source.js';

/**
 * Disk-backed source rooted at `root`. Paths are reported relative POSIX.
 * `read()` only accepts paths that resolve inside the root — absolute paths
 * and `../` escapes are rejected (F24).
 * Only regular files are listed — symlinks are skipped deliberately: symlink
 * policy belongs to the consumer's unpack/validation stage, not this library
 * (design decision D-A5).
 */
export function fromDir(root: string): SkillSource {
  const absRoot = resolve(root);
  return {
    dir: basename(absRoot),
    async list(): Promise<string[]> {
      const out: string[] = [];
      const walk = async (rel: string): Promise<void> => {
        const entries = await readdir(rel === '' ? absRoot : join(absRoot, rel), {
          withFileTypes: true,
        });
        for (const entry of entries) {
          const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
          if (entry.isDirectory()) {
            await walk(childRel);
          } else if (entry.isFile()) {
            out.push(childRel);
          }
        }
      };
      await walk('');
      return out;
    },
    async read(path: string): Promise<Uint8Array> {
      // Contract: `path` is a root-relative path as produced by list(). Resolve
      // and verify the result stays inside the root — this rejects absolute
      // paths and `../` escapes (F24). SkillSource IO is the library's one
      // allowed rejection (R3), so throwing here is the right mechanism.
      const abs = resolve(absRoot, path);
      if (!abs.startsWith(absRoot + sep)) {
        throw new Error(`fromDir: path escapes the skill root: ${path}`);
      }
      const buf = await readFile(abs);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
  };
}

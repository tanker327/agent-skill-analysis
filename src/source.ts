/**
 * SkillSource — the input abstraction. The core pipeline only ever sees this
 * interface, so it stays runtime-agnostic (Node/Bun/Deno/browser/edge).
 *
 * IO is the single declared throw boundary of the library (R3): if list() or
 * read() rejects, the whole analyze() call rejects — a partial manifest would
 * poison the digest. Broken skill *content* never throws; it becomes
 * diagnostics.
 */

export interface SkillSource {
  /**
   * All file paths in the skill tree, relative POSIX (e.g. "scripts/run.py").
   * Order is NOT significant — the pipeline sorts; a conformance meta-test
   * shuffles list() output and asserts identical analysis.
   */
  list(): Promise<string[]>;
  /** Raw bytes of one file. Rejecting aborts the whole analyze() (R3). */
  read(path: string): Promise<Uint8Array>;
  /**
   * Skill root directory name (e.g. "research-assistant"). Memory sources
   * usually have none → output `dir` is null and the name-dir-mismatch
   * check is skipped.
   */
  readonly dir?: string;
}

/**
 * In-memory source — the preferred way to drive analyze() in tests and when
 * unpacking archives. String values are UTF-8 encoded.
 */
export function fromFiles(
  files: ReadonlyMap<string, string | Uint8Array> | Readonly<Record<string, string | Uint8Array>>,
  options?: { dir?: string },
): SkillSource {
  const entries: ReadonlyArray<readonly [string, string | Uint8Array]> =
    files instanceof Map ? [...files.entries()] : Object.entries(files);
  const encoder = new TextEncoder();
  const map = new Map<string, Uint8Array>();
  for (const [path, content] of entries) {
    map.set(path, typeof content === 'string' ? encoder.encode(content) : content);
  }
  const source: SkillSource = {
    list: () => Promise.resolve([...map.keys()]),
    read: (path: string) => {
      const bytes = map.get(path);
      return bytes !== undefined
        ? Promise.resolve(bytes)
        : Promise.reject(new Error(`fromFiles: no such file: ${path}`));
    },
  };
  if (options?.dir !== undefined) {
    return { ...source, dir: options.dir };
  }
  return source;
}

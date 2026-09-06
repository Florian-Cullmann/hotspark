import {
  mkdir,
  readdir,
  lstat,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { command, type CommandRunner, type CommandOptions } from "./process.js";
import { type WebServiceSpec } from "../../../packages/application-spec/src/index.js";
export type GitSource = Extract<WebServiceSpec["source"], { type: "git" }>;
export type SourceFetcher = (
  source: GitSource,
  directory: string,
  options: CommandOptions,
) => Promise<string>;
export async function validateContext(directory: string) {
  let bytes = 0,
    count = 0;
  async function walk(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (
        entry.name === ".git" ||
        entry.name === "node_modules" ||
        entry.name === ".env" ||
        entry.name.startsWith(".env.")
      ) {
        await rm(join(path, entry.name), { recursive: true, force: true });
        continue;
      }
      if (++count > 100000) throw new Error("Source exceeds 100,000 files");
      const file = join(path, entry.name),
        info = await lstat(file);
      bytes += info.size;
      if (bytes > 256 * 1024 * 1024)
        throw new Error("Build context exceeds 256 MiB");
      if (info.isSymbolicLink()) {
        const target = await realpath(file);
        if (!target.startsWith(resolve(directory) + sep))
          throw new Error("Source symlink escapes workspace");
      } else if (info.isDirectory()) await walk(file);
      else if (!info.isFile()) throw new Error("Unsupported source file");
    }
  }
  await walk(directory);
  return { bytes, files: count };
}
export function gitFetcher(run: CommandRunner = command): SourceFetcher {
  return async (source, directory, options) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const git = (args: string[]) =>
      run(
        "/usr/bin/git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "protocol.file.allow=never",
          "-C",
          directory,
          ...args,
        ],
        { ...options, timeout: 180000, workspace: directory },
      );
    await git(["init", "--quiet"]);
    const ref =
      source.commit ??
      (source.tag ? `refs/tags/${source.tag}` : `refs/heads/${source.branch}`);
    await git(["fetch", "--depth=1", "--no-tags", source.repository, ref]);
    const commit = (await git(["rev-parse", "FETCH_HEAD^{commit}"])).trim();
    if (
      !/^[a-f0-9]{40}$/.test(commit) ||
      (source.commit && commit !== source.commit)
    )
      throw new Error("Source commit mismatch");
    await git(["checkout", "--detach", "--force", commit]);
    if ((await readdir(directory)).includes(".gitmodules"))
      throw new Error("Git submodules are not supported");
    await validateContext(directory);
    // Force the source context's mandatory exclusions, regardless of a repository Dockerfile.
    await writeFile(
      join(directory, ".dockerignore"),
      ".git\nnode_modules\n**/node_modules\n.env\n.env.*\n**/.env\n**/.env.*\n",
    );
    return commit;
  };
}

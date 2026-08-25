import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { promisify } from "node:util";
import { Clipboard, getSelectedFinderItems } from "@raycast/api";
import { normalizeProfileInput, type RemoteProfile } from "./profiles";

const execFileAsync = promisify(execFile);

export interface UploadSuccess {
  profile: RemoteProfile;
  remoteFilePath: string;
}

export interface UploadFailure {
  profile: RemoteProfile;
  error: Error;
}

export interface BatchUploadResult {
  successes: UploadSuccess[];
  failures: UploadFailure[];
}

export type UploadProgressCallback = (completed: number, total: number) => void;
export type ProfileUploader = (
  localFile: string,
  profile: RemoteProfile,
  remoteFilename: string,
) => Promise<UploadSuccess>;

/**
 * Conservative PATH used for every child process. Raycast launches as a macOS app and does
 * not inherit the user's interactive shell PATH, so we provide the standard locations
 * explicitly (Homebrew first so a modern rsync v3 is preferred over the system v2).
 */
const SAFE_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");

const BINARY_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
const COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const SSH_OPTIONS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
];

/**
 * Sanitize a file's basename to `[a-zA-Z0-9._-]`, preserving the original extension.
 * Other characters are replaced with `-` and collapsed; guards against an empty result.
 */
export function sanitizeFilename(name: string): string {
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;

  const cleanStem = stem
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  const cleanExt = ext.replace(/[^a-zA-Z0-9.]+/g, "");

  const safeStem = cleanStem.length > 0 ? cleanStem : "file";
  return `${safeStem}${cleanExt}`;
}

/** Two-digit, zero-padded helper for the timestamp. */
function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

/** Build one timestamped filename that can be reused across every target in an upload. */
export function buildRemoteFilename(originalName: string, now: Date = new Date(), id?: string): string {
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const suffix = id ?? randomBytes(3).toString("hex");
  return `${stamp}-${suffix}-${sanitizeFilename(basename(originalName))}`;
}

/** Combine an absolute remote directory with an already-generated filename. */
export function joinRemoteFilePath(remotePath: string, remoteFilename: string): string {
  return `${remotePath.replace(/\/+$/, "")}/${remoteFilename}`;
}

/** Build a complete remote destination path for a single target. */
export function buildRemoteFilePath(remotePath: string, originalName: string, now: Date = new Date()): string {
  return joinRemoteFilePath(remotePath, buildRemoteFilename(originalName, now));
}

/**
 * POSIX single-quote a string for safe inclusion in a remote shell command.
 * Wraps in single quotes and escapes embedded single quotes as '\''.
 * Kept available for any remote shell string; not needed for argv-based ssh invocation.
 */
export function posixSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Find an executable by name across the known binary directories. */
export function resolveBinary(name: string): string {
  for (const dir of BINARY_DIRS) {
    const candidate = `${dir}/${name}`;
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`"${name}" was not found on this machine. Install it and try again.`);
}

export interface CommandError extends Error {
  code?: string | number;
  stderr?: string;
  stdout?: string;
  killed?: boolean;
}

/**
 * Run a command with an explicit argv array (never a shell string) and a conservative PATH.
 * Resolves with stdout/stderr; rejects with a friendly, classified `Error` on failure.
 */
export async function runCommand(name: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const file = resolveBinary(name);
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      env: { ...process.env, PATH: SAFE_PATH },
      maxBuffer: 16 * 1024 * 1024,
      timeout: COMMAND_TIMEOUT_MS,
      killSignal: "SIGTERM",
    });
    return { stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (rawError) {
    const error = rawError as CommandError;
    if (error.code === "ENOENT") {
      throw new Error(`"${name}" was not found on this machine. Install it and try again.`);
    }
    throw new Error(classifyError(name, error));
  }
}

/** Map a failed command's stderr to a clear, actionable message (with raw stderr appended). */
export function classifyError(name: string, error: CommandError): string {
  const stderr = (error.stderr ?? "").trim();
  const haystack = `${stderr}\n${error.message ?? ""}`.toLowerCase();

  let message: string;
  if (error.killed) {
    message = `${name} timed out after 30 minutes.`;
  } else if (
    haystack.includes("publickey") ||
    haystack.includes("authentication failed") ||
    (haystack.includes("permission denied") && haystack.includes("password"))
  ) {
    message =
      "SSH authentication failed. Configure key-based SSH first, for example: ssh-copy-id user@host, or verify that ssh user@host works without a password.";
  } else if (
    haystack.includes("could not resolve hostname") ||
    haystack.includes("name or service not known") ||
    haystack.includes("no route to host") ||
    haystack.includes("connection refused") ||
    haystack.includes("operation timed out") ||
    haystack.includes("connection timed out") ||
    haystack.includes("network is unreachable") ||
    haystack.includes("host is down")
  ) {
    message = "Remote host unreachable. Check the host address and that the machine is online.";
  } else if (
    haystack.includes("permission denied") ||
    haystack.includes("read-only file system") ||
    haystack.includes("cannot create directory") ||
    haystack.includes("not a directory")
  ) {
    message = "Remote path permission denied. Check that the remote upload path is writable by your user.";
  } else {
    message = `${name} failed.`;
  }

  return stderr ? `${message}\n\n${stderr}` : message;
}

/**
 * Create the remote upload directory. Uses an argv array (no local shell). The remote path is
 * already validated as safe; ssh forwards the trailing args to the remote `mkdir`.
 */
export async function ensureRemoteDirectory(remote: string, remotePath: string): Promise<void> {
  await runCommand("ssh", [...SSH_OPTIONS, remote, "mkdir", "-p", "--", remotePath]);
}

/** Upload a local file with scp. */
export async function uploadWithScp(localFile: string, remote: string, remoteFilePath: string): Promise<void> {
  await runCommand("scp", [...SSH_OPTIONS, "--", localFile, `${remote}:${remoteFilePath}`]);
}

/** Upload a local file with rsync (BatchMode forced via -e so it never waits on a password). */
export async function uploadWithRsync(localFile: string, remote: string, remoteFilePath: string): Promise<void> {
  const remoteShell = `ssh ${SSH_OPTIONS.join(" ")}`;
  await runCommand("rsync", ["-az", "--progress", "-e", remoteShell, "--", localFile, `${remote}:${remoteFilePath}`]);
}

/** Create the directory and upload one file to one validated profile. */
export async function uploadToProfile(
  localFile: string,
  profile: RemoteProfile,
  remoteFilename: string,
): Promise<UploadSuccess> {
  const normalized = normalizeProfileInput(profile);
  const validatedProfile = { ...profile, ...normalized };
  const remoteFilePath = joinRemoteFilePath(validatedProfile.remotePath, remoteFilename);

  await ensureRemoteDirectory(validatedProfile.remote, validatedProfile.remotePath);
  if (validatedProfile.protocol === "scp") {
    await uploadWithScp(localFile, validatedProfile.remote, remoteFilePath);
  } else {
    await uploadWithRsync(localFile, validatedProfile.remote, remoteFilePath);
  }

  return { profile: validatedProfile, remoteFilePath };
}

/** Upload to all targets concurrently while preserving profile order in the result. */
export async function uploadToProfiles(
  localFile: string,
  profiles: RemoteProfile[],
  onProgress?: UploadProgressCallback,
  uploader: ProfileUploader = uploadToProfile,
): Promise<BatchUploadResult> {
  if (profiles.length === 0) {
    throw new Error("Select at least one remote machine.");
  }

  assertLocalFile(localFile);
  const remoteFilename = buildRemoteFilename(localFile);
  let completed = 0;
  const settled = await Promise.allSettled(
    profiles.map(async (profile) => {
      try {
        return await uploader(localFile, profile, remoteFilename);
      } finally {
        completed += 1;
        onProgress?.(completed, profiles.length);
      }
    }),
  );

  const successes: UploadSuccess[] = [];
  const failures: UploadFailure[] = [];
  settled.forEach((result, index) => {
    const profile = profiles[index];
    if (result.status === "fulfilled") {
      successes.push(result.value);
    } else {
      failures.push({ profile, error: toError(result.reason) });
    }
  });
  return { successes, failures };
}

/** Format upload output for the clipboard without losing machine identity on multi-target operations. */
export function formatUploadOutput(successes: UploadSuccess[], selectedTargetCount: number): string {
  if (successes.length === 0) {
    throw new Error("No successful uploads to copy.");
  }
  if (selectedTargetCount === 1) {
    return successes[0].remoteFilePath;
  }
  return JSON.stringify(
    Object.fromEntries(successes.map(({ profile, remoteFilePath }) => [profile.name, remoteFilePath])),
  );
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** Ensure the selected path exists and is a regular file (not a directory or missing). */
export function assertLocalFile(localFile: string | undefined): asserts localFile is string {
  if (!localFile) {
    throw new Error("No file selected. Choose a file to upload.");
  }
  if (!existsSync(localFile)) {
    throw new Error(`File does not exist: ${localFile}`);
  }
  const stats = statSync(localFile);
  if (stats.isDirectory()) {
    throw new Error("A directory was selected. Choose a single file instead.");
  }
  if (!stats.isFile()) {
    throw new Error(`Selected item is not a regular file: ${localFile}`);
  }
}

/** Copy the final remote absolute path to the clipboard. */
export async function copyResult(remoteFilePath: string): Promise<void> {
  await Clipboard.copy(remoteFilePath);
}

/** Normalize a clipboard file reference (which may be a `file://` URL) to a local path. */
export function parseClipboardFilePath(file: string): string {
  let path = file.trim();
  if (path.startsWith("file://")) {
    path = decodeURIComponent(path.slice("file://".length));
  }
  return path;
}

/**
 * If the clipboard currently holds a reference to an existing regular file, return its local
 * path so it can pre-fill the picker. Returns `undefined` (never throws) otherwise.
 */
export async function clipboardFileCandidate(): Promise<string | undefined> {
  try {
    const { file } = await Clipboard.read();
    if (!file) {
      return undefined;
    }
    const path = parseClipboardFilePath(file);
    if (existsSync(path) && statSync(path).isFile()) {
      return path;
    }
  } catch {
    // Ignore clipboard read errors; pre-fill is best-effort.
  }
  return undefined;
}

/**
 * First regular file in the current Finder selection. Returns `undefined` (never throws) when
 * Finder is not frontmost, nothing is selected, or only directories are selected.
 */
export async function finderFileCandidate(): Promise<string | undefined> {
  try {
    const items = await getSelectedFinderItems();
    return items.map((item) => item.path).find((path) => existsSync(path) && statSync(path).isFile());
  } catch {
    // Ignore Finder read errors; pre-fill is best-effort.
    return undefined;
  }
}

/**
 * Best-effort local file to stage in the picker when the command opens. The Finder selection is
 * the more deliberate signal, so it wins over a copied file reference.
 */
export async function localFileCandidate(): Promise<string | undefined> {
  return (await finderFileCandidate()) ?? (await clipboardFileCandidate());
}

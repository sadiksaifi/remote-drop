import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { promisify } from "node:util";
import { Clipboard, getPreferenceValues } from "@raycast/api";

const execFileAsync = promisify(execFile);

/** Protocols we support for the upload. */
export type Protocol = "scp" | "rsync";

export interface Preferences {
  remote: string;
  remotePath: string;
  protocol: Protocol;
}

/**
 * Conservative PATH used for every child process. Raycast launches as a macOS app and does
 * not inherit the user's interactive shell PATH, so we provide the standard locations
 * explicitly (Homebrew first so a modern rsync v3 is preferred over the system v2).
 */
const SAFE_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");

const BINARY_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

/** Read this command's typed preferences. */
export function getPreferences(): Preferences {
  return getPreferenceValues<Preferences>();
}

/**
 * Validate user-supplied preferences. Throws an `Error` with a user-facing message on the
 * first problem found. We reject unsafe remote paths outright rather than trying to support
 * every possible path.
 */
export function validatePreferences(prefs: Preferences): void {
  const remote = prefs.remote?.trim();
  if (!remote) {
    throw new Error("Remote is not configured. Set it to <user>@<host> in extension preferences.");
  }

  const remotePath = prefs.remotePath?.trim();
  if (!remotePath) {
    throw new Error("Remote Upload Path is not configured. Set an absolute path in extension preferences.");
  }
  if (!remotePath.startsWith("/")) {
    throw new Error(`Remote Upload Path must be absolute (start with "/"). Got: ${remotePath}`);
  }
  if (containsUnsafeChars(remotePath)) {
    throw new Error(
      "Remote Upload Path contains characters that are not allowed (quotes, ;, backticks, $(), newlines, or control characters).",
    );
  }

  if (prefs.protocol !== "scp" && prefs.protocol !== "rsync") {
    throw new Error(`Unknown protocol "${prefs.protocol}". Choose scp or rsync in extension preferences.`);
  }
}

/** Reject quotes, semicolons, backticks, $(), newlines, and any control character. */
function containsUnsafeChars(value: string): boolean {
  if (/["'`;]/.test(value) || value.includes("$(")) {
    return true;
  }
  // Reject control characters (0x00-0x1f and 0x7f) via char codes to avoid a control-char regex.
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

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

/**
 * Build the absolute remote destination path:
 *   <remotePath>/<YYYYMMDD-HHMMSS>-<6hex>-<sanitized-basename>
 * e.g. /tmp/ai-uploads/20260629-195500-a1b2c3-screenshot.png
 */
export function buildRemoteFilePath(remotePath: string, originalName: string, now: Date = new Date()): string {
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const id = randomBytes(3).toString("hex");
  const safeName = sanitizeFilename(basename(originalName));
  const base = remotePath.replace(/\/+$/, "");
  return `${base}/${stamp}-${id}-${safeName}`;
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

interface CommandError extends Error {
  code?: string | number;
  stderr?: string;
  stdout?: string;
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
function classifyError(name: string, error: CommandError): string {
  const stderr = (error.stderr ?? "").trim();
  const haystack = `${stderr}\n${error.message ?? ""}`.toLowerCase();

  let message: string;
  if (
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
  await runCommand("ssh", ["-o", "BatchMode=yes", remote, "mkdir", "-p", "--", remotePath]);
}

/** Upload a local file with scp. */
export async function uploadWithScp(localFile: string, remote: string, remoteFilePath: string): Promise<void> {
  await runCommand("scp", ["-o", "BatchMode=yes", "--", localFile, `${remote}:${remoteFilePath}`]);
}

/** Upload a local file with rsync (BatchMode forced via -e so it never waits on a password). */
export async function uploadWithRsync(localFile: string, remote: string, remoteFilePath: string): Promise<void> {
  await runCommand("rsync", [
    "-az",
    "--progress",
    "-e",
    "ssh -o BatchMode=yes",
    "--",
    localFile,
    `${remote}:${remoteFilePath}`,
  ]);
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

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { clipboardCopy, clipboardRead, getSelectedFinderItems } = vi.hoisted(() => ({
  clipboardCopy: vi.fn(),
  clipboardRead: vi.fn(),
  getSelectedFinderItems: vi.fn(),
}));
vi.mock("@raycast/api", () => ({
  Clipboard: {
    copy: clipboardCopy,
    read: clipboardRead,
  },
  getSelectedFinderItems,
}));

import type { RemoteProfile } from "./profiles";
import {
  buildRemoteFilePath,
  buildRemoteFilename,
  classifyError,
  copyResult,
  formatUploadOutput,
  joinRemoteFilePath,
  localFileCandidate,
  parseClipboardFilePath,
  sanitizeFilename,
  uploadToProfiles,
  type CommandError,
  type ProfileUploader,
  type UploadSuccess,
} from "./upload";

const profiles: RemoteProfile[] = [
  { id: "one", name: "Mac mini", remote: "mac-mini", remotePath: "/tmp/uploads", protocol: "rsync" },
  { id: "two", name: "GPU box", remote: "gpu-box", remotePath: "/srv/uploads", protocol: "scp" },
  { id: "three", name: "NAS", remote: "nas", remotePath: "/data/uploads", protocol: "rsync" },
];

let temporaryDirectory: string;
let localFile: string;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "remote-drop-test-"));
  localFile = join(temporaryDirectory, "My screenshot.png");
  await writeFile(localFile, "fixture");
});

afterAll(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("remote paths", () => {
  it("sanitizes filenames", () => {
    expect(sanitizeFilename("  my weird---image (1).png")).toBe("my-weird-image-1.png");
    expect(sanitizeFilename("💥.tar.gz")).toBe("tar.gz");
  });

  it("builds deterministic filenames and joins paths", () => {
    const now = new Date(2026, 7, 25, 19, 0, 49);
    const filename = buildRemoteFilename("My screenshot.png", now, "a1b2c3");
    expect(filename).toBe("20260825-190049-a1b2c3-My-screenshot.png");
    expect(joinRemoteFilePath("/tmp/uploads///", filename)).toBe(`/tmp/uploads/${filename}`);
  });

  it("keeps the existing one-step path builder", () => {
    const path = buildRemoteFilePath("/tmp/uploads", "test.png", new Date(2026, 0, 2, 3, 4, 5));
    expect(path).toMatch(/^\/tmp\/uploads\/20260102-030405-[a-f0-9]{6}-test\.png$/);
  });
});

describe("multi-target uploads", () => {
  it("runs targets concurrently, reuses one filename, and reports progress", async () => {
    const filenames: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const uploader: ProfileUploader = async (_file, profile, filename) => {
      filenames.push(filename);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { profile, remoteFilePath: joinRemoteFilePath(profile.remotePath, filename) };
    };
    const progress = vi.fn();

    const result = await uploadToProfiles(localFile, profiles, progress, uploader);

    expect(result.failures).toEqual([]);
    expect(result.successes.map(({ profile }) => profile.id)).toEqual(["one", "two", "three"]);
    expect(new Set(filenames).size).toBe(1);
    expect(maximumActive).toBeGreaterThan(1);
    expect(progress).toHaveBeenCalledTimes(3);
    expect(progress).toHaveBeenLastCalledWith(3, 3);
  });

  it("preserves successes and failures in profile order", async () => {
    const uploader: ProfileUploader = async (_file, profile, filename) => {
      if (profile.id === "two") {
        throw new Error("offline");
      }
      return { profile, remoteFilePath: joinRemoteFilePath(profile.remotePath, filename) };
    };

    const result = await uploadToProfiles(localFile, profiles, undefined, uploader);

    expect(result.successes.map(({ profile }) => profile.id)).toEqual(["one", "three"]);
    expect(result.failures).toEqual([{ profile: profiles[1], error: new Error("offline") }]);
  });

  it("reports a total failure without producing copyable output", async () => {
    const uploader: ProfileUploader = async () => {
      throw new Error("offline");
    };
    const result = await uploadToProfiles(localFile, profiles, undefined, uploader);

    expect(result.successes).toEqual([]);
    expect(result.failures).toHaveLength(3);
    expect(() => formatUploadOutput(result.successes, profiles.length)).toThrow("No successful uploads to copy.");
  });
});

describe("clipboard output", () => {
  const successes: UploadSuccess[] = [
    { profile: profiles[0], remoteFilePath: "/tmp/uploads/file.png" },
    { profile: profiles[1], remoteFilePath: "/srv/uploads/file.png" },
  ];

  it("uses a plain path for one selected target", () => {
    expect(formatUploadOutput(successes.slice(0, 1), 1)).toBe("/tmp/uploads/file.png");
  });

  it("uses a stable one-line JSON map for multi-target operations", () => {
    expect(formatUploadOutput(successes, 2)).toBe(
      '{"Mac mini":"/tmp/uploads/file.png","GPU box":"/srv/uploads/file.png"}',
    );
    expect(formatUploadOutput(successes.slice(0, 1), 2)).toBe('{"Mac mini":"/tmp/uploads/file.png"}');
  });

  it("copies the final output", async () => {
    await copyResult("/tmp/uploads/file.png");
    expect(clipboardCopy).toHaveBeenCalledWith("/tmp/uploads/file.png");
  });

  it("normalizes clipboard file URLs", () => {
    expect(parseClipboardFilePath("file:///tmp/My%20File.png")).toBe("/tmp/My File.png");
  });
});

describe("local file pre-fill", () => {
  it("prefers the first regular file in the Finder selection", async () => {
    getSelectedFinderItems.mockResolvedValue([{ path: temporaryDirectory }, { path: localFile }]);
    clipboardRead.mockResolvedValue({ file: "file:///does/not/exist.png" });

    await expect(localFileCandidate()).resolves.toBe(localFile);
  });

  it("falls back to a copied file when Finder has no usable selection", async () => {
    getSelectedFinderItems.mockRejectedValue(new Error("Finder is not the frontmost application"));
    clipboardRead.mockResolvedValue({ file: `file://${encodeURI(localFile)}` });

    await expect(localFileCandidate()).resolves.toBe(localFile);
  });

  it("resolves to undefined when neither source holds a file", async () => {
    getSelectedFinderItems.mockResolvedValue([{ path: temporaryDirectory }]);
    clipboardRead.mockResolvedValue({});

    await expect(localFileCandidate()).resolves.toBeUndefined();
  });
});

describe("command errors", () => {
  function commandError(stderr: string): CommandError {
    return Object.assign(new Error("command failed"), { stderr });
  }

  it("classifies authentication, network, and permission failures", () => {
    expect(classifyError("ssh", commandError("Permission denied (publickey)."))).toContain("SSH authentication failed");
    expect(classifyError("ssh", commandError("ssh: connect to host: Connection refused"))).toContain(
      "Remote host unreachable",
    );
    expect(classifyError("scp", commandError("Read-only file system"))).toContain("Remote path permission denied");
    expect(classifyError("rsync", Object.assign(commandError(""), { killed: true }))).toContain(
      "timed out after 30 minutes",
    );
  });
});

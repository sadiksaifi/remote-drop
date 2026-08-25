import { describe, expect, it, vi } from "vitest";

vi.mock("@raycast/api", () => ({
  LocalStorage: {
    getItem: vi.fn(),
    setItem: vi.fn(),
  },
}));

import {
  normalizeProfileInput,
  normalizeTargetScope,
  parseProfilesDocument,
  parseTargetScopeDocument,
  resolveTargetProfiles,
  serializeProfilesDocument,
  targetScopeFromProfileIds,
  validateProfileInput,
  type RemoteProfile,
} from "./profiles";

const profiles: RemoteProfile[] = [
  { id: "one", name: "Mac mini", remote: "sadik@mac-mini", remotePath: "/tmp/uploads", protocol: "rsync" },
  { id: "two", name: "GPU box", remote: "gpu-box", remotePath: "/srv/uploads", protocol: "scp" },
  { id: "three", name: "NAS", remote: "sadik@nas", remotePath: "/data/uploads", protocol: "rsync" },
];

describe("remote profiles", () => {
  it("round-trips a versioned profile document", () => {
    expect(parseProfilesDocument(serializeProfilesDocument(profiles))).toEqual(profiles);
  });

  it("rejects case-insensitive duplicate names", () => {
    expect(() =>
      validateProfileInput({ name: " mac MINI ", remote: "other", remotePath: "/tmp", protocol: "scp" }, profiles),
    ).toThrow('A remote profile named "mac MINI" already exists.');
  });

  it("normalizes values and rejects unsafe destinations", () => {
    expect(
      normalizeProfileInput({
        name: "  Server  ",
        remote: " user@server ",
        remotePath: "/tmp/files/ ",
        protocol: "rsync",
      }),
    ).toEqual({ name: "Server", remote: "user@server", remotePath: "/tmp/files/", protocol: "rsync" });

    expect(() =>
      normalizeProfileInput({ name: "Server", remote: "-oProxyCommand=bad", remotePath: "/tmp", protocol: "scp" }),
    ).toThrow('SSH Target cannot begin with "-".');
    for (const remotePath of ["/tmp;rm", "/tmp/x & touch", "/tmp/x|cat", "/tmp/$HOME", "/tmp/*.png"]) {
      expect(() =>
        normalizeProfileInput({ name: "Server", remote: "user@server", remotePath, protocol: "scp" }),
      ).toThrow("Remote Upload Path contains unsupported characters");
    }
  });

  it("rejects corrupt, duplicate-ID, and unsupported documents", () => {
    expect(() => parseProfilesDocument("not-json")).toThrow("corrupted");
    expect(() => parseProfilesDocument(JSON.stringify({ version: 2, profiles: [] }))).toThrow("unsupported");
    expect(() =>
      parseProfilesDocument(serializeProfilesDocument([profiles[0], { ...profiles[1], id: "one" }])),
    ).toThrow("duplicate ID");
  });
});

describe("target selection", () => {
  it("defaults to all and resolves all profiles", () => {
    const scope = normalizeTargetScope(undefined, profiles);
    expect(scope).toEqual({ mode: "all" });
    expect(resolveTargetProfiles(scope, profiles)).toEqual(profiles);
  });

  it("persists a single profile or subset in profile order", () => {
    expect(targetScopeFromProfileIds(["three"], profiles)).toEqual({ mode: "selected", profileIds: ["three"] });
    expect(targetScopeFromProfileIds(["three", "one"], profiles)).toEqual({
      mode: "selected",
      profileIds: ["one", "three"],
    });
  });

  it("normalizes a complete selection to all", () => {
    expect(targetScopeFromProfileIds(["three", "one", "two"], profiles)).toEqual({ mode: "all" });
  });

  it("prunes stale IDs and falls back to all when none remain", () => {
    expect(normalizeTargetScope({ mode: "selected", profileIds: ["missing", "two"] }, profiles)).toEqual({
      mode: "selected",
      profileIds: ["two"],
    });
    expect(normalizeTargetScope({ mode: "selected", profileIds: ["missing"] }, profiles)).toEqual({ mode: "all" });
  });

  it("recovers from a corrupt stored scope", () => {
    expect(parseTargetScopeDocument("not-json", profiles)).toEqual({ mode: "all" });
    expect(
      parseTargetScopeDocument(
        JSON.stringify({ version: 1, scope: { mode: "selected", profileIds: ["two"] } }),
        profiles,
      ),
    ).toEqual({
      mode: "selected",
      profileIds: ["two"],
    });
  });

  it("rejects an empty explicit selection", () => {
    expect(() => targetScopeFromProfileIds([], profiles)).toThrow("Select at least one remote machine.");
  });
});

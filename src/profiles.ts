import { randomUUID } from "node:crypto";
import { LocalStorage } from "@raycast/api";

export type Protocol = "scp" | "rsync";

export interface RemoteProfile {
  id: string;
  name: string;
  remote: string;
  remotePath: string;
  protocol: Protocol;
}

export interface RemoteProfileInput {
  name: string;
  remote: string;
  remotePath: string;
  protocol: Protocol;
}

export type TargetScope = { mode: "all" } | { mode: "selected"; profileIds: string[] };

interface ProfilesDocument {
  version: 1;
  profiles: RemoteProfile[];
}

interface TargetScopeDocument {
  version: 1;
  scope: TargetScope;
}

const PROFILES_STORAGE_KEY = "remote-profiles.v1";
const TARGET_SCOPE_STORAGE_KEY = "target-scope.v1";

/** Restrict remote paths because SSH transfer tools pass them through a remote shell. */
export function containsUnsafeRemotePathChars(value: string): boolean {
  return !/^\/[a-zA-Z0-9._/+,:@=%-]*$/.test(value);
}

/** Validate and normalize profile form values before persistence or upload. */
export function normalizeProfileInput(input: RemoteProfileInput): RemoteProfileInput {
  const name = input.name.trim();
  const remote = input.remote.trim();
  const remotePath = input.remotePath.trim();

  if (!name) {
    throw new Error("Profile Name is required.");
  }
  if (/\p{Cc}/u.test(name)) {
    throw new Error("Profile Name cannot contain control characters.");
  }

  if (!remote) {
    throw new Error("SSH Target is required.");
  }
  if (remote.startsWith("-")) {
    throw new Error('SSH Target cannot begin with "-".');
  }
  if (!/^(?:[a-zA-Z0-9._-]+@)?(?:[a-zA-Z0-9._-]+|\[[a-fA-F0-9:.%]+\])$/.test(remote)) {
    throw new Error("SSH Target must be a host, user@host, SSH alias, or bracketed IPv6 destination.");
  }

  if (!remotePath) {
    throw new Error("Remote Upload Path is required.");
  }
  if (!remotePath.startsWith("/")) {
    throw new Error(`Remote Upload Path must be absolute (start with "/"). Got: ${remotePath}`);
  }
  if (containsUnsafeRemotePathChars(remotePath)) {
    throw new Error(
      "Remote Upload Path contains unsupported characters. Use only letters, numbers, and / . _ - + , : @ = %.",
    );
  }

  if (input.protocol !== "scp" && input.protocol !== "rsync") {
    throw new Error(`Unknown protocol "${String(input.protocol)}". Choose scp or rsync.`);
  }

  return { name, remote, remotePath, protocol: input.protocol };
}

/** Validate a profile and enforce case-insensitive display-name uniqueness. */
export function validateProfileInput(
  input: RemoteProfileInput,
  profiles: RemoteProfile[],
  editingProfileId?: string,
): RemoteProfileInput {
  const normalized = normalizeProfileInput(input);
  const duplicate = profiles.some(
    (profile) =>
      profile.id !== editingProfileId &&
      profile.name.trim().toLocaleLowerCase() === normalized.name.toLocaleLowerCase(),
  );
  if (duplicate) {
    throw new Error(`A remote profile named "${normalized.name}" already exists.`);
  }
  return normalized;
}

/** Create a persisted profile with a stable ID. */
export function createRemoteProfile(input: RemoteProfileInput, profiles: RemoteProfile[]): RemoteProfile {
  return { id: randomUUID(), ...validateProfileInput(input, profiles) };
}

/** Parse and validate the versioned profile document stored by the extension. */
export function parseProfilesDocument(value: string | undefined): RemoteProfile[] {
  if (!value) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Saved remote profiles are corrupted. Open Manage Remotes to configure them again.");
  }

  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.profiles)) {
    throw new Error("Saved remote profiles use an unsupported format.");
  }

  const profiles: RemoteProfile[] = [];
  for (const candidate of parsed.profiles) {
    if (!isRemoteProfile(candidate)) {
      throw new Error("A saved remote profile is invalid. Open Manage Remotes and configure it again.");
    }
    if (profiles.some((profile) => profile.id === candidate.id)) {
      throw new Error("Saved remote profiles contain a duplicate ID.");
    }
    const normalized = validateProfileInput(candidate, profiles, candidate.id);
    profiles.push({ id: candidate.id, ...normalized });
  }
  return profiles;
}

/** Serialize profiles in a versioned format. */
export function serializeProfilesDocument(profiles: RemoteProfile[]): string {
  const document: ProfilesDocument = { version: 1, profiles };
  return JSON.stringify(document);
}

export async function loadProfiles(): Promise<RemoteProfile[]> {
  const value = await LocalStorage.getItem<string>(PROFILES_STORAGE_KEY);
  return parseProfilesDocument(value);
}

export async function saveProfiles(profiles: RemoteProfile[]): Promise<void> {
  // Validate the complete collection before replacing the stored document.
  const validated: RemoteProfile[] = [];
  for (const profile of profiles) {
    if (validated.some((candidate) => candidate.id === profile.id)) {
      throw new Error("Remote profiles must have unique IDs.");
    }
    const normalized = validateProfileInput(profile, validated, profile.id);
    validated.push({ id: profile.id, ...normalized });
  }
  await LocalStorage.setItem(PROFILES_STORAGE_KEY, serializeProfilesDocument(validated));
}

/** Normalize a stored scope against currently available profiles. */
export function normalizeTargetScope(scope: TargetScope | undefined, profiles: RemoteProfile[]): TargetScope {
  if (scope?.mode !== "selected" || profiles.length === 0) {
    return { mode: "all" };
  }

  const selected = new Set(scope.profileIds);
  const profileIds = profiles.filter((profile) => selected.has(profile.id)).map((profile) => profile.id);
  if (profileIds.length === 0 || profileIds.length === profiles.length) {
    return { mode: "all" };
  }
  return { mode: "selected", profileIds };
}

/** Convert a non-empty UI selection to its canonical persisted scope. */
export function targetScopeFromProfileIds(profileIds: string[], profiles: RemoteProfile[]): TargetScope {
  const selected = new Set(profileIds);
  const availableIds = profiles.filter((profile) => selected.has(profile.id)).map((profile) => profile.id);
  if (availableIds.length === 0) {
    throw new Error("Select at least one remote machine.");
  }
  if (availableIds.length === profiles.length) {
    return { mode: "all" };
  }
  return { mode: "selected", profileIds: availableIds };
}

export function resolveTargetProfiles(scope: TargetScope | undefined, profiles: RemoteProfile[]): RemoteProfile[] {
  const normalized = normalizeTargetScope(scope, profiles);
  if (normalized.mode === "all") {
    return profiles;
  }
  const selected = new Set(normalized.profileIds);
  return profiles.filter((profile) => selected.has(profile.id));
}

export function parseTargetScopeDocument(value: string | undefined, profiles: RemoteProfile[]): TargetScope {
  if (!value) {
    return { mode: "all" };
  }

  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || parsed.version !== 1 || !isTargetScope(parsed.scope)) {
      return { mode: "all" };
    }
    return normalizeTargetScope(parsed.scope, profiles);
  } catch {
    return { mode: "all" };
  }
}

export async function loadTargetScope(profiles: RemoteProfile[]): Promise<TargetScope> {
  const value = await LocalStorage.getItem<string>(TARGET_SCOPE_STORAGE_KEY);
  return parseTargetScopeDocument(value, profiles);
}

export async function saveTargetScope(scope: TargetScope, profiles: RemoteProfile[]): Promise<void> {
  const document: TargetScopeDocument = { version: 1, scope: normalizeTargetScope(scope, profiles) };
  await LocalStorage.setItem(TARGET_SCOPE_STORAGE_KEY, JSON.stringify(document));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRemoteProfile(value: unknown): value is RemoteProfile {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.name === "string" &&
    typeof value.remote === "string" &&
    typeof value.remotePath === "string" &&
    (value.protocol === "scp" || value.protocol === "rsync")
  );
}

function isTargetScope(value: unknown): value is TargetScope {
  if (!isRecord(value) || (value.mode !== "all" && value.mode !== "selected")) {
    return false;
  }
  return (
    value.mode === "all" || (Array.isArray(value.profileIds) && value.profileIds.every((id) => typeof id === "string"))
  );
}

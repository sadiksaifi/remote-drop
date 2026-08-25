import {
  Action,
  ActionPanel,
  Clipboard,
  closeMainWindow,
  Form,
  Icon,
  launchCommand,
  LaunchType,
  List,
  showToast,
  Toast,
} from "@raycast/api";
import { showFailureToast } from "@raycast/utils";
import { useEffect, useRef, useState } from "react";
import {
  loadProfiles,
  loadTargetScope,
  resolveTargetProfiles,
  saveTargetScope,
  targetScopeFromProfileIds,
  type RemoteProfile,
} from "./profiles";
import { assertLocalFile, copyResult, formatUploadOutput, localFileCandidate, uploadToProfiles } from "./upload";

interface UploadOptions {
  paste?: boolean;
}

export default function Command() {
  const [profiles, setProfiles] = useState<RemoteProfile[]>([]);
  const [selectedProfileIds, setSelectedProfileIds] = useState<string[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [loadError, setLoadError] = useState<Error>();
  const [fileError, setFileError] = useState<string>();
  const [machinesError, setMachinesError] = useState<string>();
  const selectionWriteQueue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    void (async () => {
      try {
        const loadedProfiles = await loadProfiles();
        const scope = await loadTargetScope(loadedProfiles);
        setProfiles(loadedProfiles);
        setSelectedProfileIds(resolveTargetProfiles(scope, loadedProfiles).map((profile) => profile.id));
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        setLoadError(normalized);
        await showFailureToast(normalized, { title: "Could not load remote machines" });
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  // Stage a likely file in the picker without ever opening a chooser. Runs on its own so a slow
  // Finder or clipboard read never delays the form, and never overwrites a real choice.
  useEffect(() => {
    void localFileCandidate().then((path) => {
      if (path) {
        setFiles((current) => (current.length > 0 ? current : [path]));
      }
    });
  }, []);

  function updateFiles(nextFiles: string[]): void {
    setFiles(nextFiles);
    if (nextFiles.length > 0) {
      setFileError(undefined);
    }
  }

  async function updateSelectedProfiles(profileIds: string[]): Promise<void> {
    if (isLoading) {
      return;
    }
    // An empty selection is a transient editing state, so it is shown but never persisted:
    // the last non-empty selection stays remembered for the next run.
    if (profileIds.length === 0) {
      setSelectedProfileIds([]);
      return;
    }

    try {
      const scope = targetScopeFromProfileIds(profileIds, profiles);
      setSelectedProfileIds(resolveTargetProfiles(scope, profiles).map((profile) => profile.id));
      setMachinesError(undefined);

      const write = selectionWriteQueue.current.then(() => saveTargetScope(scope, profiles));
      selectionWriteQueue.current = write.catch(() => undefined);
      await write;
    } catch (error) {
      await showFailureToast(error, { title: "Could not save machine selection" });
    }
  }

  async function handleUpload(options: UploadOptions = {}): Promise<void> {
    if (isUploading) {
      return;
    }

    const localFile = files[0];
    const selected = profiles.filter((profile) => selectedProfileIds.includes(profile.id));
    setFileError(localFile ? undefined : "Choose a file to upload.");
    setMachinesError(selected.length > 0 ? undefined : "Select at least one machine.");
    if (!localFile || selected.length === 0) {
      return;
    }

    setIsUploading(true);
    try {
      assertLocalFile(localFile);
      const toast = await showToast({
        style: Toast.Style.Animated,
        title: `Uploading to ${selected.length} ${selected.length === 1 ? "machine" : "machines"}…`,
        message: `0 of ${selected.length} completed`,
      });

      const result = await uploadToProfiles(localFile, selected, (completed, total) => {
        toast.message = `${completed} of ${total} completed`;
      });

      if (result.successes.length === 0) {
        toast.style = Toast.Style.Failure;
        toast.title = "Upload failed";
        toast.message = summarizeFailures(result.failures);
        return;
      }

      const output = formatUploadOutput(result.successes, selected.length);
      await copyResult(output);

      if (result.failures.length > 0) {
        toast.style = Toast.Style.Failure;
        toast.title = `${result.successes.length} of ${selected.length} uploads succeeded`;
        toast.message = `Copied successful paths · ${summarizeFailures(result.failures)}`;
        return;
      }

      toast.style = Toast.Style.Success;
      toast.title = selected.length === 1 ? "Uploaded" : `Uploaded to ${selected.length} machines`;
      toast.message = selected.length === 1 ? result.successes[0].remoteFilePath : "Copied remote path map";

      await closeMainWindow();
      if (options.paste) {
        await Clipboard.paste(output);
      }
    } catch (error) {
      await showFailureToast(error, { title: "Upload failed" });
    } finally {
      setIsUploading(false);
    }
  }

  if (loadError) {
    return (
      <List>
        <List.EmptyView
          icon={Icon.Warning}
          title="Could Not Load Remote Machines"
          description={loadError.message}
          actions={
            <ActionPanel>
              <Action title="Manage Remotes" icon={Icon.Gear} onAction={openManageRemotes} />
            </ActionPanel>
          }
        />
      </List>
    );
  }

  if (!isLoading && profiles.length === 0) {
    return (
      <List>
        <List.EmptyView
          icon={Icon.Network}
          title="No Remote Machines"
          description="Add a named SSH profile before uploading files."
          actions={
            <ActionPanel>
              <Action title="Add Remote" icon={Icon.Plus} onAction={openManageRemotes} />
            </ActionPanel>
          }
        />
      </List>
    );
  }

  const allSelected = profiles.length > 0 && selectedProfileIds.length === profiles.length;

  return (
    <Form
      isLoading={isLoading || isUploading}
      actions={
        <ActionPanel>
          <ActionPanel.Section>
            <Action.SubmitForm title="Upload & Copy Path" icon={Icon.Upload} onSubmit={() => handleUpload()} />
            <Action.SubmitForm
              title="Upload, Copy & Paste Path"
              icon={Icon.Clipboard}
              shortcut={{ modifiers: ["cmd", "shift"], key: "return" }}
              onSubmit={() => handleUpload({ paste: true })}
            />
          </ActionPanel.Section>
          <ActionPanel.Section>
            {allSelected ? null : (
              <Action
                title="Select All Machines"
                icon={Icon.CheckCircle}
                shortcut={{ modifiers: ["cmd", "shift"], key: "a" }}
                onAction={() => void updateSelectedProfiles(profiles.map((profile) => profile.id))}
              />
            )}
            <Action
              title="Manage Remotes"
              icon={Icon.Gear}
              shortcut={{ modifiers: ["cmd", "shift"], key: "m" }}
              onAction={openManageRemotes}
            />
          </ActionPanel.Section>
        </ActionPanel>
      }
    >
      <Form.FilePicker
        id="file"
        title="File"
        value={files}
        error={fileError}
        onChange={updateFiles}
        allowMultipleSelection={false}
        canChooseDirectories={false}
        info="The local file to upload. Pre-filled from the Finder selection or a copied file."
      />
      <Form.TagPicker
        id="machines"
        title="Machines"
        value={selectedProfileIds}
        error={machinesError}
        onChange={(profileIds) => void updateSelectedProfiles(profileIds)}
        info="One or more upload targets. The last selection is remembered."
      >
        {profiles.map((profile) => (
          <Form.TagPicker.Item key={profile.id} value={profile.id} title={profile.name} icon={Icon.Desktop} />
        ))}
      </Form.TagPicker>
    </Form>
  );
}

async function openManageRemotes(): Promise<void> {
  await launchCommand({ name: "manage-remotes", type: LaunchType.UserInitiated });
}

function summarizeFailures(failures: { profile: RemoteProfile; error: Error }[]): string {
  if (failures.length === 1) {
    return `${failures[0].profile.name}: ${failures[0].error.message}`;
  }
  return `Failed: ${failures.map(({ profile }) => profile.name).join(", ")}`;
}

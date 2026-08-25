import {
  Action,
  ActionPanel,
  Alert,
  confirmAlert,
  Form,
  Icon,
  Keyboard,
  List,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { showFailureToast } from "@raycast/utils";
import { useEffect, useState } from "react";
import {
  createRemoteProfile,
  loadProfiles,
  type Protocol,
  type RemoteProfile,
  saveProfiles,
  validateProfileInput,
} from "./profiles";

interface ProfileFormValues {
  name: string;
  remote: string;
  remotePath: string;
  protocol: Protocol;
}

interface ProfileFormProps {
  profiles: RemoteProfile[];
  profile?: RemoteProfile;
  duplicate?: boolean;
  onSave: (profiles: RemoteProfile[]) => void;
}

export default function Command() {
  const [profiles, setProfiles] = useState<RemoteProfile[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    void loadProfiles()
      .then(setProfiles)
      .catch((error) => showFailureToast(error, { title: "Could not load remote profiles" }))
      .finally(() => setIsLoading(false));
  }, []);

  async function deleteProfile(profile: RemoteProfile): Promise<void> {
    const confirmed = await confirmAlert({
      icon: Icon.Trash,
      title: `Delete ${profile.name}?`,
      message: "Uploads can no longer target this machine. This cannot be undone.",
      primaryAction: { title: "Delete Remote", style: Alert.ActionStyle.Destructive },
    });
    if (!confirmed) {
      return;
    }

    try {
      const nextProfiles = profiles.filter((candidate) => candidate.id !== profile.id);
      await saveProfiles(nextProfiles);
      setProfiles(nextProfiles);
      await showToast({ style: Toast.Style.Success, title: "Remote deleted", message: profile.name });
    } catch (error) {
      await showFailureToast(error, { title: "Could not delete remote" });
    }
  }

  const addProfileAction = (
    <Action.Push
      title="Add Remote"
      icon={Icon.Plus}
      shortcut={Keyboard.Shortcut.Common.New}
      target={<ProfileForm profiles={profiles} onSave={setProfiles} />}
    />
  );

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search remote machines…">
      {!isLoading && profiles.length === 0 ? (
        <List.EmptyView
          icon={Icon.Network}
          title="No Remote Machines"
          description="Add a named SSH profile before uploading files."
          actions={<ActionPanel>{addProfileAction}</ActionPanel>}
        />
      ) : null}

      {profiles.map((profile) => (
        <List.Item
          key={profile.id}
          id={profile.id}
          icon={Icon.Desktop}
          title={profile.name}
          subtitle={profile.remote}
          keywords={[profile.remote, profile.remotePath, profile.protocol]}
          accessories={[{ tag: profile.protocol }, { text: profile.remotePath }]}
          actions={
            <ActionPanel>
              <ActionPanel.Section>
                <Action.Push
                  title="Edit Remote"
                  icon={Icon.Pencil}
                  shortcut={Keyboard.Shortcut.Common.Edit}
                  target={<ProfileForm profiles={profiles} profile={profile} onSave={setProfiles} />}
                />
                {addProfileAction}
              </ActionPanel.Section>
              <ActionPanel.Section>
                <Action.Push
                  title="Duplicate Remote"
                  icon={Icon.Duplicate}
                  shortcut={{ modifiers: ["cmd"], key: "d" }}
                  target={<ProfileForm profiles={profiles} profile={profile} duplicate onSave={setProfiles} />}
                />
                <Action
                  title="Delete Remote"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  shortcut={{ modifiers: ["ctrl"], key: "x" }}
                  onAction={() => deleteProfile(profile)}
                />
              </ActionPanel.Section>
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}

function ProfileForm({ profiles, profile, duplicate = false, onSave }: ProfileFormProps) {
  const { pop } = useNavigation();
  const [isSaving, setIsSaving] = useState(false);
  const title = duplicate ? "Duplicate Remote" : profile ? "Edit Remote" : "Add Remote";
  const defaultName = duplicate && profile ? `${profile.name} Copy` : (profile?.name ?? "");

  async function handleSubmit(values: ProfileFormValues): Promise<void> {
    setIsSaving(true);
    try {
      let nextProfiles: RemoteProfile[];
      if (profile && !duplicate) {
        const normalized = validateProfileInput(values, profiles, profile.id);
        nextProfiles = profiles.map((candidate) =>
          candidate.id === profile.id ? { id: profile.id, ...normalized } : candidate,
        );
      } else {
        nextProfiles = [...profiles, createRemoteProfile(values, profiles)];
      }

      await saveProfiles(nextProfiles);
      onSave(nextProfiles);
      await showToast({
        style: Toast.Style.Success,
        title: profile && !duplicate ? "Remote updated" : "Remote added",
        message: values.name.trim(),
      });
      pop();
    } catch (error) {
      await showFailureToast(error, { title: `Could not ${profile && !duplicate ? "update" : "add"} remote` });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Form
      isLoading={isSaving}
      navigationTitle={title}
      actions={
        <ActionPanel>
          <Action.SubmitForm title={title} icon={Icon.CheckCircle} onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="name"
        title="Profile Name"
        placeholder="Mac mini"
        defaultValue={defaultName}
        info="A unique name used to identify this machine in selections and copied results."
      />
      <Form.TextField
        id="remote"
        title="SSH Target"
        placeholder="user@192.168.0.10"
        defaultValue={profile?.remote}
        info="An SSH destination such as user@host or a configured SSH alias."
      />
      <Form.TextField
        id="remotePath"
        title="Remote Upload Path"
        placeholder="/tmp/ai-uploads"
        defaultValue={profile?.remotePath}
        info="An absolute, writable directory on the remote machine."
      />
      <Form.Dropdown
        id="protocol"
        title="Upload Protocol"
        defaultValue={profile?.protocol ?? "rsync"}
        info="rsync is preferred when installed; scp ships with macOS."
      >
        <Form.Dropdown.Item title="rsync" value="rsync" />
        <Form.Dropdown.Item title="scp" value="scp" />
      </Form.Dropdown>
    </Form>
  );
}

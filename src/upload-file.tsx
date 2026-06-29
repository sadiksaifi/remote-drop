import { Action, ActionPanel, Clipboard, closeMainWindow, Form, Icon, showToast, Toast } from "@raycast/api";
import { showFailureToast } from "@raycast/utils";
import { useEffect, useState } from "react";
import {
  assertLocalFile,
  buildRemoteFilePath,
  clipboardFileCandidate,
  copyResult,
  ensureRemoteDirectory,
  getPreferences,
  uploadWithRsync,
  uploadWithScp,
  validatePreferences,
} from "./upload";

interface FormValues {
  file: string[];
}

interface UploadOptions {
  paste?: boolean;
}

export default function Command() {
  const prefs = getPreferences();
  const [files, setFiles] = useState<string[]>([]);

  const target = prefs.remote ? `${prefs.remote}:${prefs.remotePath}` : "Not configured";
  const destination = `${target}  ·  ${prefs.protocol}`;

  // Best-effort: if a file (e.g. a copied image) is already on the clipboard, pre-fill it.
  useEffect(() => {
    clipboardFileCandidate().then((path) => {
      if (path) {
        setFiles([path]);
      }
    });
  }, []);

  /** Validate, upload the selected file, copy the remote path, optionally paste it, and close. */
  async function handleUpload(values: FormValues, options: UploadOptions = {}): Promise<void> {
    try {
      validatePreferences(prefs);

      const localFile = values.file?.[0];
      assertLocalFile(localFile);

      const toast = await showToast({
        style: Toast.Style.Animated,
        title: "Uploading…",
        message: `${prefs.protocol} → ${prefs.remote}`,
      });

      await ensureRemoteDirectory(prefs.remote, prefs.remotePath);

      const remoteFilePath = buildRemoteFilePath(prefs.remotePath, localFile);
      if (prefs.protocol === "scp") {
        await uploadWithScp(localFile, prefs.remote, remoteFilePath);
      } else {
        await uploadWithRsync(localFile, prefs.remote, remoteFilePath);
      }

      await copyResult(remoteFilePath);

      toast.style = Toast.Style.Success;
      toast.title = "Uploaded";
      toast.message = remoteFilePath;

      await closeMainWindow();
      if (options.paste) {
        await Clipboard.paste(remoteFilePath);
      }
    } catch (error) {
      await showFailureToast(error, { title: "Upload failed" });
    }
  }

  return (
    <Form
      navigationTitle="Upload File to Remote"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Upload & Copy Path"
            icon={Icon.Upload}
            onSubmit={(values: FormValues) => handleUpload(values)}
          />
          <Action.SubmitForm
            title="Upload, Copy & Paste Path"
            icon={Icon.Clipboard}
            shortcut={{ modifiers: ["cmd", "shift"], key: "return" }}
            onSubmit={(values: FormValues) => handleUpload(values, { paste: true })}
          />
        </ActionPanel>
      }
    >
      <Form.Description title="Destination" text={destination} />
      <Form.Separator />
      <Form.FilePicker
        id="file"
        title="File"
        value={files}
        onChange={setFiles}
        info="Pick a file to upload. A file already on your clipboard is selected automatically."
        allowMultipleSelection={false}
        canChooseDirectories={false}
        canChooseFiles
      />
    </Form>
  );
}

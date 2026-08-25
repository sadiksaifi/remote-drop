# Remote Drop

Remote Drop is a Raycast extension for macOS that uploads one local file to one or more named remote machines over SSH using `rsync` or `scp`. It copies the resulting remote path, or a machine-to-path map, to the clipboard.

It is useful when files need to be shared with AI CLIs running in SSH or tmux sessions. Authentication relies entirely on existing key-based SSH configuration; the extension never handles passwords.

## Setup

Key-based SSH must already work. Remote Drop uses `BatchMode=yes`, so failed authentication exits instead of prompting for a password.

```bash
ssh user@host            # must connect without a password
ssh-copy-id user@host    # configure a key if needed
rsync --version          # optional, for profiles using rsync
```

`ssh` and `scp` ship with macOS. Remote Drop looks for executables in standard macOS, Homebrew, and system locations.

## Configure remote machines

Run **Manage Remotes** in Raycast, then add a named profile for each machine:

| Field                  | Example             | Description                                               |
| ---------------------- | ------------------- | --------------------------------------------------------- |
| **Profile Name**       | `Mac mini`          | Unique name shown in machine selection and copied output. |
| **SSH Target**         | `user@192.168.0.10` | SSH destination or configured SSH alias.                  |
| **Remote Upload Path** | `/tmp/ai-uploads`   | Absolute writable directory on that machine.              |
| **Upload Protocol**    | `rsync`             | `rsync` or `scp`, configured per profile.                 |

The previous single-machine extension preferences are not migrated. Configure the machine again as a named profile after upgrading.

## Upload a file

Run **Upload File to Remote**. The command opens a two-field form:

| Field        | Description                                                                |
| ------------ | -------------------------------------------------------------------------- |
| **File**     | The local file to upload. Click the field to choose or replace it.         |
| **Machines** | One or more upload targets. Click to add, or click a tag's × to remove it. |

The **File** field is pre-filled with the current Finder selection, falling back to a copied file reference. Nothing opens automatically, so the Raycast window stays put; clicking the field replaces the staged file in place.

All configured machines are selected on first launch. The extension remembers the last single machine or subset used.

- **⌘↩**: upload and copy the remote result.
- **⌘⇧↩**: upload, copy, and paste the result into the focused input.
- **⌘⇧A**: select every configured machine.
- **⌘⇧M**: open Manage Remotes.

Uploads to multiple machines run concurrently and reuse the same timestamped, sanitized filename. A single-machine upload copies a plain path:

```text
/tmp/ai-uploads/20260825-190049-a1b2c3-screenshot.png
```

A multi-machine upload copies a one-line JSON map:

```text
{"Mac mini":"/tmp/ai-uploads/20260825-190049-a1b2c3-screenshot.png","GPU box":"/srv/uploads/20260825-190049-a1b2c3-screenshot.png"}
```

If only some machines succeed, Remote Drop keeps those uploads, copies only their paths, reports the failed profile names, and does not auto-paste or close the form.

## Local development

```bash
pnpm install
pnpm dev
pnpm test
pnpm lint
pnpm build
```

`pnpm dev` registers the local extension in Raycast. Keep the project directory in place because Raycast loads the command from it.

## License

MIT

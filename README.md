# Remote Drop

A small Raycast extension for macOS that uploads a chosen local file to a preconfigured
remote machine over SSH (via `rsync` or `scp`) and copies the resulting remote path to the
clipboard. Handy for handing a file to an AI CLI (Claude Code, Codex) running in an SSH/tmux
session — upload, then paste the path.

It never handles passwords; authentication relies entirely on your existing key-based SSH.

## Setup

Key-based SSH must already work (the extension runs with `BatchMode=yes`, so it fails fast
instead of prompting):

```bash
ssh user@host            # must connect without a password
ssh-copy-id user@host    # set up a key if it doesn't
rsync --version          # optional, only for the rsync protocol
```

`ssh`/`scp` ship with macOS; `rsync` is found in `/opt/homebrew/bin` or `/usr/bin`.

## Preferences

| Preference            | Example              | Description                                   |
| --------------------- | -------------------- | --------------------------------------------- |
| **Remote**            | `user@192.168.0.10`  | SSH target as `<user>@<host>`.                |
| **Remote Upload Path**| `/tmp/ai-uploads`    | Absolute path on the remote (must start `/`). |
| **Upload Protocol**   | `rsync` (default)    | `rsync` or `scp`.                             |

## Usage

Run **Upload File to Remote**. If a file is already on your clipboard it is pre-filled;
otherwise pick one.

- **⌘↩** — upload and copy the remote path to the clipboard.
- **⌘⇧↩** — upload, copy, and paste the path into the focused input (may need Accessibility
  permission for Raycast the first time).

Files are uploaded with a timestamped, sanitized name, e.g.
`/tmp/ai-uploads/20260629-195500-a1b2c3-screenshot.png`.

## Local install

This is a personal/local extension (not on the Raycast Store):

```bash
pnpm install
pnpm dev      # registers it in Raycast (stays installed after you stop the server)
pnpm build    # clean production build
```

Keep the project folder in place — Raycast loads the command from it.

## License

MIT

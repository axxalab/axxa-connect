# Axxa Connect

Connect your Obsidian vault to **Cloudflare R2** (S3-compatible object storage)
and sync your notes as **plain files** — no encryption, no chunking — so they
stay readable by other tools and AIs.

Works on **desktop and mobile**: requests are signed with AWS SigV4 and sent
through Obsidian's `requestUrl`, so there are no CORS issues and your credentials
never leave the app.

## Features

- **Two-way sync** with Cloudflare R2 (or any S3-compatible endpoint) — one button
  sends and receives only what changed since the last sync, running transfers in
  parallel for speed
- **Move & delete propagation** — moving or deleting a file (or folder) on one
  device applies the same change on the other, so you never end up with duplicate
  copies. Deletes and renames are captured live (vault events → tombstones), so a
  deletion propagates on the very next sync instead of being restored, even
  without a prior baseline sync. Falls back to a three-way diff (local × remote ×
  last-sync state). Can be turned off in settings.
- Push the current note, or the whole vault, to R2
- Pull the whole vault from R2
- Optional **push on save** (debounced)
- **Automatic clock-skew correction** — if the machine's clock is off, the plugin
  reads the server time and retries, so SigV4 keeps working on desktop and mobile
- Plain `.md` files in the bucket — readable by scripts, backups and AI tools
- Optional inclusion of non-markdown attachments (images, PDFs, …)

## Why plain files?

Most S3 sync plugins offer end-to-end encryption, which scrambles file names and
contents in the bucket. That's great for privacy, but it makes the files
unreadable by anything except the plugin. Axxa Connect deliberately stores
**plain text**, so the same notes can be read by other automations and AI
assistants directly from the bucket.

> If you need encryption at rest, this plugin is not the right choice.

## Installation

### From this repository (manual)

1. Download `manifest.json`, `main.js` and `styles.css` from the latest
   [release](https://github.com/axxalab/axxa-connect/releases).
2. Copy them into your vault at
   `<vault>/.obsidian/plugins/axxa-connect/`.
3. In Obsidian: **Settings → Community plugins**, enable **Axxa Connect**.

### Build from source

```bash
git clone https://github.com/axxalab/axxa-connect.git
cd axxa-connect
npm install
npm run build   # produces main.js
```

## Setup

1. In the Cloudflare dashboard, create an **R2 bucket**.
2. **R2 → Manage R2 API Tokens → Create API Token** with **Object Read & Write**
   scoped to that bucket. Copy the **Access Key ID** and **Secret Access Key**.
   Your **Account ID** is part of the S3 endpoint
   (`https://<ACCOUNT_ID>.r2.cloudflarestorage.com`).
3. In Obsidian, open **Settings → Axxa Connect** and fill in Account ID, Access
   Key ID, Secret Access Key and the bucket name. Leave **Client IP filtering**
   empty on the token so it works from any device.
4. Click **Test** to verify the connection.

## Commands

| Command | Description |
|---------|-------------|
| Sync vault with R2 (two-way) | Sends and receives only what changed |
| Push current file to R2 | Uploads the active note |
| Push entire vault to R2 | Uploads every file |
| Pull entire vault from R2 | Downloads everything (overwrites local) |
| Test R2 connection | Validates credentials |

The **↻ ribbon icon** runs a two-way sync, and the same buttons (Sync / Push all /
Pull all) are available under **Settings → Axxa Connect → Actions**. **Push on save**
enables automatic per-file upload.

## Security

- Credentials are stored in the plugin's local settings (`data.json`) and are
  never sent anywhere except Cloudflare.
- Use a token scoped **only** to your vault bucket, and revoke/rotate it anytime
  from the Cloudflare dashboard.

## Limitations

- Two-way sync tracks changes with the local file's modified time and the remote
  ETag. Conflicts (a file changed on **both** sides since the last sync) are
  resolved **last-write-wins by newest timestamp** — there is no line-level merge.
- Moves and deletions are propagated using each device's **last-sync state**
  (stored in `data.json`). If that state is missing (fresh install, or the file
  was never synced from this device), a deletion on the other side can't be told
  apart from a brand-new file, so the file is re-created instead of removed — a
  safe fallback that never loses data. Local deletions are moved to the vault
  **trash**, so they're recoverable.
- A move is handled as delete-at-old-path + create-at-new-path. On R2 (like S3)
  there is no atomic rename, so the object is re-uploaded under the new key.

Content-hash change detection is on the roadmap.

## License

[MIT](LICENSE) © AXXA Studio Lab

# Axxa Connect

Connect your Obsidian vault to **Cloudflare R2** (S3-compatible object storage)
and sync your notes as **plain files** — no encryption, no chunking — so they
stay readable by other tools and AIs.

Works on **desktop and mobile**: requests are signed with AWS SigV4 and sent
through Obsidian's `requestUrl`, so there are no CORS issues and your credentials
never leave the app.

## Features

- One-way and manual sync with Cloudflare R2 (or any S3-compatible endpoint)
- Push the current note, or the whole vault, to R2
- Pull the whole vault from R2
- Optional **push on save** (debounced)
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
| Push current file to R2 | Uploads the active note |
| Push entire vault to R2 | Uploads every file |
| Pull entire vault from R2 | Downloads everything (overwrites local) |
| Test R2 connection | Validates credentials |

A cloud ribbon icon pushes the whole vault, and **Push on save** enables
automatic per-file upload.

## Security

- Credentials are stored in the plugin's local settings (`data.json`) and are
  never sent anywhere except Cloudflare.
- Use a token scoped **only** to your vault bucket, and revoke/rotate it anytime
  from the Cloudflare dashboard.

## Limitations (v0.1)

- Conflict resolution is **last-write-wins** (no merge). Avoid editing the same
  note in two places without syncing first.
- Deletions are not propagated automatically (deleting a note locally does not
  remove it from R2).

Incremental sync (by hash) and deletion propagation are on the roadmap.

## License

[MIT](LICENSE) © AXXA Studio Lab

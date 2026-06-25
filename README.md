# Jarvis Control Center

Self-hosted homelab control panel for managing devices, SSH/SFTP connections, file access, and remote actions from one web UI.

This repository is an early MVP scaffold. The first boot starts empty and shows the initial administrator setup screen.

## Current MVP

- FastAPI backend
- React + Tailwind frontend
- SQLite stored under `/data`
- Docker Compose deployment
- Initial admin setup lock
- Argon2id password hashing
- httpOnly cookie sessions
- Login, logout, and current-user endpoint
- Login rate limit with temporary user lockout
- Device credentials encrypted in SQLite using `APP_SECRET_KEY`
- Add, list, edit, delete, and test SSH/SFTP devices
- Web SSH terminal over backend WebSocket
- SFTP file explorer with multi-select actions
- SFTP to SFTP copy/move that copies file contents, preserves basic timestamps when possible, and ignores incompatible xattrs/ACLs
- Initial SMB and NFS share support for listing, downloading, creating folders, renaming, deleting, and copying/moving to or from SFTP/SMB/NFS
- Machines can own multiple SMB/NFS share records instead of treating each share as a separate machine
- Background transfer jobs with progress, speed, ETA, cancellation, recent history, and dismissible completed jobs
- Cancelled jobs clean up destination files/folders created by that job when safe
- NFS shares are mounted inside the backend container under `/data/nfs-mounts`
- Responsive dark UI for desktop, tablet, and phone
- Transfer policy endpoint documenting the default "Transfers that just work" behavior

## Planned Next MVP Steps

- Transfer logs and per-file details
- NFS mount health, reconnect, and advanced option presets
- 2FA/TOTP
- Multi-user permissions
- Plugins

## Security Defaults

Passwords are never stored in plain text. User passwords are hashed with Argon2id.

Device secrets are encrypted before being saved to SQLite. Set `APP_SECRET_KEY` to a long random value and keep it stable. If `APP_SECRET_KEY` is missing, the backend emits a clear warning and uses an ephemeral process key. That is useful for local testing only; encrypted credentials and sessions will not survive restarts.

Generate a secret:

```bash
openssl rand -base64 48
```

## Quick Start

```bash
cp .env.example .env
docker compose up --build
```

Open:

```text
http://localhost:8080
```

On first launch, create the administrator account. The setup route is locked after the first user exists.

## Adding Shares

Machines use a friendly name and host/IP. SSH/SFTP access is optional and can be enabled per machine.

SMB shares are added inside a machine through its Shares button. Use the full share path when possible:

```text
smb://10.10.20.8/Media
\\10.10.20.8\Media
```

If the machine has multiple shares, add each share under that machine. The stored SMB password is encrypted and is never sent back to the frontend after saving.

NFS shares can be added with either form below:

```text
10.10.20.8:/mnt/pool/share
nfs://10.10.20.8/mnt/pool/share
```

NFS browsing and transfers use Linux NFS mounts inside the backend container. Opening the Files view for an NFS share mounts it before listing the directory. The default Compose file installs `nfs-common`, grants the backend container `SYS_ADMIN` plus `apparmor:unconfined`, and runs the backend with host networking so NFS servers see the Unraid/host IP instead of an internal Docker bridge IP.

Authorize the host IP in the NFS server export rules. For example, if Jarvis runs on `10.10.20.7`, allow `10.10.20.7` or your LAN subnet.

You can tune NFS behavior in `.env`:

```env
NFS_MOUNT_OPTIONS=rw,nfsvers=4,soft,timeo=50,retrans=2
NFS_MOUNT_ROOT=/data/nfs-mounts
```

If a NAS only exports NFSv3, change `nfsvers=4` to `nfsvers=3`.

## Ubuntu Server Install

1. Install Docker Engine and the Docker Compose plugin.
2. Clone this repository.
3. Create `.env` from `.env.example`.
4. Set `APP_SECRET_KEY` to a long random value.
5. Start the stack:

```bash
docker compose up -d --build
```

The app is available on `http://SERVER_IP:8080` unless you change `APP_PORT`.

## Unraid Install

Use this repository as a Compose project through the Docker Compose Manager plugin or a normal terminal workflow.

Recommended settings:

- Keep `APP_SECRET_KEY` in the Compose environment and do not rotate it casually.
- Map the frontend port with `APP_PORT`, for example `8080`.
- Keep the named `jarvis-data` volume, or replace it with an Unraid appdata bind mount such as `/mnt/user/appdata/jarvis-control-center:/data` for the backend service.

Example backend volume override:

```yaml
services:
  backend:
    volumes:
      - /mnt/user/appdata/jarvis-control-center:/data
```

## Transfer Philosophy

The file transfer design intentionally avoids rsync-style metadata failures by default.

Jarvis Control Center should copy file contents first, preserve basic dates when possible, preserve simple permissions only when safe, and silently ignore incompatible xattrs/ACLs such as Apple metadata streams:

- `user.DosStream.com.apple.quarantine:$DATA`
- `user.DosStream.com.apple.lastuseddate#PS:$DATA`
- `user.DosStream.com.apple.cscached:$DATA`
- `user.DOSATTRIB`

The goal is simple: transfers that just work.

## Transfer Performance

Transfers are tuned for compatibility first and can be adjusted for fast networks without exposing copy modes in the UI. Jarvis copies through the backend so it can ignore incompatible xattrs/ACLs, which is safer than rsync-style metadata preservation but may need tuning on 10Gb, 25Gb, 40Gb, or faster networks.

Optional `.env` settings:

```bash
# Default: 16 MB. Allowed range: 1 MB to 256 MB.
TRANSFER_CHUNK_SIZE=16777216

# Default: 4 chunks. Allowed range: 1 to 16.
TRANSFER_PREFETCH_CHUNKS=4

# Default: 2 files. Allowed range: 1 to 16.
TRANSFER_PARALLEL_FILES=2

# Default: 4 streams for each large file. Allowed range: 1 to 16.
TRANSFER_FILE_STREAMS=4

# Default: 1 GB. Files smaller than this use one stream.
TRANSFER_FILE_STREAM_MIN_SIZE=1073741824

# Default: true for compatibility. Set false only on trusted networks if your NAS allows it.
SMB_REQUIRE_SIGNING=true

# Default: negotiate. Use ntlm only if your SMB environment needs it.
SMB_AUTH_PROTOCOL=negotiate
```

For very fast networks and single large files, tune `TRANSFER_FILE_STREAMS` first. For example:

```bash
TRANSFER_CHUNK_SIZE=33554432
TRANSFER_PREFETCH_CHUNKS=4
TRANSFER_FILE_STREAMS=4
TRANSFER_FILE_STREAM_MIN_SIZE=1073741824
```

Higher values can improve large-file transfers, but they also increase backend memory use and the number of SMB/SFTP connections per active transfer. The UI still keeps the same simple behavior: choose source, choose destination, copy or move.

On trusted homelab networks, setting `SMB_REQUIRE_SIGNING=false` can improve SMB throughput if your NAS allows unsigned SMB. If authentication or access breaks, keep the default `true`.

## Development

Backend:

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
APP_SECRET_KEY=dev-secret DATA_DIR=./data uvicorn app.main:app --reload
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

Set `VITE_API_BASE=http://localhost:8000/api` when running frontend and backend on separate dev ports.

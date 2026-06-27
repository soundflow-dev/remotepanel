# RemotePanel

One panel, all your remote systems.

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
- Add, list, edit, and delete machines with optional SSH/SFTP access
- Web SSH terminal over backend WebSocket
- Remote power actions for SSH machines: Wake-on-LAN, reboot, and shutdown
- Stats panel for SSH machines with CPU usage, per-core usage when available, memory, disk, and uptime
- SFTP file explorer with multi-select actions
- SFTP to SFTP copy/move that copies file contents, preserves basic timestamps when possible, and ignores incompatible xattrs/ACLs
- SMB share support for listing, downloading, creating folders, renaming, deleting, and copying/moving to or from SFTP/SMB
- Machines can own multiple SMB share records instead of treating each share as a separate machine
- Background transfer jobs with progress, speed, ETA, cancellation, recent history, and dismissible completed jobs
- Cancelled jobs clean up destination files/folders created by that job when safe
- Responsive UI for desktop, tablet, and phone
- Light mode, dark mode, and system theme mode
- Transfer policy endpoint documenting the default "Transfers that just work" behavior

## Machine Support

RemotePanel is designed for mixed homelabs.

Wake-on-LAN only needs a saved MAC address and is sent from the RemotePanel backend to the local network. Reboot, shutdown, terminal, files, and stats use SSH/SFTP when enabled on the machine.

Current stats support:

- Linux and Home Assistant OS: CPU usage, per-core CPU usage, memory, disk, and uptime.
- macOS: CPU usage, memory, disk, and uptime. Per-core CPU usage is estimated from total CPU usage because macOS does not expose the same per-core counters through a plain SSH session.
- FreeBSD: CPU usage, memory, disk, and uptime. Per-core CPU usage appears when `kern.cp_times` is available.
- Windows with OpenSSH Server and PowerShell: CPU usage, per-core CPU usage, memory, disk, and uptime.

Power actions:

- Home Assistant OS uses `ha host reboot` and `ha host shutdown` when the `ha` CLI is available.
- Linux, macOS, and FreeBSD use normal reboot/poweroff commands, with `sudo` support when the SSH password is saved.
- Windows uses `shutdown.exe /r /t 0 /f` and `shutdown.exe /s /t 0 /f`.

For shutdown/reboot, the remote SSH user must have permission to run the relevant power command. On Unix-like systems that often means passwordless sudo or password authentication saved in RemotePanel. On Windows, the SSH user normally needs administrator privileges.

Windows support works for Windows desktop editions and Windows Server when the built-in OpenSSH Server feature is enabled and the SSH user can run normal PowerShell/CIM commands. RemotePanel detects Windows with `cmd /c ver`, gathers stats with `Get-CimInstance`, and sends power actions with `shutdown.exe`.

Windows requirements and caveats:

- Supported targets include modern Windows 10/11 and Windows Server releases with OpenSSH Server.
- PowerShell must be available in the SSH session.
- Stats require access to WMI/CIM classes such as `Win32_Processor`, `Win32_OperatingSystem`, `Win32_LogicalDisk`, and `Win32_PerfFormattedData_PerfOS_Processor`.
- Reboot and shutdown usually require an administrator account or equivalent policy permissions.
- Group Policy, endpoint security tools, disabled performance counters, or a restricted SSH shell can block stats or power actions.

## Planned Next MVP Steps

- Transfer logs and per-file details
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
docker compose up --build
```

Open:

```text
http://localhost:8080
```

On first launch, create the administrator account. The setup route is locked after the first user exists.

## Adding Shares

Machines use a friendly name and host/IP. SSH/SFTP access is optional and can be enabled per machine.

Add a MAC address to enable Wake-on-LAN for a machine. Wake-on-LAN support also depends on the target machine firmware/OS and network allowing magic packets.

SMB shares are added inside a machine through its Shares button. Use the full share path when possible:

```text
smb://10.10.20.8/Media
\\10.10.20.8\Media
```

If the machine has multiple shares, add each share under that machine. The stored SMB password is encrypted and is never sent back to the frontend after saving.

## Ubuntu Server Install

1. Install Docker Engine and the Docker Compose plugin.
2. Clone this repository.
3. Create `.env`.
4. Set `APP_SECRET_KEY` to a long random value.
5. Start the stack:

```bash
docker compose up -d --build
```

The app is available on `http://SERVER_IP:8080` unless you change `APP_PORT`.

Example `.env`:

```bash
APP_PORT=8080
COOKIE_SECURE=false
APP_SECRET_KEY=replace-with-openssl-rand-base64-48
```

## Unraid Install

Use this repository as a Compose project through the Docker Compose Manager plugin or a normal terminal workflow.

Recommended settings:

- Keep `APP_SECRET_KEY` in the Compose environment and do not rotate it casually.
- Map the frontend port with `APP_PORT`, for example `8080`.
- Keep the named `remotepanel-data` volume, or replace it with an Unraid appdata bind mount such as `/mnt/user/appdata/remotepanel:/data` for the backend service.

Example backend volume override:

```yaml
services:
  backend:
    volumes:
      - /mnt/user/appdata/remotepanel:/data
```

## Transfer Philosophy

The file transfer design intentionally avoids rsync-style metadata failures by default.

RemotePanel should copy file contents first, preserve basic dates when possible, preserve simple permissions only when safe, and silently ignore incompatible xattrs/ACLs such as Apple metadata streams:

- `user.DosStream.com.apple.quarantine:$DATA`
- `user.DosStream.com.apple.lastuseddate#PS:$DATA`
- `user.DosStream.com.apple.cscached:$DATA`
- `user.DOSATTRIB`

The goal is simple: transfers that just work.

## Transfer Performance

Transfers are tuned for compatibility first and can be adjusted for fast networks without exposing copy modes in the UI. RemotePanel copies through the backend so it can ignore incompatible xattrs/ACLs, which is safer than rsync-style metadata preservation but may need tuning on 10Gb, 25Gb, 40Gb, or faster networks.

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

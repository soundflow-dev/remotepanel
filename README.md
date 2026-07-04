<p align="center">
  <img src="docs/assets/remotepanel-wordmark.svg" alt="RemotePanel - One panel, all your remote systems" width="520">
</p>

RemotePanel is an open-source, self-hosted homelab control panel for managing remote machines, SSH/SFTP access, SMB shares, files, terminal sessions, stats, Wake-on-LAN, reboot, and shutdown actions from one clean web UI.

RemotePanel runs as one Docker app: the React frontend is built into the image and served by the FastAPI backend, with persistent data stored in `/data`.

## Recommended Host

RemotePanel can run on modest hardware for normal machine management, terminal access, stats, and small file operations.

For very large high-speed transfers, especially on Unraid with the default aggressive transfer profile, 32 GB RAM is recommended. Large multi-hundred-GB transfers can temporarily consume significant Docker/container memory while RemotePanel streams data and periodically asks Linux to release unused memory.

## Screenshots

| Dashboard | Add Machine |
| --- | --- |
| ![Dashboard with no machines](docs/screenshots/with-no-machines-added.png) | ![Add a new machine](docs/screenshots/add-a-new-machine.png) |

| Terminal | Files |
| --- | --- |
| ![Terminal](docs/screenshots/terminal.png) | ![Files](docs/screenshots/files.png) |

| Stats | Shares |
| --- | --- |
| ![Stats](docs/screenshots/stats.png) | ![Add a share](docs/screenshots/add-a-share.png) |

| Power Actions | First Setup |
| --- | --- |
| ![Power actions](docs/screenshots/power-actions.png) | ![Initial administrator setup](docs/screenshots/first-login-create-administrator.png) |

| Login |
| --- |
| ![Login](docs/screenshots/login.png) |

## Features

- Docker deployment in one container
- FastAPI backend and React + Tailwind frontend
- SQLite database stored under `/data`
- Initial admin setup on first launch
- Login/logout with httpOnly cookies
- Argon2id password hashing
- Device credentials encrypted with `APP_SECRET_KEY`
- Machines with optional SSH/SFTP access
- Web SSH terminal
- File explorer for SFTP/SSH fallback and SMB shares
- Multi-select copy, move, delete, download, upload, and folder creation
- SMB shares grouped inside each machine
- Background transfer jobs with progress, speed, ETA, cancellation, recent history, transfer queue, and Safe/Balanced/Turbo modes
- Wake-on-LAN, reboot, and shutdown actions
- Stats panel with CPU, per-core CPU when available, memory, disk, and uptime
- Light, dark, and system theme modes
- English, Portuguese, French, German, Spanish, and Chinese UI

## Supported Targets

RemotePanel is designed for mixed homelabs:

- Linux and Home Assistant OS
- macOS
- FreeBSD
- Windows 10/11 and Windows Server with OpenSSH Server
- SMB shares on NAS/server targets

Stats, reboot, shutdown, terminal, and files require SSH/SFTP access on the target machine. Wake-on-LAN requires a saved MAC address and compatible hardware/network configuration.

## Important Security Note

Set `APP_SECRET_KEY` before production use and keep it stable.

RemotePanel encrypts saved machine credentials with this key. If you lose or change it, existing saved credentials cannot be decrypted.

Generate a key:

```bash
openssl rand -base64 48
```

## Linux Installation

These steps work on a typical Ubuntu/Debian server. Other Linux distributions are similar as long as Docker is installed.

### 1. Install Docker

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg git openssl
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Confirm Docker is working:

```bash
sudo docker version
sudo docker compose version
```

### 2. Clone RemotePanel

```bash
cd /opt
sudo git clone https://github.com/soundflow-dev/remotepanel.git remotepanel
cd remotepanel
```

### 3. Create `.env`

```bash
sudo cp .env.example .env
sudo nano .env
```

Example:

```env
APP_PORT=8080
COOKIE_SECURE=false
APP_SECRET_KEY=replace-this-with-openssl-rand-base64-48
```

Generate a secret if needed:

```bash
openssl rand -base64 48
```

### 4. Start RemotePanel

```bash
sudo docker compose up -d --build
```

Open:

```text
http://SERVER_IP:8080
```

On first launch, create the admin user.

### 5. Update RemotePanel Later

```bash
cd /opt/remotepanel
sudo git pull
sudo docker compose up -d --build
```

## Unraid Installation

These steps use the Unraid terminal and work even if your Unraid installation does not have `docker compose`.

### 1. Open Unraid Terminal

Use the Unraid web terminal or SSH into your server.

### 2. Clone RemotePanel

```bash
cd /mnt/user/appdata
git clone https://github.com/soundflow-dev/remotepanel.git
cd remotepanel
```

### 3. Create `.env`

Generate a secret:

```bash
openssl rand -base64 48
```

Create the file:

```bash
nano .env
```

Paste this, replacing the secret:

```env
APP_PORT=8090
COOKIE_SECURE=false
APP_SECRET_KEY=replace-this-with-your-generated-secret
```

Save in nano:

```text
CTRL + O
Enter
CTRL + X
```

### 4. Build the Docker Image

```bash
docker build -t remotepanel .
```

### 5. Start the Container

```bash
docker run -d \
  --name remotepanel \
  --restart unless-stopped \
  --label net.unraid.docker.icon="https://raw.githubusercontent.com/soundflow-dev/remotepanel/main/frontend/public/brand/icon-512.png" \
  --label net.unraid.docker.webui="http://[IP]:[PORT:8000]" \
  -p 8090:8000 \
  -v /mnt/user/appdata/remotepanel/data:/data \
  --env-file .env \
  remotepanel
```

Open:

```text
http://UNRAID_IP:8090
```

The Unraid labels in the `docker run` command make the RemotePanel icon and WebUI shortcut appear correctly in the Unraid Docker page.

On first launch, create the admin user.

### 6. Update RemotePanel Later

```bash
cd /mnt/user/appdata/remotepanel
git pull
docker build -t remotepanel .
docker rm -f remotepanel
docker run -d \
  --name remotepanel \
  --restart unless-stopped \
  --label net.unraid.docker.icon="https://raw.githubusercontent.com/soundflow-dev/remotepanel/main/frontend/public/brand/icon-512.png" \
  --label net.unraid.docker.webui="http://[IP]:[PORT:8000]" \
  -p 8090:8000 \
  -v /mnt/user/appdata/remotepanel/data:/data \
  --env-file .env \
  remotepanel
```

### 7. View Logs

```bash
docker logs -f remotepanel
```

### 8. Clean Install on Unraid

Warning: this removes all RemotePanel data.

```bash
docker rm -f remotepanel
docker rmi -f remotepanel
rm -rf /mnt/user/appdata/remotepanel
```

Then repeat the Unraid installation steps above.

## Backups

Back up both:

- `/mnt/user/appdata/remotepanel/data`
- `/mnt/user/appdata/remotepanel/.env`

The `.env` file contains `APP_SECRET_KEY`, which is required to decrypt saved machine credentials after restoring.

Example Unraid backup:

```bash
mkdir -p /mnt/user/backups
tar -czf /mnt/user/backups/remotepanel-data-backup.tar.gz \
  -C /mnt/user/appdata/remotepanel data .env
```

## Adding Machines

For SSH/SFTP features, the target machine must have SSH enabled.

Common target setup:

- Linux/FreeBSD: install and enable OpenSSH server.
- macOS: enable **System Settings > General > Sharing > Remote Login**.
- Windows: enable OpenSSH Server and use a local/admin account for power actions and stats.
- Home Assistant OS: SSH access works for terminal/stats/files where permissions allow it.

Use the machine's IP/hostname, SSH port, username, and password or SSH key. Add a MAC address only if you want Wake-on-LAN.

## Adding SMB Shares

SMB shares are added inside a machine through **Shares**.

Use full paths such as:

```text
smb://10.10.20.8/Media
\\10.10.20.8\Media
```

If a machine has multiple shares, add each share under the same machine.

## Transfer Settings

Optional `.env` settings:

```env
TRANSFER_CHUNK_SIZE=67108864
TRANSFER_PREFETCH_CHUNKS=16
TRANSFER_PARALLEL_FILES=2
TRANSFER_FILE_STREAMS=16
TRANSFER_SMB_FILE_STREAMS=10
TRANSFER_FILE_STREAM_MIN_SIZE=1073741824
TRANSFER_RESUME_BLOCK_SIZE=536870912
TRANSFER_RESUME_REWIND_BYTES=268435456
TRANSFER_RESUME_REWRITE_FULL=false
TRANSFER_MEMORY_TRIM_BYTES=10737418240
TRANSFER_MEMORY_TRIM_PAUSE_SECONDS=1
TRANSFER_MEMORY_DEEP_TRIM_BYTES=107374182400
TRANSFER_MEMORY_DEEP_TRIM_PAUSE_SECONDS=5
TRANSFER_MEMORY_DEEP_TRIM_PASSES=3
TRANSFER_PROGRESS_COMMIT_BYTES=268435456
TRANSFER_PROGRESS_COMMIT_SECONDS=2
TRANSFER_CANCEL_CHECK_SECONDS=1
TRANSFER_STALL_TIMEOUT_SECONDS=300
TRANSFER_WORKER_RESTARTS=5
SMB_REQUIRE_SIGNING=true
SMB_AUTH_PROTOCOL=negotiate
```

The defaults are tuned for high-throughput homelab transfers and are intentionally aggressive. For very large transfers, 32 GB RAM is recommended on the host.

The UI includes three transfer modes:

| Mode | Best for | Notes |
| --- | --- | --- |
| Safe | Smaller servers, low-RAM hosts, or when UI responsiveness matters most | Slowest mode, lowest resource pressure. A good choice for 8 GB RAM systems or cautious first tests. |
| Balanced | Normal use while transfers are running | Reserves more room for browsing folders and using the app while still keeping useful transfer speed. |
| Turbo | Large high-speed transfers when you do not need to use the app much | Maximum throughput profile. Even on machines with plenty of RAM, navigation can feel slow while Turbo transfers are active. It is best for leaving big transfers running unattended, for example overnight. |

On smaller systems, use **Safe** or **Balanced** first. Advanced users can also reduce `TRANSFER_FILE_STREAMS`, `TRANSFER_PREFETCH_CHUNKS`, or `TRANSFER_CHUNK_SIZE` to lower memory usage further.

Choose the transfer mode before starting a transfer or queue. Active transfers keep the mode they were started with, so the mode selector is locked while transfers are pending, running, or cancelling. You can change it again after all active transfers finish.

The total transfer size is not the only factor. A 600 GB transfer over 1 Gbps usually puts much less pressure on memory than the same transfer over multi-Gbps networking, because fewer buffers are active at the same time.

`TRANSFER_FILE_STREAMS` controls how many streams RemotePanel may use for one large file. `TRANSFER_SMB_FILE_STREAMS` caps that value whenever the source or destination is SMB. It defaults to `10` for aggressive high-speed homelab transfers. If a NAS, switch, or server becomes unstable during multi-TB transfers, lower this value first. Turbo can still transfer different files in parallel.

`TRANSFER_MEMORY_TRIM_BYTES` makes RemotePanel pause briefly and ask Python/Linux to release unused memory every N transferred bytes across all running transfers. The default is 10 GiB globally, not 10 GiB per individual transfer. Set it to `0` to disable it, or lower it if your server has limited RAM. `TRANSFER_MEMORY_TRIM_PAUSE_SECONDS` controls the short pause after each trim.

`TRANSFER_MEMORY_DEEP_TRIM_BYTES` adds a heavier global cleanup for multi-TB transfers. The default is 100 GiB across all running transfers. A deep trim runs multiple cleanup passes, controlled by `TRANSFER_MEMORY_DEEP_TRIM_PASSES`, and pauses a little longer using `TRANSFER_MEMORY_DEEP_TRIM_PAUSE_SECONDS`. This can reduce long-transfer memory buildup, but memory that is actively in use by current buffers cannot be released until those buffers finish.

`TRANSFER_PROGRESS_COMMIT_BYTES` and `TRANSFER_PROGRESS_COMMIT_SECONDS` control how often transfer progress is written to SQLite. The defaults avoid excessive database writes during multi-Gbps and multi-TB transfers while still keeping the UI updated regularly. Lower values make progress feel more immediate but can reduce responsiveness during very large transfers.

`TRANSFER_CANCEL_CHECK_SECONDS` controls how often running transfers check whether the user clicked cancel. The default is 1 second.

`TRANSFER_STALL_TIMEOUT_SECONDS` protects very large transfers from hanging forever if an SMB/SFTP operation stops making progress. The default is 300 seconds. When a transfer stays idle longer than this, RemotePanel stops the isolated transfer worker.

`TRANSFER_WORKER_RESTARTS` controls how many times RemotePanel will automatically restart a stalled transfer worker. SMB transfers are written in resumable blocks, controlled by `TRANSFER_RESUME_BLOCK_SIZE`, so a restarted worker can continue from files or partial files that already reached the destination instead of starting the whole job again.

`TRANSFER_RESUME_REWIND_BYTES` makes resumable SMB transfers rewind and rewrite the tail of a partial destination file before continuing. The default is 256 MiB. This protects the boundary where a previous stalled write may have stopped.

`TRANSFER_RESUME_REWRITE_FULL=true` disables partial resume safety trade-offs and rewrites a partial destination file from the beginning after a worker restart. This is the most conservative option, but very large files may take much longer if a stall happens near the end.

For trusted homelab networks, `SMB_REQUIRE_SIGNING=false` may improve SMB speed if your NAS allows unsigned SMB.

After transfers finish, use the **Report** button in the Transfers panel to inspect what happened. The report records worker restarts, stalls, resumed files, skipped files, per-file errors, and the amount of the partial destination file that was rewritten before resuming.

### Large Transfers and Memory on Unraid

During very large transfers, Unraid or `docker stats` may show high Docker memory usage. This can include kernel/container accounting and I/O-related memory, so it does not always mean the RemotePanel Python process is leaking memory.

With the default high-throughput settings and **Turbo** mode, a host with 32 GB RAM is recommended for multi-hundred-GB transfers. Systems with less RAM may still work, but should use **Safe** or **Balanced**.

The most useful host-side value is `available`:

```bash
free -h
```

If `available` remains several GB, the server still has usable memory headroom even if Docker memory looks high.

To inspect the RemotePanel container memory breakdown:

```bash
docker exec remotepanel sh -c "cat /sys/fs/cgroup/memory.stat 2>/dev/null | egrep 'anon|file|kernel|slab'"
```

As a rule of thumb:

- high `anon` usually means real process memory
- high `file` usually means file/cache related memory
- low `anon` with healthy `available` usually means the system is not under dangerous memory pressure

For live monitoring during a big transfer:

```bash
watch -n 5 "free -h && echo && docker stats --no-stream remotepanel"
```

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

## License

MIT

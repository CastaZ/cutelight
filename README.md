# WebDMX

Phone-friendly web controller for Art-Net DMX on local Wi-Fi.

## What this does

- Hosts a web page on your current local network (for you: `cutelab` Wi-Fi).
- Anyone on the same local network can control fixtures from phone or laptop.
- Sends DMX via Art-Net to your node at `192.168.88.150` by default.
- Uses scalable fixture patch config in `config/fixtures.json`.

## Quick start

1. Install dependencies (already done once in this folder):

   ```bash
   npm install
   ```

2. Run server:

   ```bash
   npm start
   ```

3. Open in browser on control computer:

   - `http://localhost:3000`

4. Open from other devices on `cutelab` Wi-Fi:

   - `http://<control-computer-lan-ip>:3000`
   - On macOS, find LAN IP:
     ```bash
     ipconfig getifaddr en0
     ```

## GitHub bootstrap (first time)

If this folder is not connected to GitHub yet:

```bash
git init
git add .
git commit -m "Initial CuteLight setup"
git branch -M main
git remote add origin <your-github-repo-url>
git push -u origin main
```

After this, your normal workflow is:

```bash
git add .
git commit -m "Describe change"
git push
```

## Default environment

- `HOST=0.0.0.0`
- `PORT=3000`
- `ARTNET_HOST=192.168.88.150`
- `ARTNET_PORT=6454`
- `ARTNET_IFACE=` (optional, local Ethernet IP to force Art-Net out that interface)
- `DMX_FPS=40`

Example custom run:

```bash
ARTNET_HOST="192.168.88.150" npm start
```

Direct Ethernet example (console connected to Mac):

```bash
ARTNET_HOST="10.10.10.50" ARTNET_IFACE="10.10.10.1" npm start
```

## Control routes

- `/` control UI (no passcode)
- `/view` read-only view (no passcode, cannot write)

## Fixture patch and profiles

Edit [`config/fixtures.json`](config/fixtures.json) and restart server.

Each fixture:

- `id`
- `name`
- `type`
- `universe`
- `startChannel`
- `channelCount`
- optional `channelLabels`
- optional `channels` metadata with named ranges for UI hints

Validation blocks overlaps and out-of-range channels.

Current default patch:

- `rgbuv_1` at universe `0`, address `1` (11CH RGBAL+UV)
- `gobo_1` at universe `0`, address `15` (12CH moving gobo)
- `rgbuv_2` at universe `0`, address `30` (11CH RGBAL+UV)
- `rgbuv_u1_1` at universe `1`, address `1` (11CH RGBAL+UV)
- `rgbuv_u1_2` at universe `1`, address `15` (11CH RGBAL+UV)

## Programs (easy setup)

Program data is persisted in [`config/programs.json`](config/programs.json).

- **Scenes**: save and recall snapshots of all fixture channels + master.
- **Chases**: timed loops built from saved scenes.
- **Macros**: one-tap fixture-aware helpers (wash colors, UV pulse, gobo movement).

Manual control automatically stops any running chase to keep live operation predictable.

## Absolute DMX view

The UI includes a per-universe `1-512` channel panel:

- Select a universe from the dropdown.
- Move sliders channel-by-channel.
- Patched channels write back to their owning fixture channel.
- Unpatched channels are shown but locked.

## Raspberry Pi 3B+ deployment

1. Clone repo on Pi:

   ```bash
   cd /home/pi
   git clone <your-github-repo-url> webdmx
   cd webdmx
   npm ci
   ```

2. Create env file:

   ```bash
   cp deploy/webdmx.env.example deploy/webdmx.env
   nano deploy/webdmx.env
   ```

3. Install systemd service:

   ```bash
   sudo cp deploy/webdmx.service /etc/systemd/system/webdmx.service
   sudo systemctl daemon-reload
   sudo systemctl enable webdmx
   sudo systemctl start webdmx
   sudo systemctl status webdmx
   ```

## GitHub update workflow on Pi

Use the included script after pushing updates to your GitHub branch:

```bash
cd /home/pi/webdmx
./scripts/update-on-pi.sh
```

Optional branch override:

```bash
BRANCH=main ./scripts/update-on-pi.sh
```

What it does:

- fetches latest GitHub commits
- fast-forward updates local branch
- installs production dependencies
- restarts `webdmx` service and prints status

## Optional GitHub auto-deploy to Pi

This repo includes [`.github/workflows/deploy-pi.yml`](.github/workflows/deploy-pi.yml) for deploy-on-push to `main`.

Set these GitHub repository secrets before enabling:

- `PI_HOST` (Pi IP or DNS name)
- `PI_USER` (for example `pi`)
- `PI_SSH_KEY` (private key matching Pi authorized key)
- `PI_APP_DIR` (for example `/home/pi/webdmx`)
- `PI_SERVICE_NAME` (for example `webdmx`)

After secrets are set:

- push to `main` to trigger deploy automatically
- or run manually from the Actions tab with `workflow_dispatch`

## Rollback on Pi

If a new update misbehaves:

```bash
cd /home/pi/webdmx
git log --oneline -n 10
git checkout <known-good-commit>
npm ci --omit=dev
sudo systemctl restart webdmx
```

Then pin to that commit or fix forward in GitHub.

## Notes

- This is intended for trusted venue LAN use.
- If your Art-Net node IP changes, override with `ARTNET_HOST="<your-console-ip>" npm start`.

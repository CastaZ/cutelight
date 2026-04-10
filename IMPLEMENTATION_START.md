# WebDMX Implementation Start

## Target

- Project directory: `/Users/casta/Documents/Work/Side Projects For Fun /webdmx`
- Art-Net node IP: `002.052.155.078`
- Network access: users connected to `cutelab` Wi-Fi can control lights
- Initial fixtures: `4` fixtures, `7` channels each
- Future growth: config-driven fixture patching (no code rewrite to add fixtures)

## MVP Scope

1. Local Node.js server that binds `0.0.0.0` for LAN access.
2. WebSocket sync so all phones share the same live state.
3. Art-Net DMX output to configured node/universe.
4. Mobile-friendly UI with per-fixture channel sliders.
5. Safety controls: blackout + reset.
6. Basic shared passcode gate.

## Fixture Patch Model

Use a config file (`config/fixtures.json`) with fixture metadata:

- `id`: stable fixture id
- `name`: display label
- `universe`: DMX universe number
- `startChannel`: first DMX channel (1-512)
- `channelCount`: number of channels
- `channelLabels` (optional): labels per channel

Initial patch example:

```json
[
  { "id": "fx1", "name": "Fixture 1", "universe": 0, "startChannel": 1, "channelCount": 7 },
  { "id": "fx2", "name": "Fixture 2", "universe": 0, "startChannel": 8, "channelCount": 7 },
  { "id": "fx3", "name": "Fixture 3", "universe": 0, "startChannel": 15, "channelCount": 7 },
  { "id": "fx4", "name": "Fixture 4", "universe": 0, "startChannel": 22, "channelCount": 7 }
]
```

## Planned Files

- `server/index.js`: Express server + Socket.IO + auth gate.
- `server/dmx.js`: Art-Net sender + per-universe buffer state.
- `config/fixtures.json`: scalable fixture patch.
- `public/index.html`: mobile-first UI shell.
- `public/app.js`: dynamic fixture rendering + socket events.
- `public/styles.css`: touch-friendly control layout.
- `README.md`: setup, run, and troubleshooting.

## Run Behavior

- Server host: `0.0.0.0`
- Default HTTP port: `3000`
- Art-Net host: `002.052.155.078`
- FPS target: `40`
- Conflict behavior: last-write-wins

## Next Step

When plan mode is exited, implementation should begin immediately by creating the files above and wiring a working end-to-end control path.

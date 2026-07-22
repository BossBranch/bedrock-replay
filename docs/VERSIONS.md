# Bedrock version support

Protocol version in `config.json` should match your Minecraft client.  
`bedrock-protocol` / `minecraft-data` ship discrete `bedrock_x.y.z` definitions.

**Hotfixes (same protocol id):** e.g. client **1.26.33** → runtime base **1.26.30** (protocol **1001**).  
Hub codecs use the base; RakNet MOTD can advertise the client label (`advertiseVersion`).  
Do not require an exact patch match when the protocol id is the same.

**Client list (launcher):**
- Default: **stable** = protocol bases **≥ 1.19.50** (spectator + possess).
- Optional **extended** list = stable + wiki hotfixes + freecam range **1.16.201–1.19.40** from [`data/bedrock-client-versions.json`](../data/bedrock-client-versions.json), excluding `unreliable` (wiki protocol ≠ our floor base).
- Hotfix row shows `протокол <base>` under the client version.

**Replay vs settings:** play refuses only on protocol mismatch. Old files without a version still play with a warning.

**1.26+ login:** hub applies TokenPayload/offline patches via `npm run patch-deps` (postinstall) so clients without Xbox can join.

## Quick settings

```json
{
  "version": "1.26.30",
  "autoVersion": false,
  "livePort": 19132,
  "playPort": 19133,
  "advertiseHost": "127.0.0.1"
}
```

- `"version": "auto"` or `"autoVersion": true` — pick version from **destination ping** when supported.
- You may set a hotfix client label (e.g. `1.26.33`); runtime maps to the nearest supported base.
- `advertiseHost` — IP in Bedrock `transfer` (phones: PC LAN IP). Launcher auto-fills a private LAN address; keeps a still-valid local IP or a non-private host (hostname / public).
- `livePort` — record proxy (join to play the real server).
- `playPort` — replay freecam (always on; `.play` sends you here).

List versions this install knows:

```bash
node src/cli.js versions
```

## Support matrix

| Client range | Record | Play / freecam | Viewer | Possess (.me/.spec) | Notes |
|---|---|---|---|---|---|
| ≥ 1.21.x | yes | yes | **spectator** | yes | Primary target |
| 1.20.x – 1.21 | yes* | yes* | spectator | yes | If in minecraft-data |
| 1.19.50 – 1.19.x | yes* | yes* | spectator | yes | Spectator since 1.19.50 |
| 1.16.201 – 1.19.40 | yes* | yes* | **adventure + fly/no_clip** | **no** | Yellow in launcher; freecam only |
| &lt; 1.16.201 | no | no | — | — | Not in our floor / data gap |
| Not in minecraft-data | no | no | — | — | Startup error |

\*Only if `bedrock_<version>` exists for the installed `bedrock-protocol` dependency.

## Viewer modes

- **spectator** (`viewerMode=spectator`) — runtime ≥ 1.19.50; `.me` / `.spec` / `.next` enabled.
- **creative_noclip** — 1.16.201–1.19.40: adventure + fly / no_clip (not creative GM1); **possess disabled** — freecam only.

Auto-selected in `src/version.js` → applied by `src/viewer.js`.

## Phone / PC

| Setup | What runs Node | What Minecraft joins |
|---|---|---|
| PC only | PC | `127.0.0.1:listenPort` |
| Phone client + PC proxy | PC | `advertiseHost` = PC LAN IP |
| Termux (later) | phone | `127.0.0.1` on device |
| Mini APK (later) | phone service | same core, official Minecraft client |

APK is packaging only — finish the unified proxy (`start` + `.play`) first.

## Sounds

World sounds (`level_sound_event`, `play_sound`, …) are recorded and replayed by default.  
Mute in play: chat `.mute` / `.unmute`, or `"playSounds": false` in config.  
Custom resource-pack sounds need the packs present on the client (play currently sends empty pack handshake).

# Bedrock Replay

Packet-based **record + play** for Minecraft Bedrock. One process, two ports:

| Port | Role |
|------|------|
| `19132` | Live — record proxy → real server |
| `19133` | Play — freecam replay |

## Quick start

1. `copy config.example.json config.json` — set `destination` and `version`
2. `npm start` (or Windows: `start.bat` / installer via `npm run dist`)
3. In Minecraft → Servers:
   - **Replay Live** → `127.0.0.1:19132`
   - **Replay Play** → `127.0.0.1:19133`
4. Join Live → `.start` → play → `.play` for replay

Windows installer: see [INSTALL.md](INSTALL.md). Version list: [docs/VERSIONS.md](docs/VERSIONS.md).

## License

MIT

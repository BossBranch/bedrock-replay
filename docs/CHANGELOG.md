# Changelog

## 1.1.3 — 2026-07-30

PC + Android PLAY hardening:

- Kick fixes: empty armor is one-byte / empty `client.write` (no garbage RAW); pause keepalive removed; `.me`/`.spec` single-flip (no hardReset / no reset on plain `.spec`)
- `.me` inventory restored: forward recorded `inventory_*` / `player_hotbar` while possessing; fix GamePE `anvil_input` container; flush last known inv on enter (armor included)
- Ghost/FPV skins: prefer tab-list bitmap; reassert after `.free`; do not push FPV skin onto `recordedSelf.uuid`

## 1.1.0 — 2026-07-22

Release cleanup (PC + Android):

- `.me`: suppress RAW non-armor `inventory_*` (same as freecam) — latent kick guard
- `autoRecord` only when explicitly `true` (no silent auto-start)
- Overlay never starts in-place play (queue PLAY `:19133`); chat `.play` unchanged
- Overlay: EN UI with app language; soft-hide bubble; remove dead `playInPlaceFromOverlay`
- Config/UI parity: `saveOnDisconnect` API, mobile checkbox defaults, `controlUi` off on phone
- Disk junk removed; version unified to **1.1.0**; Android ships **release** APK

## Android 1.0.68 — 2026-07-22

- `.me` kick on item/armor changes: stop FPV `inventory_*` / armor Item re-encode
  (slot select + RAW empty armor only). Boots equip mid-replay no longer SizeOf-kicks.
- Android: smaller lang switch; title stays centered
- PC launcher: ПК / Смартфон segment buttons equal width

## Android 1.0.67 — 2026-07-22

- Default: save recording on disconnect (`saveOnDisconnect` true)
- Android RU/EN language switch; splash/status use formal «вы» / English
- `.me`: clear local armor via RAW empty `mob_armor_equipment` (no SizeOf kick)
- PC launcher: phone/LAN moved into small «Телефон» button + dialog

## Android 1.0.66 — 2026-07-22

Fix ghost armor on older recordings (Replay 9): `inventory_content`/`inventory_slot`
were decoded at load → RAW Item bytes discarded → freecam suppressed the parsed
packet. Keep them RAW; convert armor window → `mob_armor_equipment` for the ghost.

## Android 1.0.65 — 2026-07-22

Ghost **armor** from GamePE's `inventory_content` (window=armor) → RAW
`mob_armor_equipment` (Item bytes copied, no re-encode). Works on existing
Replay 9+ that already contain armor inventory packets.

## Android 1.0.64 — 2026-07-22

Ghost hands/armor via **RAW equip** (option 2) — does not regress 1.0.63 join baseline:

- RECORD: store original SB `mob_equipment` bytes (`held` + `raw:1` + base64); mid-session
  `.start` flushes last cached RAW; optional CB self-armor when parsed
- RECORD: if Item parse fails on 1.26, still keep RAW `mob_equipment` bytes (unparsed)
- PLAY: patch `runtime_entity_id` → ghost + `sendBuffer` (never `client.write` real Items)
- Old replays without RAW held events stay empty-handed — **re-record** to get items
- Empty hands still use safe empty write (1.0.63 path)

## Android 1.0.63 — 2026-07-22 · **working baseline**

Stable enough to watch replays on phone without the join/equip kick loop:

- RAW `item_registry` from recording (immediate sendBuffer)
- Spawn at first sane `start_game`; void-hop second start_game suppressed
- Freecam follows real warps; skips only high-Y void hop (≈0,300,0)
- Ghost hands/armor left empty (re-encoded equip still crashes — next: RAW equip)

Do not regress this baseline when adding ghost hands.

## Android 1.0.62 — 2026-07-22

- PLAY: voidish follow only for high-Y hop (≈0,300,0) — ground `/spawn` at
  0,74,0 was wrongly skipped once
- PLAY: restore ghost hands/armor after 3s settle; safer item shape (no forced
  has_stack_id); armor remapped onto ghost, not spectator; inventory_* still
  blocked on viewer

## Android 1.0.61 — 2026-07-22

- PLAY: ghost held items fully disabled (kick was at deferred equip main=41).
  Empty hands only — same root family as the original “bad item after warp” crash,
  just our re-encoded mob_equipment instead of the recording’s

## Android 1.0.60 — 2026-07-22

- PLAY: RAW item_registry confirmed OK; kick was post-spawn flood — cap extra
  chunk preload to 48, delay ghost 1.2s, spawn ghost with empty hands (defer
  real held 2.5s), suppress recorded inventory/mob_equipment in freecam

## Android 1.0.59 — 2026-07-22

- PLAY: `item_registry` sendBuffer now **immediate** — queued send arrived AFTER
  ghost `mob_equipment`, so client crashed with no palette (same “kick” symptom)
- PLAY: hoist `itemRegistryInjected` (ReferenceError aborted bootstrap log even
  when RAW was partially sent)

## Android 1.0.58 — 2026-07-22

- PLAY: never re-encode `item_registry` through JSON (was crashing client ~5s
  after spawn; auth_input gone, sendReliable -3). Keep/send RAW bytes only
- PLAY: do not follow freecam into void-hop / 0,0 warps; arm world-reset
  suppress on `change_dimension` (incl. biome_definition_list + raw floods)

## Android 1.0.57 — 2026-07-22

- PLAY: auto start_game pick uses the earliest sane spawn (void-hop’s second
  start_game no longer steals playhead → spawn-at-end / duration≈5s)
- PLAY: after skipping a mid-file start_game, suppress ~4s of player_list /
  remove_entity reset flood (was kicking on join into the hop tail)
- RECORD: GamePE void hop (0,300,0) skips ~4.5s of world-reset packets in the
  file so new recordings stay clean

## Android 1.0.56 — 2026-07-22

- Mobile: capture raw `item_registry` at LIVE join (it was whitelist-raw and
  never entered mid-session recordings) and flush it into every `.start` before
  ground items / inventory
- Persist `item_registry_cache.bin` (exact GamePE bytes) + prefer RAW inject on
  PLAY over JSON re-encode (mismatched network ids → instant «Произошла ошибка»)
- PLAY bootstrap sends the recording's own item_registry immediately after
  start_game, before ghost equipment

## Android 1.0.55 — 2026-07-22

- item_registry cache: read tries every candidate path (EACCES on shared-storage
  foreign-uid files no longer aborts inject); internal data dir checked first
- record: cache written to internal data dir too, not only Documents
- LIVE: "Checksum mismatch" (serverbound decryption desync) now kicks the client
  immediately instead of a 70s zombie session (world moves, commands dead)

## 1.0.2 — 2026-07-19

- Freecam floor **1.16.201+** (extended list); default picker still ≥ 1.19.50
- Yellow version hints: adjacent vs no spectator/possess
- Support range in window title; replays folder button under the list

## 1.0.0 — 2026-07-19

First stable product release.

### Launcher
- Client mode switch: **PC** (`127.0.0.1`) / **Smartphone (Android / iOS)** (LAN IP)
- Auto LAN detect; offline Wi‑Fi warning; hub restart when mode changes
- Replay list: version · duration · date; copy IP/port
- AppData path shown; `deleteAppDataOnUninstall: false` — replays survive uninstall/reinstall

### Replay engine
- Heavy packet bodies spilled to temp disk during PLAY (lower RAM)
- Sidecar `.meta.json` on save (duration for UI without full gz scan)
- Seek uses light timeline fields; payloads load on demand

### From 0.5
- Stable / extended version picker, `.pause` toggle, mode banner removed

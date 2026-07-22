# Bedrock Replay — план и доработки

## Сейчас (готово)

- Dual-port hub: LIVE (record) + PLAY (replay)
- Запись на обычные IP-серверы (прокси), `.start` / `.stop` / `.play`
- In-place `.play` на LIVE; `.live` = выход из просмотра (disconnect) → зайди на LIVE снова
- Freecam, seek, spectate (`.me` / `.spec` / `.free`)
- PC Electron-лаунчер: тема, язык, помощь, копирование IP/порта, мета реплеев, расширенный список версий
- **Android / PC v1.1.0:** cleanup release; overlay queues PLAY (no in-place from LIVE); `.me` inventory suppress; release APK.
- **Android 1.0.63 — working baseline:** просмотр реплея без кика на join; RAW `item_registry`; freecam + тп.
- **Android 1.0.64+:** ghost руки/броня через RAW.

## Ограничения (принято)

- После in-place `.play` нет hot-return на GamePE — только перезаход на LIVE.
- Горячие клавиши выкл при слежке за собой (слот = рука).
- Плавность `.spec` упирается в потолок proxy-пакетов.
- Отдельный крестик для spectator не делаем (в `.me` уже есть).
- Ghost без предмета в руке на **старых** реплеях (без RAW held) — перезаписать на 1.0.64+.
- Броня ghost на mobile whitelist часто не пишется (пакет не парсится) — руки важнее.

---

## Бэклог (открыто)

### Лаунчер · PC + смартфон в одной сети

Способ 1 (сейчас): hub на ПК, Minecraft на смартфоне (Android / iOS).  
Способ 2: только Android — каркас APK в `android/` (см. `docs/ANDROID.md`).

- [x] **Вход со смартфона:** переключатель ПК / Смартфон (Android / iOS), LAN IP только в режиме телефона
- [x] **Данные переживают uninstall:** `%APPDATA%\BedrockServerReplay` (`deleteAppDataOnUninstall: false`); реплеи подхватываются после новой установки
- [ ] Лог с подсветкой `.play` / `.live` / ошибок
- [ ] Финальное короткое имя бренда

### Replay (по необходимости)

- [x] **Ghost руки через RAW** (запись SB `mob_equipment` + patch entity id на PLAY) — 1.0.64; нужна перезапись
- [x] **Ghost броня** из `inventory_content` (window=armor) → RAW `mob_armor_equipment` — 1.0.65 (Replay 9+ уже ок)
- [ ] Высота камеры / eye offset при possess
- [ ] Стабильность скинов / `player_list` на краях версий
- [ ] Горячие клавиши + рука в `.me` без компромисса (если найдётся способ)
- [ ] `.play` без in-place (PLAY-порт) — если понадобится на Android-only

### Продукт дальше

1. **Android-only APK** — каркас + mobile hub; нужна сборка в Android Studio
2. Автообновление Setup.exe
3. ~~Потоковая загрузка длинных реплеев~~ — heavy pkt bodies на spill + `.meta.json`; seek по лёгкому индексу

---

## Не трогать без запроса

- Дизайн mid-session recording (запись только с `.start`)
- `.medebug` / mepath P2–P8, Latite / calib
- Отдельный spectator HUD / крестик
- Возврат `client.write` ghost-equip без доказанного RAW-пути

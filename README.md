# Bedrock Server Replay

**v1.1.0**

Packet record & replay for Minecraft: Bedrock Edition (server sessions).  
Запись и просмотр реплеев Minecraft Bedrock (серверные сессии).

### Supported versions / Поддерживаемые версии

| Range / Диапазон | Features / Возможности |
|------------------|------------------------|
| **≥ 1.19.50** | Full: freecam + spectator + `.me` / `.spec` |
| **1.16.201 – 1.19.40** | Freecam only (no possess) |
| **&lt; 1.16.201** | Not supported / не поддерживается |

Client version in the app must match your Minecraft. Hotfixes with the same protocol (e.g. 1.26.33 → 1.26.30) are OK.  
Версия в приложении должна совпадать с Minecraft. Хотфиксы с тем же протоколом — нормально.

---

## English

### Download

Binaries are in **[Releases](https://github.com/BossBranch/bedrock-replay/releases)**:

| Platform | File |
|----------|------|
| Windows | `Bedrock-Server-Replay-Setup.exe` |
| Android | `BedrockServerReplay-1.1.0.apk` |

### Quick start

1. Install / open the app, set the real server address and Bedrock version.
2. In Minecraft → Servers:
   - **Live** → your PC/phone IP, port **19132** (record)
   - **Play** → same host, port **19133** (replay)
3. Join **Live** → start recording → play on the server → open the replay on **Play**.

Comments and feedback: use **Issues** on this repo.

### Credits

Idea of a Bedrock proxy that records and replays gameplay was inspired by  
[brokiem/BedrockReplay](https://github.com/brokiem/BedrockReplay) (Java).  
This project is a separate implementation (PC launcher + Android), not a fork.

---

## Русский

### Скачать

Сборки лежат в **[Releases](https://github.com/BossBranch/bedrock-replay/releases)**:

| Платформа | Файл |
|-----------|------|
| Windows | `Bedrock-Server-Replay-Setup.exe` |
| Android | `BedrockServerReplay-1.1.0.apk` |

### Быстрый старт

1. Установи / открой приложение, укажи адрес сервера и версию Bedrock.
2. В Minecraft → Серверы:
   - **Live** → IP ПК/телефона, порт **19132** (запись)
   - **Play** → тот же хост, порт **19133** (просмотр)
3. Зайди на **Live** → начни запись → поиграй → смотри реплей на **Play**.

Комментарии и баги — в **Issues**.

### Благодарности

Идея прокси-записи/просмотра Bedrock вдохновлена проектом  
[brokiem/BedrockReplay](https://github.com/brokiem/BedrockReplay) (Java).  
Это отдельная реализация (лаунчер для ПК + Android), не форк.

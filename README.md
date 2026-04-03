# MessageToForum

**MessageToForum** ist ein Node.js-Bot, der lange Discord-Nachrichten automatisch in ein Forum postet. Ideal, um den in Discord entstehenden Content auch in Foren sichtbar zu machen.

## Funktionen

- Längere Nachrichten (>= 1500 Zeichen) werden automatisch ins Forum übertragen.
- Reply-Funktion: Nachrichtenbezug wird übernommen, um Kontext zu wahren.
- Optionale Debug-Anzeige (`DEBUG=true` in der `.env`).
- Forum-Login sicher über `.env`-Variablen.

## Installation

1. Repository klonen:
```bash
git clone git@github.com:Lissaminka/MessageToForum.git
cd MessageToForum
````

2. Abhängigkeiten installieren:

```bash
npm install
```

3. `.env` anlegen (siehe `.env.example`) und Token/Passwörter eintragen.

4. Bot starten:

```bash
node index.js
```

5. Optional: Express-Server starten:

```bash
node server.js
```

## Konfiguration

Die wichtigsten Einstellungen liegen in der `.env`:

```env
# Discord
DISCORD_TOKEN=dein_discord_token

# Forum
FORUM_USERNAME=dein_forum_username
FORUM_PASSWORD=dein_forum_passwort

# Optional
DEBUG=false
PORT=3000
```

## Lizenz

Dieses Projekt ist quelloffen unter der MIT-Lizenz.

```

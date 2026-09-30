# Mac app

Jarvis Voice for Mac is a regular Mac app with a window, a Dock icon and a menu bar icon. It runs the hub, connects your agents with one click, and lets you change everything without a terminal.

The window has seven sections:

- **Overview**: whether Jarvis is listening, On / Quiet / Off, today's counts, the last thing it said, and every agent session from the last 24 hours (amber needs you, blue working, green done, red error).
- **Agents**: Claude Code, Codex and Claude Desktop, each with Connect / Disconnect, the file it edits, and per-agent mute, name, voice and minimum turn length.
- **Voice**: provider order, the Smallest.ai voice browser with search, filters and a play button, model, speed, OpenAI and macOS voices, language, and who writes summaries (including "No summaries" if nothing should leave your Mac).
- **Quiet**: quiet or off for a while, and daily quiet hours with what may still speak.
- **API Keys**: paste, test or remove keys, or point Jarvis at an existing `.env`. Saved keys are never shown again.
- **Activity**: a readable log with repeats folded together and filters for spoken, kept quiet and problems.
- **General**: open at login, show in Dock, the settings and log files, and update checks.

The menu bar icon stays for quick access: the popover shows sessions, the mode switch, Stop, Test and **Open app**, and the count of sessions waiting on you sits next to the icon. Closing the window keeps Jarvis running; quit from the app menu (⌘Q) or the menu bar. Turn off **Show in Dock** in General to keep it only in the menu bar. When it starts at login it stays in the menu bar until you open it.

The app and the CLI share `~/.jarvis-voice`: config, voices, mode, quiet hours and the session list. Anything you set with `jarvis …` shows up in the app, and the reverse.

## Install

Download `Jarvis Voice-<version>-universal.dmg` from the [releases page](https://github.com/AdityaVernekar/jarvis-voice/releases) and drag the app to Applications.

The build is ad-hoc signed, not notarized, so macOS blocks it the first time you open it:

1. Open Jarvis Voice. macOS says it can't verify the developer. Click **Done**.
2. Open **System Settings → Privacy & Security**, scroll to Security, and click **Open Anyway** next to "Jarvis Voice was blocked".
3. Open the app again and confirm.

On macOS 14 and earlier, right-click the app and choose **Open** instead. If you'd rather clear the flag from a terminal: `xattr -dr com.apple.quarantine "/Applications/Jarvis Voice.app"`.

## Connect your agents

Open **Agents** and click **Connect** next to each agent (the popover's **Connect your agents** does all of them at once). Every connection edits one file and keeps a backup next to it.

- **Claude Code** and **Codex** get hooks that point at `~/.jarvis-voice/bin/jarvis-hook`. If a Codex `notify` command is already configured, it is kept and Jarvis forwards every event to it. Restart open sessions afterwards.
- **Claude Desktop** has no hooks, so Jarvis adds a small MCP server named `jarvis-voice` to `claude_desktop_config.json`. It gives Claude one tool, `jarvis_notify`. Claude calls it at the end of a reply that did real work, or when it stops to ask you something, and writes the spoken line itself, so the chat isn't sent anywhere for a summary. Quit and reopen Claude Desktop after connecting. Each call shows up in the chat as a tool call; you can set it to always allow. It works in chats and Cowork. Whether the Code tab also runs your `~/.claude` hooks depends on the Claude Desktop version; the Activity page shows it if it does.

If you set up hooks earlier with `jarvis install`, connecting from the app replaces them, so you won't hear every line twice. Running `jarvis install` later keeps hooks on the app. To point them back at a CLI checkout, run `jarvis install --node`.

## API keys

An app started from Finder or at login doesn't see variables exported in `~/.zshrc`. Paste keys in **API Keys**, which saves them to `~/.jarvis-voice/.env` (readable only by you), or write that file yourself:

```bash
SMALLEST_API_KEY=...
OPENAI_API_KEY=...
```

To keep them somewhere else, click **Choose…** under "Use an existing .env file", or run `jarvis env /path/to/.env`. Environment variables win over that file, and that file wins over keys saved in the app; the page warns you when a saved key is not the one being used. It only records the path and lists which keys it found; your hooks are not touched. With no keys, Jarvis uses the macOS voice and the first sentence of each message.

## How it works

The app listens on a Unix socket, `~/.jarvis-voice/hub.sock` (readable only by you). Each hook runs the `jarvis-hook` shell script, which posts the event to the socket with `curl` and returns in a few milliseconds. The app summarises and speaks it. When the app isn't running, the script runs the bundled Jarvis core with the app's own runtime (`ELECTRON_RUN_AS_NODE=1`), so pings keep working. A hook never fails your agent: the script always exits 0.

`jarvis serve` runs the same hub from a terminal, and `jarvis install --hub` points hooks at the same script. That's useful on a machine without the app. Only one hub runs at a time. If `jarvis serve` is already running, the app shows a warning and hooks keep going through the running hub.

`npm run bench` in `app/` compares hook latency through the socket with a cold Node start.

## Build it yourself

```bash
cd app
npm install
npm start            # run from source
npm run dist         # universal DMG and zip in app/dist
npm run dist:arm64   # Apple silicon only, faster
```

Releases are built by `.github/workflows/app-release.yml` whenever an `app-v*` tag is pushed.

## Not in this version

- Auto-update. macOS only installs updates for Developer ID signed apps, so **Check for updates** in General links to the releases page instead.

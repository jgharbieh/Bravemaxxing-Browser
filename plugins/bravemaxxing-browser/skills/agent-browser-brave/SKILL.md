---
name: agent-browser-brave
description: How to drive the user's own Brave browser well with the agent-browser CLI: where to work (your own tab group, a tab the user hands you, or a separate hidden browser), how to act on pages reliably (snapshot, click, type, hover, drag, double-click), and how to stay out of the user's way. Use for any browsing, form filling, scraping, testing or "watch it happen" request.
allowed-tools: Bash(agent-browser:*), Bash(brave-agent-ready:*), Bash(agent-tab:*), Bash(tab-status:*)
---

# Driving Brave

You drive the user's real Brave with the `agent-browser` CLI. A small relay sits between you and Brave so
that nothing you do takes their focus, and so that you only ever see tabs that are yours. The user decides
where you work, in plain words. Your job is to drive well.

## 1. Start

```bash
brave-agent-ready                                     # checks Brave and the relay; prints "Brave ready"
export AGENT_BROWSER_CDP_HEADERS='{"X-Agent":"<your agent name>"}'   # once per shell, if not already set
```

Use one session name for your work: `agent-browser --session <your agent name> <command>`.
If `brave-agent-ready` says Brave's debugging port is down, do not restart Brave: tell the user to run
`BRAVE_RELAUNCH_OK=1 brave-agent-ready` (it closes and restores their windows, so it is their call).

## 2. Where to work: follow what the user said

| The user says | Do this |
|---|---|
| Nothing about where ("look this up", "apply here", "test this flow") | Your own tabs. They appear in a tab group with your name in the user's window. |
| "In my tab", "this page", "the form I have open", "take over" | That tab, once it is yours (see below). |
| "Use a separate browser", "don't touch my Brave", or bulk scraping that needs no login | The separate hidden browser (section 6). |

Say in one line which one you are using. Do not ask unless the choice changes the result.

**Your own tabs.** Open the first page with `agent-browser --session <name> open <url>` (it uses the blank tab
the session starts with). Open more with `tab new <url>`. They open in the background and join your tab group.

**A tab of the user's.** You cannot see the user's tabs until one is handed to you. Two ways:
- They drag the tab into your tab group. It then shows up in `agent-browser --session <name> tab`.
- They tell you to take it. Run `tab-status claim --agent <name> --match "<words from the title or URL they named>"`.
  It hands you that one tab and prints its id. If it says several tabs match, use more exact words or ask
  them to drag the tab into your group. You are never shown a list of their tabs.

Bind with `agent-browser --session <name> tab <id>` and confirm with `get url` before you act.
When they drag it out of the group, or you run `tab-status release --agent <name> --tab <id>`, it is theirs
again and you can no longer see it. Give a tab back when you are done with it.

## 3. The loop that works

```bash
agent-browser --session <name> snapshot -i        # interactive elements, each with a ref like @e3
agent-browser --session <name> click @e3          # act by ref
agent-browser --session <name> snapshot -i        # look again before the next step
```

- Refs belong to the snapshot they came from. After anything that changes the page, snapshot again.
- Check that an action landed (new URL, new text, field value) before you build on it. If you are unsure
  whether a click or submit went through, read the page; do not repeat it.
- Wait for the page, not for a timer: `wait --text "..."`, `wait <selector>`, `wait --load networkidle`.
- Read with `get text <sel>`, `get value <sel>`, `get url`, `get title`. Screenshot only when layout matters.

| Need | Command |
|---|---|
| Type into a field | `fill @e2 "text"` (replaces), `type @e2 "text"` (appends) |
| Keys | `press Enter`, `press Control+a` |
| Hover (menus, tooltips) | `hover @e4` |
| Double-click | `dblclick @e4` |
| Drag and drop | `drag @e5 @e9` |
| Dropdown, checkbox | `select @e6 "Option"`, `check @e7`, `uncheck @e7` |
| Scroll | `scroll down 600`, `scrollintoview @e8` |
| Upload a file | `upload <sel> /absolute/path` (never click a button that opens the system file picker) |

A ref or a CSS selector (`"#id"`, `".class"`) both work. The CLI's own reference is always current:
`agent-browser skills get core`.

## 4. Being a good guest in someone's browser

- **Never take focus.** There is no "bring to front" step. If you need the user, say so in chat and name the
  tab by its title. The status emoji in the title (🤖 acting, ✅ action done, ⏸️ turn over) shows them the rest.
- **Keep your group small.** Reuse a tab with `open <url>` instead of opening another. Close each tab when you
  are done with it (`tab` lists them, `tab close <tN>`). `agent-browser` cannot close a session's last tab, so
  finish with `tab-status close --agent <name>`: it closes every tab you opened and leaves handed-over tabs alone.
  End a task with only the tabs the user needs to see.
- **Only your tabs.** After every `tab <id>` and after anything that opens a tab, run `get url` and check it
  is the page you expect. If it is not, stop and rebind; do not act.
- **Leave their things alone.** Never set tab titles by hand, never move or rename tab groups, never open
  the password manager or click its pop-ups. The user signs in by hand; you reuse the session.
- **Stop at bot checks.** CAPTCHA or "verify you are human": stop on that site and tell the user. Never solve
  or work around one.

## 5. When something is in the way

| What you see | What to do |
|---|---|
| `Session with given id not found`, `Page.enable` errors | `agent-browser --session <name> close`, then run the command again. |
| `agent wall: not an agent tab` | The tab is not yours (or was taken back). Open your own or ask for it. |
| `blocked by agent wall` | That site or extension is on the user's wall list. Do not look for another way in. |
| A browser dialog (alert, print, file picker, permission prompt) | The relay cannot answer it. Tell the user which tab; do not retry. |
| The page went blank or reloaded after a pause | Brave put the background tab to sleep. Check `get url` and the page state, then continue. |
| `brave-agent-ready` fails | Read its message. It names the fix. |

Never connect to Brave's own debugging port (9222). The relay (9333, the default) is the only way in.

## 6. The separate hidden browser

For work that should not touch the user's Brave at all:

```bash
agent-browser --config ~/.bravemaxxing/agent-browser-headless.json --session <name>-sep open <url>
```

It is a clean browser with no logins, invisible unless you add `--headed`. Everything in section 3 works the
same. If the config file does not exist yet, create it once with the content `{}` (an empty config makes
`agent-browser` start its own browser instead of using the relay). Close it when done: `agent-browser --config ~/.bravemaxxing/agent-browser-headless.json --session <name>-sep close`.

## The wall

The user lists walled extensions and sites in `~/.bravemaxxing/config.json` (default: their password manager).
A hook refuses commands that name them, the relay refuses to navigate to or script them, and any tab of
yours that lands on one is closed. It is a tripwire for cooperating agents, not a security boundary.

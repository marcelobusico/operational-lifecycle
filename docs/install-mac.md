# Install LifeCycle on your Mac

This guide takes you from a Mac with nothing installed to LifeCycle open in your browser. It takes
about 15 minutes and you don't need to be technical. You'll copy and paste **one** line.

LifeCycle runs **on your own Mac** and you use it in your browser at http://lifecycle.localhost:4317. It is
not hosted anywhere and no server or cloud account is created. Your GitHub access is saved only on
your Mac.

## Before you start

- **A Mac with an Apple chip (M1 or newer)** on macOS 13.5 (Ventura) or newer. Apple menu  →
  *About This Mac* shows both (the installer calls these chips "Apple Silicon").
  (The installer also picks the right files for Intel Macs, but we have not tested LifeCycle on one yet.)
- **A GitHub account that can see your team's shared feature repo** (LifeCycle-Data, see the
  README's *Create your shared repo*). If you can open it on GitHub while signed in, you're set. If
  GitHub shows "404", ask its owner to invite your GitHub user, then accept the invitation GitHub
  emails you.
- **Internet access.** The installer downloads about 60 MB.
- You **don't** need an admin password, Homebrew, git, Xcode or Node.js. If you already have any of
  them, they are left exactly as they are.

## 1. Download LifeCycle

1. Open https://github.com/marcelobusico/operational-lifecycle (sign in if asked).
2. Click the green **Code** button, then **Download ZIP**.
3. Open your **Downloads** folder. Safari unzips the file for you. In Chrome or Firefox, double-click
   `operational-lifecycle-main.zip` to unzip it.

**It worked when** your Downloads folder has a folder named **operational-lifecycle-main**.
**If not:** check the address and try again.
If the folder has another name (e.g. `operational-lifecycle-main 2`, because you downloaded it before), that
is the folder you just unzipped: in step 2, go into that one by putting its name in quotes, e.g.
`cd ~/Downloads/"operational-lifecycle-main 2" && ./install.sh`.

## 2. Run the installer

1. Open **Terminal**: press **⌘ Command + Space**, type `Terminal`, press **Return**.
2. Copy this line, paste it into Terminal (**⌘ Command + V**) and press **Return**. It goes into
   the LifeCycle folder you unzipped and runs the installer there:

   ```bash
   cd ~/Downloads/operational-lifecycle-main && ./install.sh
   ```

3. If macOS asks *"Terminal would like to access files in your Downloads folder"*, click **Allow**.

The installer shows six steps. Each one ends with a green **✓** line when it worked. If a step
fails, it stops with a red **✗** that names the step, says what went wrong and what to do. Nothing
else on your Mac is changed, and you can run the same line again once it's fixed.

| Step | What it does | It worked when you see | If it fails |
|---|---|---|---|
| 1. Check this Mac | Checks your macOS version and chip | `✓ macOS … on Apple Silicon (M1 or newer)` | *needs macOS 13.5*: update macOS in System Settings → General → Software Update |
| 2. Copy LifeCycle onto this Mac | Copies the files into `~/.lifecycle/app` | `✓ LifeCycle's files are in …` | Usually a full disk: free some space and run again |
| 3. Get Node.js | Downloads Node.js from nodejs.org (about 50 MB) into a private folder, `~/.lifecycle/runtime`, and checks that it is the official file | `✓ Node.js v24… installed … (your PATH and any other Node.js are untouched)` | *Could not reach the Node.js download site*: check your internet; on a company VPN or network that blocks downloads, switch networks or ask IT to allow **nodejs.org** |
| 4. Install LifeCycle's libraries | Downloads the two small libraries LifeCycle uses | `✓ Libraries installed` | *Could not download … from the npm registry*: same as above, for **registry.npmjs.org** |
| 5. Connect to GitHub | Asks two questions (below) | `✓ Connected to GitHub as <you>` | See [Setup questions](#setup-questions). If GitHub can't be connected yet, the install still finishes (see *Almost done* below) |
| 6. Start LifeCycle and open it | Sets LifeCycle to start when you log in, adds **LifeCycle** to your Applications, starts it and opens your browser | `✓ LifeCycle is running at http://lifecycle.localhost:4317` and the browser opens | *Another program is using port 4317*: restart the Mac and run the line again. Otherwise the message shows the last lines of the log |

At the end you see **✓ LifeCycle is installed.** and LifeCycle opens in your browser, showing your
projects and roadmap.

If instead you see **! Almost done: LifeCycle is installed, but not connected to GitHub yet**,
LifeCycle is running but your roadmap stays empty until GitHub is connected. Copy the line it shows
(`~/.lifecycle/bin/lifecycle setup`), paste it, and answer the two questions (below).

macOS may show a notification **"Background Items Added"**. That is LifeCycle setting itself to
start when you log in. It's expected; leave it on.

## Setup questions

Setup asks only two things, in plain words, and saves the answers on your Mac. Where it shows
an answer in `[brackets]`, pressing **Return** keeps that answer.

1. **Shared feature repo**: the GitHub repo where your team keeps its list of features, as
   `owner/name` (for example `your-org/LifeCycle-Data`). You can also paste its GitHub link. The
   first time there is no default; on later runs, **Return** keeps the one shown.
2. **GitHub access**: LifeCycle needs your permission to read your team's features on GitHub.
   - Engineers who already use the GitHub command-line app are asked whether to use it. Press
     **Return** for yes. (If you've never heard of it, you won't see this question.)
   - Everyone else makes a **GitHub token**, a password just for LifeCycle. Setup shows a link
     and offers to open it: press **Return** and the page opens in your browser with everything
     pre-filled. (If it doesn't open, ⌘ Command-click the link in Terminal.) Pick an expiration
     (90 days is fine), scroll down, click **Generate token**, and copy the token (it starts with
     `ghp_`). Go back to Terminal, paste it with **⌘ Command + V** and press **Return**.
     **Nothing appears while you paste. That's normal, so paste only once.**

| You see | What it means | What to do |
|---|---|---|
| `✓ Connected to GitHub as <you>. You can read …` | All good | Nothing |
| `! GitHub did not accept that token` | The token was cut short or has expired | Copy it again (or make a new one) and paste it. You get three tries |
| `! Connected to GitHub as <you>, but you can't see …` | Your user hasn't been invited to the shared repo | Ask its owner to invite you and accept the email. LifeCycle shows the features once you can see the repo. No need to redo setup |
| `! Could not reach GitHub` | No internet right now | Your answer is saved. LifeCycle uses it once you're online |

Then setup offers **optional extras**: feature flags (your team's platform, **Statsig** unless the
shared repo's `team.yaml` says otherwise), AI answers, and your owner names for the digest. Press
**Return** to skip them. You can add them any time. Even when you skip, setup tells you which
platform LifeCycle will read flags from and how to add your key later.

**Feature flags (Statsig).** In the extras, press **Return** at `Flag platform … [statsig]`. Setup
then asks only for a Statsig **Console API key**, the one that starts with `console-`:

1. Open https://console.statsig.com/api_keys (Settings → Keys & Environments).
2. Under **Console API Keys**, click **Generate New Key**. Read-only is enough.
3. Copy it and paste it in Terminal (nothing shows while you paste).

Don't use the **Server Secret key** (`secret-…`) or the **Client SDK key** (`client-…`): Statsig
won't accept them here, and setup tells you so.

| You see | What it means | What to do |
|---|---|---|
| `✓ Connected to Statsig: N feature gates readable` | All good | Nothing |
| `! That is a Server Secret key (secret-…), not a Console API key` | You copied the wrong key | Make a Console API key (steps above) and paste it |
| `! Statsig refused your Console API key` | The key was revoked, expired or is from another project | Make a new Console API key and paste it |
| `! Statsig could not be reached` | No internet, or Statsig is down | Your key is saved. LifeCycle uses it once Statsig answers |

If your team uses Flagsmith instead of Statsig, type `flagsmith` at the platform question.

**To change any answer later** (another repo, a new token when the old one expires, the extras),
paste this in Terminal:

```bash
~/.lifecycle/bin/lifecycle setup
```

Add `--extras` to go straight to the optional extras. Your current answers are shown in
`[brackets]`. Press **Return** to keep each one.

## Every day, and after a reboot

**You don't need to do anything.** LifeCycle starts on its own when you log in to your Mac. To open
it, do **one** of these:

- Open **LifeCycle** from Spotlight (**⌘ Command + Space**, type `LifeCycle`, **Return**). That's
  the easiest way. (The app sits in the *Applications* folder inside your home folder, not the main
  Applications folder.) Or
- go to **http://lifecycle.localhost:4317** in your browser (bookmark it).

Opening the **LifeCycle** app also starts LifeCycle if it was stopped.

Other things you can paste in Terminal:

| Command | What it does |
|---|---|
| `~/.lifecycle/bin/lifecycle status` | Is it running? Which version? |
| `~/.lifecycle/bin/lifecycle stop` | Stop it until you next log in |
| `~/.lifecycle/bin/lifecycle start` | Start it again |
| `~/.lifecycle/bin/lifecycle logs` | Last lines of its log, if something looks wrong |

**It isn't running after a reboot?** Check System Settings → General → **Login Items &
Extensions**: under *Allow in the Background*, the switch for LifeCycle must be on. (It may be
listed as **node**, which is the engine LifeCycle runs on.)
Then open the LifeCycle app.

## Update to a new version

Your settings, GitHub access, history and logs in `~/.lifecycle` are kept. Use any of these:

- **From the app (easiest):** click **Check for updates** at the bottom left of the sidebar, just
  above **Theme** (in the narrow icon bar it is the circular-arrow icon). LifeCycle checks once each
  time you open it and shows a small green dot on that button when a newer version is on GitHub.
  Clicking it shows the result: **Up to date** (with the commit you run and its date), **N updates
  available** (with each change's title and a link to view the changes on GitHub), or why it
  couldn't check (offline, no access to the LifeCycle repo, GitHub not connected) and what to do.
  **Update now…** asks you to confirm, then downloads the newest `main`, installs its libraries
  with LifeCycle's private Node.js and restarts LifeCycle; the page reconnects on its own. If a step
  fails, the version you had stays in place and keeps running, and the message names the step. If
  the newest version's GitHub Actions checks failed or are still running, you are warned before
  you confirm. A copy installed before this button existed shows **Installed version unknown**;
  updating once records the version from then on.
- **In Terminal:** paste `~/.lifecycle/bin/lifecycle update`. It downloads the newest
  LifeCycle from GitHub with your saved access and re-runs the installer.
- **By hand:** download the ZIP again (step 1; delete the old `operational-lifecycle-main` folder first) and
  paste the same line from step 2, `cd ~/Downloads/operational-lifecycle-main && ./install.sh` (if the new
  folder got another name, use that one, as in step 1).

The installer skips the setup questions because you already answered them. Node.js is only
downloaded again when there is a newer one (the in-app update keeps the Node.js you have; the
Terminal update and the installer also refresh it).

Every install and update records the `main` commit it runs in `~/.lifecycle/app/installed-commit.json`
(a GitHub ZIP knows its commit; see `.lifecycle-source`). Each check and update writes one line to
`~/.lifecycle/logs/updates.log` with the from/to commits and the outcome.

## Uninstall

Paste this in Terminal:

```bash
~/.lifecycle/bin/lifecycle uninstall
```

It asks **"Keep your settings so a later reinstall picks them up?"**:

- **Return (yes)** removes LifeCycle, its private Node.js, the start-at-login entry and the
  LifeCycle app, and **keeps** your settings and GitHub access in `~/.lifecycle`. A reinstall picks
  them up without asking again.
- **n** removes all of that **and** your settings, GitHub access and local history (the whole
  `~/.lifecycle` folder).

To skip the question, add `--keep-settings` or `--remove-settings`. Nothing else on your Mac is
touched. If you made a GitHub token for LifeCycle, you can also revoke it at
https://github.com/settings/tokens.

## For IT and engineers (you can skip this)

The sections below explain what the installer does on the machine. You don't need them to install
or use LifeCycle.

### If you already have Node.js or Homebrew

You don't need to change anything. LifeCycle uses its **own private Node.js**, in
`~/.lifecycle/runtime`:

- It is **not** added to your PATH, and your shell settings (`.zshrc`, `.zprofile`) are not
  edited. Typing `node` in Terminal still runs whichever Node.js you had before, at the same
  version. That's true for older versions too (e.g. Node 18 from nvm or Homebrew).
- Homebrew, nvm, Volta and global npm packages are not touched. The installer never uses `sudo`.
- Uninstalling removes only LifeCycle's private copy.

Engineers who prefer their own Node.js 20+ can still use the manual way in the
[README](../README.md#install-for-developers) (`npm install`, `npm run setup`, `npm start`).

### What gets downloaded, and from where

Only during install and update:

| From | What |
|---|---|
| github.com | LifeCycle itself (the ZIP, the app's **Check for updates**, or `lifecycle update`, with your access) |
| nodejs.org | The official Node.js for your chip, checked against nodejs.org's published checksum |
| registry.npmjs.org | LifeCycle's two libraries (`yaml`, `@anthropic-ai/sdk`) |

While you use it, LifeCycle serves its pages **only from your Mac**: it listens on 127.0.0.1, so
other computers can't reach it. It only connects out to read your sources with your own access
(GitHub, plus Flagsmith or an AI provider if you set them up), and once each time you open it
asks GitHub for the newest commit of LifeCycle's `main` to show the update marker. Nothing is
published or hosted. Updates can only be started from LifeCycle's own page on your Mac.

### What is installed where

| Where | What | Removed by uninstall |
|---|---|---|
| `~/.lifecycle/app` | LifeCycle's code | Yes |
| `~/.lifecycle/runtime` | Private Node.js | Yes |
| `~/.lifecycle/bin/lifecycle` | The `lifecycle` command | Yes |
| `~/Library/LaunchAgents/com.lifecycle.server.plist` | Starts LifeCycle when you log in | Yes |
| `~/Applications/LifeCycle.app` | Opens LifeCycle in your browser | Yes |
| `~/.lifecycle/config.json`, `credentials.json`, `cache/`, `history/`, `logs/` | Your settings, GitHub access (readable only by you), local history and logs | Only if you choose to remove settings |

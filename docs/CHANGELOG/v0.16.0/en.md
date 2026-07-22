---
title: Open Design 0.16.0
description: Choose the direction, keep the work, and ship with a creative loop you can trust.
---

# Open Design 0.16.0 — The Confident Creative Loop

🎨 **92 PRs · 20 contributors · 5 days** — **Choose the direction, keep the work, and ship without second-guessing the path.** Visual guidance used to stop at a couple of artifact types; provider setup could look healthy and still fail at the first prompt; a long run or an update could finish with the wrong thing left behind. 0.16.0 closes that loop—from choosing the look to reopening the app that delivers it.

## 🔥 Highlights

- 🎨 **Visual direction now follows the thing you are actually making.** Decks and prototypes no longer own the style conversation. Documents, posters and other images, videos, Web Clones, wireframes, mobile work, and Hyperframes each get an artifact-appropriate preview catalog—with four quick choices inline and the full library one click away. (#5746)

- 🔔 **Product news now has a home inside Open Design.** A new bell in the Home and project headers opens a persistent message center with unread counts, filters, mark-all-read, safe actions, and read state that survives anonymous use or follows a signed-in account. Dates use your locale, and the close action no longer hides until hover. (#5920, #5954, #5959, #5968) Thanks @nettee.

- 🔄 **Updates keep the whole packaged app on the same generation.** The macOS application menu now gives “Check for Updates…” a proper home and a flow that explains whether you are current, downloading, ready to restart, blocked by active work, or better served by a manual download. Underneath, historical launchers hand ownership to the active payload, stale or hidden outer processes are retired, and payload cleanup no longer invalidates the next launch—across macOS and Windows. (#5789, #5766, #5678, #5915, #5940, #5955, #5967) Thanks @PerishCode.

- 🔑 **BYOK catches a broken setup before it becomes a broken run.** Incomplete provider edits stay recoverable drafts instead of replacing a working configuration. Connection tests follow the same route as a real run, surface the provider error they already know about, preserve the provider’s model ordering, and normalize versionless Anthropic-compatible endpoints for MiniMax, DeepSeek, and MiMo. (#5745, #5712, #5713, #5774, #5807) Thanks @Siri-Ray, @mturac.

- 🧠 **Long runs keep their answer—and the file that came with it.** Near-limit native sessions start fresh with the newest useful context before the provider ceiling becomes a failure. Early artifacts survive chatty event histories, recovered sub-agents no longer paint the parent result red, interrupted turns settle truthfully after restart, and failures that cannot recover stop with a useful diagnosis instead of burning another loop. (#5816, #5850, #5845, #5817, #5882) Thanks @Siri-Ray, @tomsen02.

- 🖼️ **Image generation bends without breaking.** Nano Banana and custom-image now respect short provider back-pressure and retry once, while `gpt-image-*` reference-image edits stop sending a parameter the endpoint rejects. A brief 429 or 503 becomes a pause, not a lost creative turn. (#5702, #5760) Thanks @Siri-Ray, @xxiaoxiong.

- 🧩 **Start from what people actually use.** Slides, image, video, and other non-prototype galleries now lead with templates that have earned real usage, while blank seeds and cards without previews stop crowding the top. Prototype keeps its editorial showcase; every facet keeps its full catalog. (#5106, #5881) Thanks @ScarletttMoon.

- 🧬 **Design-system inputs are allowed to look like real repositories.** Repo-only intake no longer wanders into website extraction, split-token packages can keep layout tokens in their companion stylesheet, and common YAML list and multiline forms retain the metadata their authors wrote. (#5779, #5797, #5499) Thanks @mturac, @MuduiClaw, @EthanGuo-coder.

- 🪟 **Previews spend less time making you fight the frame.** Wide desktop pages fit the pane until you choose your own zoom; history decks take navigation keys immediately; rewritten root HTML opens when the turn ends; and a security-blocked asset explains which project path failed without exposing where a symlink points. (#5751, #5755, #5577, #5784) Thanks @lefarcen, @maxmilian, @mturac.

- 🛡️ **Local power now has tighter local boundaries.** Imported projects cannot expose hidden credential files, plugin uninstall cannot escape its registry, marketplace fetches cannot pivot into private services, stored site captures cannot replay third-party scripts, and one project’s conversation cannot be wired into another project’s run. (#5857, #5855, #5880, #5503, #5813) Thanks @tomsen02, @wiggdevin.

## ✨ Added

### 🚀 Deployment and integrations

- **Preview before you publish.** Cloudflare Pages deployment now exposes Preview and Production as explicit targets in both the interface and `od deploy --target … --json`. Preview returns its own URL without replacing the live production hostname. (#4576) Thanks @cbeaulieu-gt.

- **Kiro joins the MCP setup picker.** Copy the correct shared-server snippet from Settings and move it into Kiro’s configuration without translating another client’s format by hand. (#5275) Thanks @BusanGukbap.

## 🔁 Changed

### 🔑 Models, media, and memory

- **The model list follows the provider, not the alphabet.** Live catalog ordering is preserved, stale Moonshot and DeepSeek defaults move to available preferred IDs, and Settings and onboarding share one source of truth. (#5774) Thanks @Siri-Ray.

- **Memory can use the MiniMax key you already saved.** Text-capable media credentials no longer look missing, while image- or audio-only providers get an honest unsupported message and useful next steps. (#5767) Thanks @lefarcen.

- **Provider mode changes look changed.** Switching to BYOK updates the composer icon immediately, and a Local CLI custom model field stays empty when you clear it. (#5379, #5749) Thanks @yashrao2607, @jzhishu.

## 🐛 Fixed

### 🧠 Agents and runs

- **MCP follow-ups hear the follow-up.** Reusing a conversation now forwards the latest prompt into the resumed session instead of completing successfully with no new work. (#5851) Thanks @mturac.

- **Restart and persistence edges no longer strand the conversation.** Headless turns can finish even when native-session persistence fails, canceled runs stay canceled after late errors, and interrupted messages no longer remain permanently queued or running after the daemon returns. (#5808, #5904, #5817) Thanks @mturac, @Siri-Ray.

- **Replayed ACP histories lose the empty noise, not the real work.** Protocol-only status frames no longer return as blank expandable rows after refresh. (#5145) Thanks @xxiaoxiong.

- **Older Windows CPUs get a compatible OpenCode runtime.** Machines without AVX2 now receive a baseline build and a direct update path instead of repeating a deterministic illegal-instruction crash. (#5733) Thanks @lefarcen.

### 🖼️ Preview and interface

- **Small visual signals tell the truth again.** Browser-extraction failures keep a visible red surface, the model picker stays on screen, and the Open Design Website Clone example loads its real logo with the first screen. (#5454, #5907, #5765) Thanks @xxiaoxiong, @lefarcen.

## 🙏 Thanks to everyone who shipped 0.16.0

@alchemistklk · @BusanGukbap · @cbeaulieu-gt · @EthanGuo-coder · @joeylee12629-star · @jzhishu · @lefarcen · @maxmilian · @mrcfps · @mturac · @MuduiClaw · @nettee · @PerishCode · @ScarletttMoon · @Siri-Ray · @tomsen02 · @VikingOwl91 · @wiggdevin · @xxiaoxiong · @yashrao2607

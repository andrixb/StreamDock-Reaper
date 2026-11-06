# ReaperControl — Setup Guide

This StreamDock plugin gives you channel strips with always-on VU meters for
REAPER, plus FX parameter control and transport. It talks to REAPER over **OSC**
(Open Sound Control) on your local machine:

| Direction                  | Port   |
| -------------------------- | ------ |
| StreamDock → REAPER        | `8000` (REAPER's *local listen port*) |
| REAPER → StreamDock        | `9000` (REAPER's *device port*) |

Until REAPER answers, every key shows an orange **NO REAPER** banner. When the
banner goes away, the connection is working.

## 1. Install the StreamDock plugin

From the `plugin` folder:

```sh
npm install
npm run dev      # development: StreamDock runs the source directly
# or
npm run build    # production bundle copied into StreamDock's plugins folder
```

Then drag **Channel Strip**, **Channel Fader**, **Transport**, **Bank** and
**FX Parameter** onto your StreamDock.

## 2. Set up REAPER (one time, ~1 minute)

### a) Install the pattern file

Either run the Auto-Setup script:

1. REAPER: **Actions → Show action list → New action… → Load ReaScript…**
2. Pick `reaper/ReaperControl Auto-Setup.lua` and run it.
3. It copies `ReaperControl.ReaperOSC` into REAPER's `OSC` folder and opens
   Preferences on the right page.

Or copy `reaper/ReaperControl.ReaperOSC` yourself into:

- macOS: `~/Library/Application Support/REAPER/OSC/`
- Windows: `%APPDATA%\REAPER\OSC\`

### b) Add the control surface

**Preferences → Control/OSC/web → Add → OSC (Open Sound Control)**. If an
`OSC: ReaperControl` entry already exists (older versions of the setup script
wrote one), select it and click **Edit**.

| Field              | Value |
| ------------------ | ----- |
| Device name        | `ReaperControl` |
| Pattern config     | `ReaperControl` |
| Mode               | `Configure device IP + local port` |
| Device port        | `9000` |
| Device IP          | `127.0.0.1` |
| Local listen port  | `8000` |

Click **OK**, then **Apply/OK** in Preferences. You don't need to restart.

> The surface has to be added through the dialog. REAPER rewrites `reaper.ini`
> when it quits, so a script that edits that file directly is not reliable.

## 3. Plugin settings

Every action's settings panel has **Host / Send Port / Receive Port**. These are
global, and the defaults (`127.0.0.1`, `8000`, `9000`) match the table above.
If you change the ports in REAPER, change them here too.

## 4. Actions

### Channel Strip (Keypad)

Track name, volume, live stereo VU meter with peak hold, and MUTE/SOLO/REC/SEL
badges. Pressing the key toggles Mute, Solo or Record Arm, or selects the track.
- **Track Number**: the absolute REAPER track (1–64).
- **Follow Bank** + **Bank Offset**: the key shows track
  `bank × bankSize + offset` and follows the Bank keys.

### Channel Fader (Knob)

Turn for volume (0.5 dB per tick) or pan (2% per tick), press to toggle mute.

### Transport (Keypad)

Play/Stop toggle, Stop, Pause, Record, Metronome, Loop. Keys light up to match
REAPER's state.

### Bank (Keypad)

Next / previous bank of tracks for strips and faders with **Follow Bank** on.

### FX Parameter (Keypad or Knob)

Set **Track / FX / Parameter** numbers (1-based, as in REAPER's FX chain). Turn
to change the value; press to toggle bypass or open the FX window. **Last
Touched** mode displays whatever parameter you last moved in REAPER. It is
display-only, because REAPER's OSC has no message to set that parameter.

## Troubleshooting

- **Keys stay on "NO REAPER"**
  - Check that REAPER is running and the surface uses pattern config
    `ReaperControl`, device port `9000`, and local listen port `8000`.
  - Check that nothing else is using UDP 9000 (`lsof -nP -iUDP:9000` on macOS).
    Only the plugin's `node` process should be listed. TouchOSC and similar
    apps default to the same ports. If there's a clash, pick other ports on
    both sides.
  - Check the plugin log: `plugin/log/<date>.log` should show
    `First message from REAPER received`.
- **Feedback works but buttons don't**: REAPER's local listen port must equal
  the plugin's Send Port.
- **Tracks above 64 don't show**: raise `DEVICE_TRACK_COUNT` in
  `ReaperControl.ReaperOSC` and `MAX_TRACK` in `plugin/index.js`, then
  regenerate the Lua script with `node reaper/build-setup-script.js`.

## For developers

- `reaper/ReaperControl.ReaperOSC` is the source of truth. After editing it, run
  `node reaper/build-setup-script.js` to regenerate the Lua installer, which
  embeds a copy of the file.
- `npm test` (in `plugin/`) runs an end-to-end test against a fake StreamDock and
  a fake REAPER on ports 18000/19000.

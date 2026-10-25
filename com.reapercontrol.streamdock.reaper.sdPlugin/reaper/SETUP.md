# ReaperControl — Setup Guide

This StreamDock plugin gives you channel strips with always-on VU meters for
REAPER, plus FX parameter control and transport. It talks to REAPER over **OSC**
(Open Sound Control).

## Important: why REAPER needs a one-time setup

REAPER does not allow any external program to take control silently — you must
give permission once by adding an OSC control surface. To make this as easy as
possible, ReaperControl includes an **auto-setup ReaScript** that does the work
for you.

## 1. Install the StreamDock plugin

1. Run `npm install` and `npm run dev` in the `plugin` folder (see the main
   project README).
2. Restart the StreamDock app so it sees the new plugin.
3. Drag the **Channel Strip**, **Channel Fader**, **Transport**, **Bank**, and
   **FX Parameter** actions onto your StreamDock.

To publish the plugin for one-click install from the StreamDock marketplace,
use `npm run build` and submit the resulting `.sdPlugin` folder to the Space
Platform at https://space.key123.vip/.

## 2. Run the REAPER auto-setup script

1. In REAPER, open **Actions → Show action list**.
2. Click **ReaScript: Load** and choose `reaper/ReaperControl Auto-Setup.lua`.
3. Run the action.
4. The script will:
   - Copy `ReaperControl.ReaperOSC` into REAPER's OSC folder
   - Add a new OSC control surface called **ReaperControl** with the correct
     ports
   - Ask you to restart REAPER

After restarting REAPER, the connection is ready.

## 3. Configure the plugin

Open any action's settings and set:

- **Host:** `127.0.0.1`
- **Send Port:** `8000`
- **Receive Port:** `9000`

These are saved globally, so you only need to set them once per profile.

## 4. Place actions on your StreamDock

### Channel Strip (Keypad)

Shows a REAPER track with a live VU meter, track name, and Mute/Solo/Rec state.
Press the key to toggle Mute, Solo, Record Arm, or Select (configurable).

- Set **Track Number** to the REAPER track you want.
- Or enable **Follow Bank** and use **Bank Offset** so the key follows the
  current bank.

### Channel Fader (Knob)

Place on a knob to control volume or pan. Press the knob to toggle mute.

### Transport (Keypad)

Play, Stop, Pause, Record, Metronome, or Repeat.

### Bank (Keypad)

Next / Previous bank. Channel strips that follow the bank update automatically.

### FX Parameter (Keypad or Knob)

Control any VST/AU/JSFX parameter. Configure:

- **Track Number**, **FX Number**, **Parameter Number** for a fixed parameter
- Or enable **Last Touched** to follow whatever parameter you last adjusted in
  REAPER

Rotate the knob to change the value; press the key to toggle bypass or open the
FX UI.

## 5. Always-on VU meters

The Channel Strip action renders a fresh VU meter every time REAPER sends level
feedback. REAPER sends VU continuously while audio is playing, so the meter is
always live.

## Troubleshooting

- **No VU meter:** Check that the OSC ports match in both REAPER and the plugin
  settings, and that `ReaperControl.ReaperOSC` is selected in REAPER.
- **Can send but no feedback:** REAPER must have a control surface with the
  plugin's receive port (9000) as its device port. Re-run the auto-setup script.
- **Blank key:** Make sure the action is assigned to a valid track/FX/param.
- **FX parameter not updating:** Make sure the FX Parameter action's
  **Last Touched** mode is on, or that the track/FX/param numbers are correct.

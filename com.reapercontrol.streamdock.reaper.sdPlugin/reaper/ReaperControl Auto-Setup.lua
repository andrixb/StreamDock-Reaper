-- ReaperControl Auto-Setup
-- One-click installer for the ReaperControl StreamDock plugin.
-- Copies the OSC pattern file and adds an OSC control surface to reaper.ini.
-- REAPER must be restarted after running this script.

local SEND_PORT = 8000      -- REAPER listens here for commands from StreamDock
local RECV_PORT = 9000      -- REAPER sends feedback here to StreamDock
local PATTERN_NAME = "ReaperControl.ReaperOSC"
local SURFACE_NAME = "ReaperControl"

local PATTERN_CONTENT = [[# ReaperControl REAPER OSC surface for StreamDock
# This file is normally installed automatically by ReaperControl Auto-Setup.lua.
# Manual location:
#   Windows: %APPDATA%\REAPER\OSC
#   macOS:   ~/Library/Application Support/REAPER/OSC

# Device (this plugin) sends to REAPER on port 8000 (default).
# REAPER sends feedback to the plugin on port 9000 (default).

# How many tracks/sends/FX REAPER should send feedback for.
DEVICE_TRACK_COUNT 16
DEVICE_SEND_COUNT 4
DEVICE_RECEIVE_COUNT 4
DEVICE_FX_COUNT 8
DEVICE_FX_PARAM_COUNT 16
DEVICE_FX_INST_PARAM_COUNT 16
DEVICE_MARKER_COUNT 0
DEVICE_REGION_COUNT 0

# Track feedback / control
TRACK_VU n/track/vu n/track/@/vu
TRACK_VU_L n/track/vu/L n/track/@/vu/L
TRACK_VU_R n/track/vu/R n/track/@/vu/R

TRACK_VOLUME n/track/volume n/track/@/volume
TRACK_VOLUME f/track/volume/db f/track/@/volume/db
TRACK_PAN n/track/pan n/track/@/pan

TRACK_MUTE b/track/mute b/track/@/mute
TRACK_SOLO b/track/solo b/track/@/solo
TRACK_REC_ARM b/track/recarm b/track/@/recarm
TRACK_SELECT b/track/select b/track/@/select

TRACK_NAME s/track/name s/track/@/name

# Master feedback
MASTER_VU n/master/vu
MASTER_VU_L n/master/vu/L
MASTER_VU_R n/master/vu/R

MASTER_VOLUME n/master/volume
MASTER_PAN n/master/pan

# Transport
PLAY t/play
STOP t/stop
PAUSE t/pause
RECORD t/record
REPEAT t/repeat
CLICK t/click

# FX parameters
FX_NAME s/fx/name s/fx/@/name s/track/@/fx/@/name
FX_NUMBER s/fx/number/str s/fx/@/number/str s/track/@/fx/@/number/str
FX_BYPASS b/fx/bypass b/fx/@/bypass b/track/@/fx/@/bypass
FX_OPEN_UI b/fx/openui b/fx/@/openui b/track/@/fx/@/openui

FX_PARAM_NAME s/fxparam/@/name s/fx/@/fxparam/@/name
FX_PARAM_VALUE n/fxparam/@/value n/fx/@/fxparam/@/value n/track/@/fx/@/fxparam/@/value
FX_PARAM_VALUE s/fxparam/@/value/str s/fx/@/fxparam/@/value/str

LAST_TOUCHED_FX_PARAM_NAME s/fxparam/last_touched/name
LAST_TOUCHED_FX_PARAM_VALUE n/fxparam/last_touched/value s/fxparam/last_touched/value/str
]]

function write_file(path, content)
    local f = io.open(path, "wb")
    if not f then return false end
    f:write(content)
    f:close()
    return true
end

function file_exists(path)
    local f = io.open(path, "rb")
    if f then f:close() return true end
    return false
end

function path_sep()
    return reaper.GetOS():match("Win") and "\\" or "/"
end

function backup_file(path)
    local bak = path .. ".reapercontrol.bak"
    local inf = io.open(path, "rb")
    if not inf then return end
    local data = inf:read("*all")
    inf:close()
    local outf = io.open(bak, "wb")
    if outf then
        outf:write(data)
        outf:close()
    end
end

function parse_ini(path)
    local ini = {}
    local section = nil
    local f = io.open(path, "r")
    if not f then return ini end
    for line in f:lines() do
        local sec = line:match("^%[(.+)%]$")
        if sec then
            section = sec
            ini[section] = ini[section] or {}
        elseif section then
            local k, v = line:match("^([^=]+)=(.*)$")
            if k then
                ini[section][k] = v
            end
        end
    end
    f:close()
    return ini
end

function write_ini(path, ini)
    local f = io.open(path, "w")
    if not f then return false end
    for section, keys in pairs(ini) do
        f:write("[" .. section .. "]\n")
        for k, v in pairs(keys) do
            f:write(k .. "=" .. v .. "\n")
        end
        f:write("\n")
    end
    f:close()
    return true
end

function find_reapercontrol_surface(ini)
    local reaper_sec = ini["reaper"] or {}
    local count = tonumber(reaper_sec["csurf_cnt"]) or 0
    for i = 0, count - 1 do
        local cfg = reaper_sec["csurf_" .. i]
        if cfg and cfg:match("^OSC") and cfg:find(SURFACE_NAME, 1, true) then
            return i
        end
    end
    return nil
end

function add_surface(ini)
    local reaper_sec = ini["reaper"] or {}
    ini["reaper"] = reaper_sec

    local count = tonumber(reaper_sec["csurf_cnt"]) or 0
    local idx = count
    reaper_sec["csurf_cnt"] = tostring(count + 1)

    -- flags: &1=receive &2=send &4=bind to actions/fxlearn => 7
    local cfg = string.format('OSC "%s" 7 %d "127.0.0.1" %d 1024 10',
                              SURFACE_NAME, SEND_PORT, RECV_PORT)
    reaper_sec["csurf_" .. idx] = cfg
    return idx
end

-- Main
local res_path = reaper.GetResourcePath("")
local sep = path_sep()
local osc_dir = res_path .. sep .. "OSC"
local pattern_dst = osc_dir .. sep .. PATTERN_NAME
local ini_path = res_path .. sep .. "reaper.ini"

reaper.RecursiveCreateDirectory(osc_dir, 0)

local copied = write_file(pattern_dst, PATTERN_CONTENT)

local ini = parse_ini(ini_path)
local existing = find_reapercontrol_surface(ini)
local added = false

if not existing then
    backup_file(ini_path)
    add_surface(ini)
    added = write_ini(ini_path, ini)
end

local msg = ""
if copied then
    msg = msg .. "Wrote " .. PATTERN_NAME .. " to:\n" .. pattern_dst .. "\n\n"
elseif file_exists(pattern_dst) then
    msg = msg .. PATTERN_NAME .. " is already in:\n" .. pattern_dst .. "\n\n"
else
    msg = msg .. "Could not write " .. PATTERN_NAME .. " to:\n" .. pattern_dst .. "\n"
    msg = msg .. "Please check folder permissions.\n\n"
end

if existing then
    msg = msg .. "A ReaperControl OSC surface already exists (csurf_" .. existing .. ").\n\n"
elseif added then
    msg = msg .. "Added a new ReaperControl OSC surface to reaper.ini.\n"
    msg = msg .. "A backup was saved as reaper.ini.reapercontrol.bak\n\n"
else
    msg = msg .. "Could not update reaper.ini automatically.\n"
    msg = msg .. "Please add the surface manually in Preferences.\n\n"
end

msg = msg .. "Please restart REAPER now.\n"
msg = msg .. "After restart, the StreamDock plugin will connect on ports:\n"
msg = msg .. "  Send to REAPER: " .. SEND_PORT .. "\n"
msg = msg .. "  Receive from REAPER: " .. RECV_PORT .. "\n\n"
msg = msg .. "Keep this .lua file in REAPER/Scripts so the action keeps working."

reaper.ShowMessageBox(msg, "ReaperControl Auto-Setup", 0)

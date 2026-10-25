-- ReaperControl Auto-Setup
-- One-click installer for the ReaperControl StreamDock plugin.
-- Copies the OSC pattern file and adds an OSC control surface to reaper.ini.
-- REAPER must be restarted after running this script.

local SEND_PORT = 8000      -- REAPER listens here for commands from StreamDock
local RECV_PORT = 9000      -- REAPER sends feedback here to StreamDock
local PATTERN_NAME = "ReaperControl.ReaperOSC"
local SURFACE_NAME = "ReaperControl"

function copy_file(src, dst)
    local infile = io.open(src, "rb")
    if not infile then return false end
    local data = infile:read("*all")
    infile:close()
    local outfile = io.open(dst, "wb")
    if not outfile then return false end
    outfile:write(data)
    outfile:close()
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

function dirname(path)
    local sep = path_sep()
    local s = path:match("^(.*)[" .. sep .. "]")
    return s or ""
end

function backup_file(path)
    local bak = path .. ".reapercontrol.bak"
    copy_file(path, bak)
end

-- Parse reaper.ini into a table of sections -> key/value pairs.
-- This is a minimal parser; REAPER's ini is simple key=value under [sections].
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

-- ───────────────── Main ─────────────────
local res_path = reaper.GetResourcePath("")
local sep = path_sep()
local osc_dir = res_path .. sep .. "OSC"
local script_dir = dirname(debug.getinfo(1, "S").source:sub(2))
local pattern_src = script_dir .. sep .. PATTERN_NAME
local pattern_dst = osc_dir .. sep .. PATTERN_NAME
local ini_path = res_path .. sep .. "reaper.ini"

reaper.RecursiveCreateDirectory(osc_dir, 0)

local copied = false
if file_exists(pattern_src) then
    copied = copy_file(pattern_src, pattern_dst)
end

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
    msg = msg .. "Copied " .. PATTERN_NAME .. " to:\n" .. pattern_dst .. "\n\n"
elseif file_exists(pattern_dst) then
    msg = msg .. PATTERN_NAME .. " is already in:\n" .. pattern_dst .. "\n\n"
else
    msg = msg .. "Could not copy " .. PATTERN_NAME .. " automatically.\n"
    msg = msg .. "Please copy it manually to:\n" .. osc_dir .. "\n\n"
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
msg = msg .. "  Receive from REAPER: " .. RECV_PORT

reaper.ShowMessageBox(msg, "ReaperControl Auto-Setup", 0)

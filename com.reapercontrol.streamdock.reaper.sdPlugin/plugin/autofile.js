// Auto-install script: invoked by `npm run build` after the ncc bundle steps.
// Installs the .sdPlugin folder into the StreamDock plugins directory.
//
// If a plugin process is already running, hand off via the ncc-bundled keep-alive
// (build-keepalive/index.js) so StreamDock never relaunches a missing index.js —
// that would crash-loop through the 50-restart budget and force an app restart.
// If nothing is running, just copy in place and ask for an app restart.
// Rationale: docs/superpowers/specs/2026-06-09-keepalive-build-handoff-design.md
const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const { execSync } = require('child_process');

console.log('Starting automated build...');

const pluginDir = __dirname;                       // <plugin>/plugin (source)
const parentDir = path.resolve(pluginDir, '..');   // the .sdPlugin folder (source)
const PluginName = path.basename(parentDir);       // folder name = plugin ID

const pluginsRoot = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library/Application Support/HotSpot/StreamDock/plugins')
    : path.join(process.env.APPDATA, 'HotSpot/StreamDock/plugins');
const PluginPath = path.join(pluginsRoot, PluginName);
const installedPluginDir = path.join(PluginPath, 'plugin');

// Dev-only files never copied into the installed plugin.
const skip = [
    path.join('plugin', 'node_modules'),
    path.join('plugin', 'index.js'),
    path.join('plugin', 'autofile.js'),
    path.join('plugin', 'devfile.js'),
    path.join('plugin', 'keepalive.js'),
    path.join('plugin', 'package.json'),
    path.join('plugin', 'package-lock.json'),
    path.join('plugin', 'pnpm-lock.yaml'),
    path.join('plugin', 'yarn.lock'),
    path.join('plugin', 'build'),
    path.join('plugin', 'build-keepalive'),
    path.join('plugin', 'log'),
    '.git',
    '.vscode'
];

function isPluginRunning() {
    if (process.platform === 'win32') {
        try {
            const out = execSync(
                `powershell -NoProfile -Command "@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*${PluginName}*' }).Count"`,
                { encoding: 'utf8' }
            );
            return parseInt(out.trim(), 10) > 0;
        } catch { return false; }
    }
    try { execSync(`pgrep -f "${PluginName}"`, { stdio: 'ignore' }); return true; }
    catch { return false; }
}

function killPlugin() {
    if (process.platform === 'win32') {
        try {
            execSync(
                `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*${PluginName}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
                { stdio: 'ignore' }
            );
        } catch { /* nothing to kill */ }
    } else {
        try { execSync(`pkill -f "${PluginName}"`, { stdio: 'ignore' }); } catch { /* ignore */ }
    }
}

function copyInPlace() {
    fs.ensureDirSync(PluginPath);
    fs.copySync(parentDir, PluginPath, {
        filter: (src) => {
            const rel = path.relative(parentDir, src);
            return !skip.some(s => rel === s || rel.startsWith(s + path.sep));
        }
    });
    fs.copySync(path.join(pluginDir, 'build'), installedPluginDir);
}

// Dependency-free synchronous sleep (autofile runs synchronously).
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function installNotRunning() {
    try {
        copyInPlace();
        console.log(`Plugin "${PluginName}" installed to "${PluginPath}".`);
        console.log('Build succeeded -------------');
        console.log('');
        console.log('⚠  Please (re)start the StreamDock app so the plugin is loaded.');
    } catch (err) {
        console.error(`Copy failed for "${PluginName}":`, err);
        process.exit(1);
    }
}

function installViaKeepalive() {
    const keepaliveBundle = path.join(pluginDir, 'build-keepalive', 'index.js');
    const taskFile = path.join(installedPluginDir, '.keepalive-task.json');
    const doneFile = path.join(installedPluginDir, '.keepalive-done');
    const errFile = path.join(installedPluginDir, '.keepalive-error');

    try {
        if (!fs.existsSync(keepaliveBundle)) {
            throw new Error(`keep-alive bundle missing: ${keepaliveBundle} (did the ncc step run?)`);
        }
        fs.ensureDirSync(installedPluginDir);
        fs.removeSync(doneFile);
        fs.removeSync(errFile);
        // 1. write the keep-alive bundle over the installed (running) plugin/index.js
        fs.copySync(keepaliveBundle, path.join(installedPluginDir, 'index.js'));
        // 2. write the task the keep-alive will execute
        fs.writeJsonSync(taskFile, {
            srcDir: parentDir,
            buildDir: path.join(pluginDir, 'build'),
            pluginPath: PluginPath,
            skip
        });
    } catch (err) {
        console.error('Failed to stage keep-alive (old plugin left untouched):', err);
        process.exit(1);
    }

    // 3. kill the running plugin once -> StreamDock relaunches into the keep-alive
    killPlugin();
    console.log('Keep-alive staged; StreamDock is swapping in the new build...');

    // 4. wait for the keep-alive to finish (done/error marker), up to ~15s
    const timeoutMs = 15000, pollMs = 250;
    let waited = 0, ok = false, failed = false;
    while (waited < timeoutMs) {
        if (fs.existsSync(doneFile)) { ok = true; break; }
        if (fs.existsSync(errFile)) { failed = true; break; }
        sleepSync(pollMs);
        waited += pollMs;
    }

    // 5. report + cleanup
    try { fs.removeSync(taskFile); } catch { /* ignore */ }
    if (ok) {
        fs.removeSync(doneFile);
        console.log(`Plugin "${PluginName}" installed to "${PluginPath}".`);
        console.log('Build succeeded -------------');
        console.log('StreamDock is restarting the plugin with the new build (~2 of the 50 restarts used).');
    } else if (failed) {
        const detail = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8') : '(no detail)';
        fs.removeSync(errFile);
        console.error('Keep-alive reported an error:\n' + detail);
        console.error('See ' + path.join(installedPluginDir, 'log', 'keepalive.log'));
        process.exit(1);
    } else {
        console.warn('Timed out waiting for the keep-alive to finish.');
        console.warn('If the plugin did not update, quit and reopen StreamDock, then build again.');
    }
}

if (isPluginRunning()) {
    installViaKeepalive();
} else {
    installNotRunning();
}

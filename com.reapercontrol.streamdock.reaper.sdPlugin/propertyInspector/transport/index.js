/// <reference path="../utils/common.js" />
/// <reference path="../utils/action.js" />

const $local = false, $back = false;

const $dom = {
    oscHost: $('#oscHost'),
    oscSendPort: $('#oscSendPort'),
    oscRecvPort: $('#oscRecvPort'),
    command: $('#command')
};

function updateGlobalSettings() {
    $websocket.setGlobalSettings({
        oscHost: $dom.oscHost.value || '127.0.0.1',
        oscSendPort: Number($dom.oscSendPort.value) || 8000,
        oscRecvPort: Number($dom.oscRecvPort.value) || 9000
    });
}

function updateLocalSettings() {
    $settings.command = $dom.command.value;
}

const $propEvent = {
    didReceiveSettings({ settings }) {
        $dom.command.value = settings.command ?? 'play';
    },
    didReceiveGlobalSettings({ settings }) {
        $dom.oscHost.value = settings.oscHost || '127.0.0.1';
        $dom.oscSendPort.value = settings.oscSendPort || 8000;
        $dom.oscRecvPort.value = settings.oscRecvPort || 9000;
    },
    sendToPropertyInspector(data) {}
};

$dom.oscHost.on('change', updateGlobalSettings);
$dom.oscSendPort.on('change', updateGlobalSettings);
$dom.oscRecvPort.on('change', updateGlobalSettings);
$dom.command.on('change', updateLocalSettings);

/// <reference path="../utils/common.js" />
/// <reference path="../utils/action.js" />

const $local = false, $back = false;

const $dom = {
    oscHost: $('#oscHost'),
    oscSendPort: $('#oscSendPort'),
    oscRecvPort: $('#oscRecvPort'),
    lastTouched: $('#lastTouched'),
    fixedParamWrap: $('#fixedParamWrap'),
    trackNumber: $('#trackNumber'),
    fxNumber: $('#fxNumber'),
    paramNumber: $('#paramNumber'),
    pressAction: $('#pressAction'),
    sensitivity: $('#sensitivity')
};

function updateGlobalSettings() {
    $websocket.setGlobalSettings({
        oscHost: $dom.oscHost.value || '127.0.0.1',
        oscSendPort: Number($dom.oscSendPort.value) || 8000,
        oscRecvPort: Number($dom.oscRecvPort.value) || 9000
    });
}

function updateLocalSettings() {
    $settings.lastTouched = $dom.lastTouched.checked;
    $settings.trackNumber = Number($dom.trackNumber.value) || 1;
    $settings.fxNumber = Number($dom.fxNumber.value) || 1;
    $settings.paramNumber = Number($dom.paramNumber.value) || 1;
    $settings.pressAction = $dom.pressAction.value;
    $settings.sensitivity = Number($dom.sensitivity.value) || 1.0;
}

const $propEvent = {
    didReceiveSettings({ settings }) {
        $dom.lastTouched.checked = settings.lastTouched ?? false;
        $dom.trackNumber.value = settings.trackNumber ?? 1;
        $dom.fxNumber.value = settings.fxNumber ?? 1;
        $dom.paramNumber.value = settings.paramNumber ?? 1;
        $dom.pressAction.value = settings.pressAction ?? 'bypass';
        $dom.sensitivity.value = settings.sensitivity ?? 1.0;
        $dom.fixedParamWrap.style.display = $dom.lastTouched.checked ? 'none' : 'block';
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

$dom.lastTouched.on('change', () => {
    $dom.fixedParamWrap.style.display = $dom.lastTouched.checked ? 'none' : 'block';
    updateLocalSettings();
});
$dom.trackNumber.on('change', updateLocalSettings);
$dom.fxNumber.on('change', updateLocalSettings);
$dom.paramNumber.on('change', updateLocalSettings);
$dom.pressAction.on('change', updateLocalSettings);
$dom.sensitivity.on('change', updateLocalSettings);

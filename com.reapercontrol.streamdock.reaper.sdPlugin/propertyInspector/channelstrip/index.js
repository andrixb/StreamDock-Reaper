/// <reference path="../utils/common.js" />
/// <reference path="../utils/action.js" />

const $local = false, $back = false;

const $dom = {
    oscHost: $('#oscHost'),
    oscSendPort: $('#oscSendPort'),
    oscRecvPort: $('#oscRecvPort'),
    trackNumber: $('#trackNumber'),
    followBank: $('#followBank'),
    bankOffset: $('#bankOffset'),
    bankOffsetWrap: $('#bankOffsetWrap'),
    pressAction: $('#pressAction'),
    showPeak: $('#showPeak'),
    labelSize: $('#labelSize')
};

function updateGlobalSettings() {
    $websocket.setGlobalSettings({
        oscHost: $dom.oscHost.value || '127.0.0.1',
        oscSendPort: Number($dom.oscSendPort.value) || 8000,
        oscRecvPort: Number($dom.oscRecvPort.value) || 9000
    });
}

function updateLocalSettings() {
    $settings.trackNumber = Number($dom.trackNumber.value) || 1;
    $settings.followBank = $dom.followBank.checked;
    $settings.bankOffset = Number($dom.bankOffset.value) || 1;
    $settings.pressAction = $dom.pressAction.value;
    $settings.showPeak = $dom.showPeak.checked;
    $settings.labelSize = Number($dom.labelSize.value) || 13;
}

const $propEvent = {
    didReceiveSettings({ settings }) {
        $dom.trackNumber.value = settings.trackNumber ?? 1;
        $dom.followBank.checked = settings.followBank ?? false;
        $dom.bankOffset.value = settings.bankOffset ?? 1;
        $dom.pressAction.value = settings.pressAction ?? 'mute';
        $dom.showPeak.checked = settings.showPeak ?? true;
        $dom.labelSize.value = settings.labelSize ?? 13;
        $dom.bankOffsetWrap.style.display = $dom.followBank.checked ? 'block' : 'none';
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

$dom.trackNumber.on('change', updateLocalSettings);
$dom.followBank.on('change', () => {
    $dom.bankOffsetWrap.style.display = $dom.followBank.checked ? 'block' : 'none';
    updateLocalSettings();
});
$dom.bankOffset.on('change', updateLocalSettings);
$dom.pressAction.on('change', updateLocalSettings);
$dom.showPeak.on('change', updateLocalSettings);
$dom.labelSize.on('change', updateLocalSettings);

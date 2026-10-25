/// <reference path="../utils/common.js" />
/// <reference path="../utils/action.js" />

const $local = false, $back = false;

const $dom = {
    direction: $('#direction'),
    bankSize: $('#bankSize')
};

function updateLocalSettings() {
    $settings.direction = $dom.direction.value;
    $settings.bankSize = Number($dom.bankSize.value) || 8;
}

const $propEvent = {
    didReceiveSettings({ settings }) {
        $dom.direction.value = settings.direction ?? 'next';
        $dom.bankSize.value = settings.bankSize ?? 8;
    },
    didReceiveGlobalSettings({ settings }) {},
    sendToPropertyInspector(data) {}
};

$dom.direction.on('change', updateLocalSettings);
$dom.bankSize.on('change', updateLocalSettings);

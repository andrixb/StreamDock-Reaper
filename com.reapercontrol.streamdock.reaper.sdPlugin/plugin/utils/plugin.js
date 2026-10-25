// Configure the log file
const now = new Date();
const log = require('log4js').configure({
    appenders: {
        file: { type: 'file', filename: `./log/${now.getFullYear()}.${now.getMonth() + 1}.${now.getDate()}.log` }
    },
    categories: {
        default: { appenders: ['file'], level: 'info' }
    }
}).getLogger();

//##################################################
//################ Global error capture ###########
process.on('uncaughtException', (error) => {
    log.error('Uncaught Exception:', error);
});
process.on('unhandledRejection', (reason) => {
    log.error('Unhandled Rejection:', reason);
});
//##################################################
//##################################################


// Plugin class
const ws = require('ws');
class Plugins {
    static language = JSON.parse(process.argv[9]).application.language;
    static globalSettings = {};
    getGlobalSettingsFlag = true;
    constructor() {
        if (Plugins.instance) {
            return Plugins.instance;
        }
        // log.info("process.argv", process.argv);
        this.ws = new ws("ws://127.0.0.1:" + process.argv[3]);
        this.ws.on('open', () => this.ws.send(JSON.stringify({ uuid: process.argv[5], event: process.argv[7] })));
        this.ws.on('close', process.exit);
        this.ws.on('message', e => {
            if (this.getGlobalSettingsFlag) {
                // fetch only once
                this.getGlobalSettingsFlag = false;
                this.getGlobalSettings();
            }
            const data = JSON.parse(e.toString());
            const action = data.action?.split('.').pop();
            this[action]?.[data.event]?.(data);
            if (data.event === 'didReceiveGlobalSettings') {
                Plugins.globalSettings = data.payload.settings;
            }
            this[data.event]?.(data);
        });
        Plugins.instance = this;
    }

    setGlobalSettings(payload) {
        Plugins.globalSettings = payload;
        this.ws.send(JSON.stringify({
            event: "setGlobalSettings",
            context: process.argv[5], payload
        }));
    }

    getGlobalSettings() {
        this.ws.send(JSON.stringify({
            event: "getGlobalSettings",
            context: process.argv[5],
        }));
    }
    // Set the title
    setTitle(context, str, row = 0, num = 6) {
        let newStr = null;
        if (row && str) {
            let nowRow = 1, strArr = str.split('');
            strArr.forEach((item, index) => {
                if (nowRow < row && index >= nowRow * num) { nowRow++; newStr += '\n'; }
                if (nowRow <= row && index < nowRow * num) { newStr += item; }
            });
            if (strArr.length > row * num) { newStr = newStr.substring(0, newStr.length - 1); newStr += '..'; }
        }
        this.ws.send(JSON.stringify({
            event: "setTitle",
            context, payload: {
                target: 0,
                title: newStr || str + ''
            }
        }));
    }
    // Set the background image
    setImage(context, url) {
        this.ws.send(JSON.stringify({
            event: "setImage",
            context, payload: {
                target: 0,
                image: url
            }
        }));
    }
    // Set the state
    setState(context, state) {
        this.ws.send(JSON.stringify({
            event: "setState",
            context, payload: { state }
        }));
    }
    // Save persistent data
    setSettings(context, payload) {
        this.ws.send(JSON.stringify({
            event: "setSettings",
            context, payload
        }));
    }

    // Show a warning on the key
    showAlert(context) {
        this.ws.send(JSON.stringify({
            event: "showAlert",
            context
        }));
    }

    // Show a success mark on the key
    showOk(context) {
        this.ws.send(JSON.stringify({
            event: "showOk",
            context
        }));
    }
    // Send to the Property Inspector
    sendToPropertyInspector(payload) {
        this.ws.send(JSON.stringify({
            action: Actions.currentAction,
            context: Actions.currentContext,
            payload, event: "sendToPropertyInspector"
        }));
    }
    // Open a web page in the default browser
    openUrl(url) {
        this.ws.send(JSON.stringify({
            event: "openUrl",
            payload: { url }
        }));
    }
};

// Action class
class Actions {
    constructor(data) {
        this.data = {};
        this.default = {};
        Object.assign(this, data);
    }
    // When the Property Inspector appears
    static currentAction = null;
    static currentContext = null;
    static actions = {};
    propertyInspectorDidAppear(data) {
        Actions.currentAction = data.action;
        Actions.currentContext = data.context;
        this._propertyInspectorDidAppear?.(data);
    }
    // Initialize the data
    willAppear(data) {
        Plugins.globalContext = data.context;
        Actions.actions[data.context] = data.action
        const { context, payload: { settings } } = data;
        this.data[context] = Object.assign({ ...this.default }, settings);
        this._willAppear?.(data);
    }

    didReceiveSettings(data) {
        // Stay consistent with willAppear: fall back to default so settings sent
        // back from the PI never end up missing fields.
        this.data[data.context] = Object.assign({ ...this.default }, data.payload.settings);
        this._didReceiveSettings?.(data);
    }
    // Action teardown
    willDisappear(data) {
        this._willDisappear?.(data);
        delete this.data[data.context];
    }
}

class EventEmitter {
    constructor() {
        this.events = {};
    }

    // Subscribe to an event
    subscribe(event, listener) {
        if (!this.events[event]) {
            this.events[event] = [];
        }
        this.events[event].push(listener);
    }

    // Unsubscribe
    unsubscribe(event, listenerToRemove) {
        if (!this.events[event]) return;

        this.events[event] = this.events[event].filter(listener => listener !== listenerToRemove);
    }

    // Emit an event
    emit(event, data) {
        if (!this.events[event]) return;
        this.events[event].forEach(listener => listener(data));
    }
}

module.exports = {
    log,
    Plugins,
    Actions,
    EventEmitter
};

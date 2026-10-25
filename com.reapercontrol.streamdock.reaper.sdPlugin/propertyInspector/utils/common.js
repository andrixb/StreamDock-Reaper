// Custom event class
class EventPlus {
    constructor() {
        this.event = new EventTarget();
    }
    on(name, callback) {
        this.event.addEventListener(name, e => callback(e.detail));
    }
    send(name, data) {
        this.event.dispatchEvent(new CustomEvent(name, {
            detail: data,
            bubbles: false,
            cancelable: false
        }));
    }
}

// Pad with a leading zero
String.prototype.fill = function () {
    return this >= 10 ? this : '0' + this;
};

// Unicode escapes -> string
String.prototype.uTs = function () {
    return eval('"' + Array.from(this).join('') + '"');
};

// String -> unicode escapes
String.prototype.sTu = function (str = '') {
    Array.from(this).forEach(item => str += `\\u${item.charCodeAt(0).toString(16)}`);
    return str;
};

// Global variables / helpers
const $emit = new EventPlus(), $ = (selector, isAll = false) => {
    const element = document.querySelector(selector), methods = {
        on: function (event, callback) {
            this.addEventListener(event, callback);
        },
        attr: function (name, value = '') {
            value && this.setAttribute(name, value);
            return this;
        }
    };
    if (!isAll && element) {
        return Object.assign(element, methods);
    } else if (!isAll && !element) {
        throw `No "${selector}" element in the HTML! Check for a typo.`;
    }
    return Array.from(document.querySelectorAll(selector)).map(item => Object.assign(item, methods));
};

// Throttle
$.throttle = (fn, delay) => {
    let Timer = null;
    return function () {
        if (Timer) return;
        Timer = setTimeout(() => {
            fn.apply(this, arguments);
            Timer = null;
        }, delay);
    };
};

// Debounce
$.debounce = (fn, delay) => {
    let Timer = null;
    return function () {
        clearTimeout(Timer);
        Timer = setTimeout(() => fn.apply(this, arguments), delay);
    };
};

// Bind the digits-only restriction
Array.from($('input[type="num"]', true)).forEach(item => {
    item.addEventListener('input', function limitNum() {
        if (!item.value || /^\d+$/.test(item.value)) return;
        item.value = item.value.slice(0, -1);
        limitNum(item);
    });
});

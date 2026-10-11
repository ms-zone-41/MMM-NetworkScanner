// Tests for the module, with stand-ins for MagicMirror² and the node helper

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

// Load the module like MagicMirror² does, with document and config as globals
const document = new JSDOM("<!doctype html><html><body></body></html>").window.document;
let definition;
const context = vm.createContext({
	Module: {
		register(name, value) {
			definition = value;
		}
	},
	Log: { info() {} },
	document,
	config: { language: "en" },
	// The parts of moment that the module uses
	moment: Object.assign(() => ({ fromNow: () => "5 minutes ago" }), { locale() {} })
});
vm.runInContext(fs.readFileSync(path.join(__dirname, "../MMM-NetworkScanner.js"), "utf8"), context);

const NOW = Date.UTC(2026, 9, 11, 12, 0);

// Devices as the node helper sends them
const ANNA = { name: "Anna", icon: "mobile-screen", online: true, lastSeen: NOW - 5 * 60 * 1000 };
const BEN = { name: "Ben", online: false, lastSeen: null };

// Start the module with stand-ins for the methods of MagicMirror²
function createModule(config = {}) {
	const module = Object.assign(Object.create(definition), {
		name: "MMM-NetworkScanner",
		config: { ...definition.defaults, ...config },
		socketNotifications: [],
		notifications: [],
		translate: (key) => key,
		sendSocketNotification(notification, payload) {
			this.socketNotifications.push({ notification, payload });
		},
		sendNotification(notification, payload) {
			this.notifications.push({ notification, payload });
		},
		updateDom() {}
	});
	module.start();
	return module;
}

// Send the devices from the node helper to the module, as JSON like socket.io
function receive(module, devices) {
	module.socketNotificationReceived("DEVICES", JSON.parse(JSON.stringify({ devices })));
}

// The names of the devices that the module shows
function names(module) {
	return Array.from(module.getDom().querySelectorAll(".deviceCell"), (cell) => cell.textContent);
}

// The names of the notifications that the module sent
function sent(module) {
	return module.notifications.map((notification) => notification.notification);
}

test("asks the node helper for the devices when all modules have started", () => {
	const module = createModule();
	assert.deepEqual(module.socketNotifications, []);
	module.notificationReceived("ALL_MODULES_STARTED");
	assert.deepEqual(module.socketNotifications.map((notification) => notification.notification), ["GET_DEVICES"]);
});

test("shows that it is loading until the devices arrive", () => {
	const module = createModule();
	assert.equal(module.getDom().textContent, "LOADING");
	receive(module, [ANNA, BEN]);
	assert.deepEqual(names(module), ["Anna", "Ben"]);
});

test("shows the devices that are offline dimmed", () => {
	const module = createModule();
	receive(module, [ANNA, BEN]);
	const rows = module.getDom().querySelectorAll("tr");
	assert.ok(rows[0].classList.contains("bright"));
	assert.ok(rows[1].classList.contains("dimmed"));
});

test("hides the devices that are offline with showOffline false", () => {
	const module = createModule({ showOffline: false });
	receive(module, [ANNA, BEN]);
	assert.deepEqual(names(module), ["Anna"]);
});

test("sends occupiedCMD when the first resident comes home and vacantCMD when the last one leaves", () => {
	const module = createModule({ residents: ["Anna", "Ben"], occupiedCMD: { notification: "OCCUPIED" }, vacantCMD: { notification: "VACANT", payload: { action: "MONITOROFF" } } });
	// For the first devices, vacantCMD as nobody is at home
	receive(module, [{ ...ANNA, online: false }, BEN]);
	assert.deepEqual(module.notifications, [{ notification: "VACANT", payload: { action: "MONITOROFF" } }]);
	receive(module, [{ ...ANNA, online: false }, BEN]);
	receive(module, [ANNA, BEN]);
	receive(module, [ANNA, { ...BEN, online: true }]);
	assert.deepEqual(sent(module), ["VACANT", "OCCUPIED"]);
	receive(module, [{ ...ANNA, online: false }, { ...BEN, online: true }]);
	receive(module, [{ ...ANNA, online: false }, BEN]);
	assert.deepEqual(sent(module), ["VACANT", "OCCUPIED", "VACANT"]);
});

test("sends occupiedCMD for the first devices if a resident is at home, and nothing for a command that is not set", () => {
	const module = createModule({ residents: ["Anna"], occupiedCMD: { notification: "REMOTE_ACTION", payload: { action: "MONITORON" } } });
	receive(module, [ANNA, BEN]);
	// Anna leaves, and there is no vacantCMD
	receive(module, [{ ...ANNA, online: false }, BEN]);
	assert.deepEqual(module.notifications, [{ notification: "REMOTE_ACTION", payload: { action: "MONITORON" } }]);
});

test("sends no notifications without residents", () => {
	const module = createModule({ occupiedCMD: { notification: "OCCUPIED" }, vacantCMD: { notification: "VACANT" } });
	receive(module, [ANNA, BEN]);
	assert.deepEqual(module.notifications, []);
});

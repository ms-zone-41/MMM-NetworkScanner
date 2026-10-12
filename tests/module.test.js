// Tests for the module, with stand-ins for MagicMirror² and the node helper

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
const translations = require("../translations/en.json");

const NOW = Date.UTC(2026, 9, 11, 12, 0);

// Load the module like MagicMirror² does, with document as a global, and with
// a clock that stands still at NOW
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
	Date: { now: () => NOW }
});
vm.runInContext(fs.readFileSync(path.join(__dirname, "../MMM-NetworkScanner.js"), "utf8"), context);

// Devices as the node helper sends them
const ANNA = { name: "Anna", icon: "mobile-screen", color: null, online: true, lastSeen: NOW - 5 * 60 * 1000 };
const BEN = { name: "Ben", icon: null, color: null, online: false, lastSeen: null };
const CARL = { name: "Carl", icon: "laptop", color: null, online: true, lastSeen: NOW };

// Start the module with stand-ins for the methods of MagicMirror²
function createModule(config = {}) {
	const module = Object.assign(Object.create(definition), {
		name: "MMM-NetworkScanner",
		config: { ...definition.defaults, ...config },
		socketNotifications: [],
		notifications: [],
		// Like MagicMirror², fill in variables such as {detail}
		translate(key, variables = {}) {
			return (translations[key] ?? key).replace(/{([^{}]+)}/g, (placeholder, name) => (name in variables ? variables[name] : placeholder));
		},
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
function receive(module, devices, error = null) {
	module.socketNotificationReceived("DEVICES", JSON.parse(JSON.stringify({ devices, error })));
}

// The texts of the cells, row by row: the name of each device, and with
// showLastSeen the value and the unit of the time since it was last seen
function rows(module) {
	return Array.from(module.getDom().querySelectorAll("tr"), (row) => Array.from(row.children, (cell) => cell.textContent));
}

// The warning about a problem of the scan: its text, and the detail below it,
// e.g. the command that solves the problem
function warning(module) {
	const element = module.getDom().querySelector(".ns-warning");
	return element && {
		text: Array.from(element.childNodes).filter((node) => node.nodeType === node.TEXT_NODE).map((node) => node.textContent).join(""),
		detail: element.querySelector("code")?.textContent
	};
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
	assert.equal(module.getDom().className, "small dimmed");
	receive(module, [ANNA, BEN]);
	assert.deepEqual(rows(module), [["Anna"], ["Ben"]]);
});

test("shows each device with its icon, bright and in its color while online and dimmed while offline", () => {
	const module = createModule();
	receive(module, [{ ...ANNA, color: "orange" }, BEN, { ...CARL, online: false, color: "orange" }]);
	const [anna, ben, carl] = module.getDom().querySelectorAll(".ns-name");
	assert.equal(anna.className, "ns-name ns-online bright");
	assert.equal(anna.firstChild.className, "fa-solid fa-fw fa-mobile-screen");
	assert.equal(anna.firstChild.style.color, "orange");
	assert.equal(anna.textContent, "Anna");
	assert.equal(ben.className, "ns-name ns-offline dimmed");
	assert.equal(ben.innerHTML, "Ben");
	// The icon of a device that is offline is dimmed like its name
	assert.equal(carl.className, "ns-name ns-offline dimmed");
	assert.equal(carl.firstChild.style.color, "");
});

test("shows the names as text, not as HTML", () => {
	const module = createModule();
	receive(module, [{ ...BEN, name: "<b>Ben</b> & Co" }]);
	assert.deepEqual(rows(module), [["<b>Ben</b> & Co"]]);
	assert.equal(module.getDom().querySelector("b"), null);
});

test("shows the devices in rows of the number of columns, by default one per row", () => {
	const layouts = [
		[{}, [["Anna"], ["Ben"], ["Carl"]]],
		// columns: 0 shows a list, too
		[{ columns: 0 }, [["Anna"], ["Ben"], ["Carl"]]],
		[{ columns: 2 }, [["Anna", "Ben"], ["Carl"]]]
	];
	for (const [config, expected] of layouts) {
		const module = createModule(config);
		receive(module, [ANNA, BEN, CARL]);
		assert.deepEqual(rows(module), expected, JSON.stringify(config));
	}
});

test("hides the devices that are offline with showOffline false, and shows when none is online", () => {
	const module = createModule({ showOffline: false });
	receive(module, [ANNA, BEN]);
	assert.deepEqual(rows(module), [["Anna"]]);
	receive(module, [{ ...ANNA, online: false }, BEN]);
	assert.equal(module.getDom().textContent, "No devices online");
	assert.equal(module.getDom().className, "small dimmed");
});

test("shows the time since each device was last seen in minutes, hours up to 100 hours, or days", () => {
	const module = createModule({ showLastSeen: true });
	// -1: the clock of the server may be a little ahead of that of the browser
	const minutes = [-1, 0, 59, 60, 100 * 60 - 1, 100 * 60, 41 * 24 * 60 - 1];
	receive(module, [BEN, ...minutes.map((ago) => ({ ...BEN, lastSeen: NOW - ago * 60 * 1000 }))]);
	assert.deepEqual(rows(module).map((cells) => cells.slice(1)), [["-", ""], ["0", "m"], ["0", "m"], ["59", "m"], ["1", "h"], ["99", "h"], ["4", "d"], ["40", "d"]]);
});

test("shows the time since a device was last seen only for the devices that are offline with showLastSeen \"offline\"", () => {
	const module = createModule({ showLastSeen: "offline", columns: 2 });
	receive(module, [ANNA, BEN, { ...CARL, online: false }]);
	// Empty cells for Anna, who is online, keep the columns in line
	assert.deepEqual(rows(module), [["Anna", "", "", "Ben", "-", ""], ["Carl", "0", "m"]]);
});

test("shows a problem of the scan, and below it the command that solves it or what went wrong", () => {
	const problems = [
		[{ code: "ARP_SCAN_NOT_FOUND", detail: "sudo apt install arp-scan" }, "arp-scan is not installed"],
		[{ code: "ARP_SCAN_NO_PERMISSION", detail: "sudo setcap cap_net_raw+ep /usr/sbin/arp-scan" }, "arp-scan is not allowed to scan the network"],
		[{ code: "SCAN_FAILED", detail: "ERROR: Could not obtain interface IP address and netmask" }, "The network scan failed"]
	];
	for (const [error, text] of problems) {
		const module = createModule();
		receive(module, [ANNA, BEN], error);
		assert.deepEqual(warning(module), { text, detail: error.detail });
	}
});

test("shows only the option that is not valid, with its value", () => {
	const module = createModule();
	receive(module, [], { code: "INVALID_OPTION", option: "network", detail: "\"-l\"" });
	assert.deepEqual(warning(module), { text: "The option network is not valid", detail: "\"-l\"" });
	// Without NO_DEVICES_ONLINE
	assert.equal(module.getDom().textContent, "The option network is not valid\"-l\"");
});

test("dims all devices while the scan fails, and shows them as before when it works again", () => {
	const module = createModule();
	const names = () => Array.from(module.getDom().querySelectorAll(".ns-name"), (cell) => cell.className);
	// The color of the icon of Anna, who is online
	const color = () => module.getDom().querySelector(".ns-online i").style.color;
	receive(module, [{ ...ANNA, color: "orange" }, BEN], { code: "ARP_SCAN_NOT_FOUND" });
	assert.ok(module.getDom().querySelector("table").classList.contains("ns-stale"));
	assert.deepEqual(rows(module), [["Anna"], ["Ben"]]);
	// The last scan that worked does not tell who is online now
	assert.deepEqual(names(), ["ns-name ns-online dimmed", "ns-name ns-offline dimmed"]);
	assert.equal(color(), "");
	receive(module, [{ ...ANNA, color: "orange" }, BEN]);
	assert.equal(warning(module), null);
	assert.ok(!module.getDom().querySelector("table").classList.contains("ns-stale"));
	assert.deepEqual(names(), ["ns-name ns-online bright", "ns-name ns-offline dimmed"]);
	assert.equal(color(), "orange");
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

test("sends no residents notifications while the scan fails", () => {
	const module = createModule({ residents: ["Anna"], occupiedCMD: { notification: "OCCUPIED" }, vacantCMD: { notification: "VACANT" } });
	receive(module, [BEN], { code: "ARP_SCAN_NOT_FOUND" });
	assert.deepEqual(module.notifications, []);
	receive(module, [ANNA, BEN]);
	receive(module, [{ ...ANNA, online: false }, BEN], { code: "SCAN_FAILED", detail: "timeout" });
	assert.deepEqual(sent(module), ["OCCUPIED"]);
});

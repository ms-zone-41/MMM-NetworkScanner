// Tests for the node helper, with stand-ins for MagicMirror², arp-scan, ping
// and the timers

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

// Two phones by their MAC address, in upper and lower case, and a server by
// its IP address
const DEVICES = [
	{ macAddress: "AA:BB:CC:DD:EE:01", name: "Anna", icon: "mobile-screen" },
	{ macAddress: "aa:bb:cc:dd:ee:02", name: "Ben" },
	{ ipAddress: "192.168.178.10", name: "Server" }
];

// What arp-scan --quiet --plain prints if Anna and the router answer: the IP
// and the MAC address of each host, separated by a tab
const ANNA_ANSWERS = "192.168.178.21\taa:bb:cc:dd:ee:01\n192.168.178.1\t11:22:33:44:55:66\n";

const START = Date.UTC(2026, 9, 11, 10, 0);

// Load the node helper with stand-ins for MagicMirror², for arp-scan, which
// runs with sudo, for ping and for the timers, and start it. arpScan(args)
// returns what arp-scan prints and its exit code, ping(host) whether the host
// answers. By default, no device answers.
function createHelper({ config = {}, arpScan = () => ({}), ping = () => false } = {}) {
	const clock = { now: START };
	const timers = new Set();
	const arpScans = [];
	const pings = [];
	const notifications = [];
	const context = {
		require: (name) => ({
			node_helper: { create: (definition) => definition },
			logger: { debug() {}, info() {}, log() {}, warn() {}, error() {} },
			sudo: (args) => {
				// A copy, as arrays of the node helper are not arrays of the tests
				arpScans.push([...args]);
				const { stdout = "", stderr = "", code = 0 } = arpScan(args);
				const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
				queueMicrotask(() => {
					child.stdout.emit("data", stdout);
					child.stderr.emit("data", stderr);
					child.emit("close", code);
				});
				return child;
			},
			ping: {
				sys: {
					probe: (host, callback) => {
						pings.push(host);
						queueMicrotask(() => callback(ping(host)));
					}
				}
			}
		})[name],
		module: {},
		Date: { now: () => clock.now },
		setTimeout: (callback, delay) => {
			const timer = { callback, delay };
			timers.add(timer);
			return timer;
		},
		clearTimeout: (timer) => timers.delete(timer)
	};
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../node_helper.js"), "utf8"), context);
	const helper = Object.assign(Object.create(context.module.exports), {
		name: "MMM-NetworkScanner",
		// The configuration of the module in config.js
		getServerModuleConfig: () => ({ devices: DEVICES, ...config }),
		// Like socket.io, send the payload as JSON
		sendSocketNotification: (notification, payload) => notifications.push({ notification, payload: JSON.parse(JSON.stringify(payload)) })
	});
	helper.start();
	return { helper, clock, timers, arpScans, pings, notifications };
}

// Wait until the commands have answered and the scan has finished
function settle() {
	return new Promise((resolve) => setImmediate(resolve));
}

// Let the timer run the next scan, and wait until it has finished
async function scanAgain(timers) {
	const [timer] = timers;
	timers.delete(timer);
	timer.callback();
	await settle();
}

// The devices of the last notification, by name, with whether they are online
// and when they last answered
function lastDevices(notifications) {
	return notifications.at(-1).payload.devices.map(({ name, online, lastSeen }) => ({ name, online, lastSeen }));
}

test("finds the devices with a MAC address with arp-scan", async () => {
	const { arpScans, notifications } = createHelper({ arpScan: () => ({ stdout: ANNA_ANSWERS }) });
	await settle();
	assert.deepEqual(arpScans, [["arp-scan", "--quiet", "--plain", "--localnet"]]);
	assert.deepEqual(notifications.map((notification) => notification.notification), ["DEVICES"]);
	// Anna's MAC address in upper case matches the answer in lower case
	assert.deepEqual(lastDevices(notifications), [
		{ name: "Anna", online: true, lastSeen: START },
		{ name: "Ben", online: false, lastSeen: null },
		{ name: "Server", online: false, lastSeen: null }
	]);
});

test("scans the configured network", async () => {
	const { arpScans } = createHelper({ config: { network: "192.168.178.0/24" } });
	await settle();
	assert.deepEqual(arpScans, [["arp-scan", "--quiet", "--plain", "192.168.178.0/24"]]);
});

test("pings the devices with an IP address or host name, and runs arp-scan only for MAC addresses", async () => {
	const devices = [{ ipAddress: "nas.fritz.box" }, { ipAddress: "192.168.178.10" }];
	const { arpScans, pings, notifications } = createHelper({ config: { devices }, ping: (host) => host === "nas.fritz.box" });
	await settle();
	assert.deepEqual(arpScans, []);
	assert.deepEqual(pings, ["nas.fritz.box", "192.168.178.10"]);
	assert.deepEqual(lastDevices(notifications), [
		{ name: "nas.fritz.box", online: true, lastSeen: START },
		{ name: "192.168.178.10", online: false, lastSeen: null }
	]);
});

test("names a device without a name by its address", async () => {
	const { notifications } = createHelper({ config: { devices: [{ macAddress: "AA:BB:CC:DD:EE:01" }, { ipAddress: "192.168.178.10" }] } });
	await settle();
	assert.deepEqual(lastDevices(notifications).map((device) => device.name), ["AA:BB:CC:DD:EE:01", "192.168.178.10"]);
});

test("keeps a device online for keepAlive seconds after it last answered", async () => {
	let answers = ANNA_ANSWERS;
	const { clock, timers, notifications } = createHelper({ config: { keepAlive: 120 }, arpScan: () => ({ stdout: answers }) });
	await settle();
	answers = "";
	clock.now = START + 119 * 1000;
	await scanAgain(timers);
	assert.deepEqual(lastDevices(notifications)[0], { name: "Anna", online: true, lastSeen: START });
	clock.now = START + 120 * 1000;
	await scanAgain(timers);
	assert.deepEqual(lastDevices(notifications)[0], { name: "Anna", online: false, lastSeen: START });
});

test("scans again updateInterval seconds, by default 60, after a scan has finished", async () => {
	const { timers, arpScans } = createHelper({ config: { updateInterval: 120 } });
	// A scan never starts while another one runs
	assert.equal(timers.size, 0);
	await settle();
	assert.deepEqual([...timers].map((timer) => timer.delay), [120000]);
	await scanAgain(timers);
	assert.equal(arpScans.length, 2);
	assert.equal(timers.size, 1);
	const byDefault = createHelper();
	await settle();
	assert.deepEqual([...byDefault.timers].map((timer) => timer.delay), [60000]);
});

test("stops scanning when MagicMirror² stops", async () => {
	const { helper, timers } = createHelper();
	await settle();
	helper.stop();
	assert.equal(timers.size, 0);
});

test("sends the devices to a module that starts after the first scan", async () => {
	const { helper, notifications } = createHelper({ arpScan: () => ({ stdout: ANNA_ANSWERS }) });
	// Before the first scan has finished, there are no devices to send
	helper.socketNotificationReceived("GET_DEVICES");
	assert.equal(notifications.length, 0);
	await settle();
	helper.socketNotificationReceived("GET_DEVICES");
	assert.equal(notifications.length, 2);
	assert.deepEqual(notifications[1], notifications[0]);
});

test("takes no options from socket notifications", async () => {
	const { helper, arpScans, notifications } = createHelper();
	// Any device that the ipWhitelist lets in can send socket notifications
	helper.socketNotificationReceived("CONFIG", { devices: [{ macAddress: "11:22:33:44:55:66" }], network: "--help" });
	helper.socketNotificationReceived("GET_DEVICES", { devices: [] });
	await settle();
	assert.deepEqual(arpScans, [["arp-scan", "--quiet", "--plain", "--localnet"]]);
	assert.deepEqual(lastDevices(notifications).map((device) => device.name), ["Anna", "Ben", "Server"]);
});

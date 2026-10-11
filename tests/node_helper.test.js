// Tests for the node helper, with stand-ins for MagicMirror², arp-scan, ping
// and the timers

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Two phones by their MAC address, in upper and lower case, and a server by
// its IP address
const DEVICES = [
	{ macAddress: "AA:BB:CC:DD:EE:01", name: "Anna", icon: "mobile-screen" },
	{ macAddress: "aa:bb:cc:dd:ee:02", name: "Ben" },
	{ ipAddress: "192.168.178.10", name: "Server" }
];

const ARP_SCAN = "/usr/sbin/arp-scan --quiet --plain --localnet";

// What arp-scan --quiet --plain prints if Anna and the router answer: the IP
// and the MAC address of each host, separated by a tab
const ANNA_ANSWERS = "192.168.178.21\taa:bb:cc:dd:ee:01\n192.168.178.1\t11:22:33:44:55:66\n";

// What arp-scan prints without the capability cap_net_raw
const NO_PERMISSION = "pcap_activate: eth0: You don't have permission to perform this capture on that device\n(socket: Operation not permitted)\n";

const START = Date.UTC(2026, 9, 11, 10, 0);

// What execFile reports for a command that exits with a code, with what the
// command wrote to stderr
function exits(command, code, stderr = "") {
	return { error: Object.assign(new Error(`Command failed: ${command}\n${stderr}`), { code }), stderr };
}

// ... for a command that is not installed
function notFound(file) {
	return { error: Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" }) };
}

// ... and for a command that it stopped, as it did not finish in time
function timedOut(command) {
	return { error: Object.assign(new Error(`Command failed: ${command}\n`), { code: null, killed: true, signal: "SIGTERM" }) };
}

// Load the node helper with stand-ins for MagicMirror², for the commands and
// for the timers, and start it. arpScan(args) and ping(host) return what
// execFile reports for arp-scan and ping: an error and the output, or a
// promise of it, to answer later. By default, the scan works and no device
// answers.
function createHelper({ config = {}, arpScan = () => ({}), ping = (host) => exits(`ping -c 1 -W 1 ${host}`, 1) } = {}) {
	const clock = { now: START };
	const timers = new Set();
	const commands = [];
	const notifications = [];
	const logs = [];
	const log = (level) => (...args) => logs.push(`${level}: ${args.join(" ")}`);
	const context = {
		require: (name) => ({
			"node:child_process": {
				execFile: (file, args, options, callback) => {
					// Copies, as arrays of the node helper are not arrays of the tests
					commands.push({ file, args: [...args], options: { ...options } });
					const result = file === "ping" ? ping(args.at(-1)) : arpScan([...args]);
					Promise.resolve(result).then(({ error = null, stdout = "", stderr = "" }) => callback(error, stdout, stderr));
				}
			},
			"node_helper": { create: (definition) => definition },
			"logger": { debug() {}, log() {}, info: log("info"), warn: log("warn"), error: log("error") }
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
	return { helper, clock, timers, commands, notifications, logs };
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

// The arguments of each run of a command
function runs(commands, file) {
	return commands.filter((command) => command.file === file).map((command) => command.args);
}

// The devices of the last notification, by name, with whether they are online
// and when they last answered
function lastDevices(notifications) {
	return notifications.at(-1).payload.devices.map(({ name, online, lastSeen }) => ({ name, online, lastSeen }));
}

test("finds the devices with a MAC address with arp-scan", async () => {
	const { commands, notifications, logs } = createHelper({ arpScan: () => ({ stdout: ANNA_ANSWERS }) });
	await settle();
	assert.deepEqual(commands[0], { file: "/usr/sbin/arp-scan", args: ["--quiet", "--plain", "--localnet"], options: { timeout: 30000 } });
	assert.deepEqual(notifications.map((notification) => notification.notification), ["DEVICES"]);
	// Anna's MAC address in upper case matches the answer in lower case
	assert.deepEqual(lastDevices(notifications), [
		{ name: "Anna", online: true, lastSeen: START },
		{ name: "Ben", online: false, lastSeen: null },
		{ name: "Server", online: false, lastSeen: null }
	]);
	assert.equal(notifications[0].payload.error, null);
	// Nothing to log
	assert.deepEqual(logs, []);
});

test("finds a device if arp-scan adds another source MAC address in brackets", async () => {
	// arp-scan adds the source MAC address of the frame if it is not the one
	// in the answer, e.g. behind some Wi-Fi repeaters
	const { notifications } = createHelper({ arpScan: () => ({ stdout: "192.168.178.21\taa:bb:cc:dd:ee:01 (11:22:33:44:55:66)\n" }) });
	await settle();
	assert.deepEqual(lastDevices(notifications).map((device) => device.online), [true, false, false]);
});

test("scans the configured network with the configured interface", async () => {
	const options = [
		[{ network: "192.168.178.0/24" }, ["--quiet", "--plain", "192.168.178.0/24"]],
		[{ interface: "wlan0" }, ["--quiet", "--plain", "--interface=wlan0", "--localnet"]],
		[{ interface: "eth0.2", network: "10.0.0.0/24" }, ["--quiet", "--plain", "--interface=eth0.2", "10.0.0.0/24"]]
	];
	for (const [config, args] of options) {
		const { commands } = createHelper({ config });
		await settle();
		assert.deepEqual(runs(commands, "/usr/sbin/arp-scan"), [args]);
	}
});

test("pings the devices with an IP address or host name, and runs arp-scan only for MAC addresses", async () => {
	// ping exits with 0 if the host answered and with 1 if it did not
	const devices = [{ ipAddress: "nas.fritz.box" }, { ipAddress: "192.168.178.10" }];
	const ping = (host) => (host === "nas.fritz.box" ? {} : exits(`ping -c 1 -W 1 ${host}`, 1));
	const { commands, notifications } = createHelper({ config: { devices }, ping });
	await settle();
	assert.deepEqual(commands, [
		{ file: "ping", args: ["-c", "1", "-W", "1", "nas.fritz.box"], options: { timeout: 10000 } },
		{ file: "ping", args: ["-c", "1", "-W", "1", "192.168.178.10"], options: { timeout: 10000 } }
	]);
	assert.deepEqual(lastDevices(notifications), [
		{ name: "nas.fritz.box", online: true, lastSeen: START },
		{ name: "192.168.178.10", online: false, lastSeen: null }
	]);
	assert.equal(notifications[0].payload.error, null);
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
	const { timers, commands } = createHelper({ config: { updateInterval: 120 } });
	// A scan never starts while another one runs
	assert.equal(timers.size, 0);
	await settle();
	assert.deepEqual([...timers].map((timer) => timer.delay), [120000]);
	await scanAgain(timers);
	assert.equal(runs(commands, "/usr/sbin/arp-scan").length, 2);
	assert.equal(timers.size, 1);
	const byDefault = createHelper();
	await settle();
	assert.deepEqual([...byDefault.timers].map((timer) => timer.delay), [60000]);
});

test("scans again only after all commands of a scan have finished", async () => {
	let finish;
	const arpScan = () => new Promise((resolve) => {
		finish = resolve;
	});
	const { timers, notifications } = createHelper({ arpScan, ping: () => notFound("ping") });
	await settle();
	// ping has failed, but arp-scan still runs
	assert.equal(notifications.length + timers.size, 0);
	finish(notFound("/usr/sbin/arp-scan"));
	await settle();
	// The problem of arp-scan comes first, whichever command failed first
	assert.equal(notifications[0].payload.error.code, "ARP_SCAN_NOT_FOUND");
	assert.equal(timers.size, 1);
});

test("stops scanning when MagicMirror² stops, and reports nothing of a scan that still runs", async () => {
	const { helper, timers } = createHelper();
	await settle();
	helper.stop();
	assert.equal(timers.size, 0);
	// systemd stops arp-scan together with MagicMirror², or arp-scan finishes
	// just before
	const stopped = { error: Object.assign(new Error(`Command failed: ${ARP_SCAN}\n`), { code: null, killed: false, signal: "SIGTERM" }) };
	for (const result of [stopped, { stdout: ANNA_ANSWERS }]) {
		const running = createHelper({ arpScan: () => result });
		running.helper.stop();
		await settle();
		assert.equal(running.notifications.length + running.logs.length + running.timers.size, 0);
	}
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
	const { helper, commands, notifications } = createHelper();
	// Any device that the ipWhitelist lets in can send socket notifications
	helper.socketNotificationReceived("CONFIG", { devices: [{ macAddress: "11:22:33:44:55:66" }], network: "--help" });
	helper.socketNotificationReceived("GET_DEVICES", { devices: [] });
	await settle();
	assert.deepEqual(runs(commands, "/usr/sbin/arp-scan"), [["--quiet", "--plain", "--localnet"]]);
	assert.deepEqual(lastDevices(notifications).map((device) => device.name), ["Anna", "Ben", "Server"]);
});

test("reports a missing arp-scan or capability with the command that solves it", async () => {
	const problems = [
		[notFound("/usr/sbin/arp-scan"), "ARP_SCAN_NOT_FOUND", "sudo apt install arp-scan", "arp-scan is not installed at /usr/sbin/arp-scan. Install it with: sudo apt install arp-scan"],
		[exits(ARP_SCAN, 1, NO_PERMISSION), "ARP_SCAN_NO_PERMISSION", "sudo setcap cap_net_raw+ep /usr/sbin/arp-scan", "arp-scan is not allowed to scan the network. Allow it with: sudo setcap cap_net_raw+ep /usr/sbin/arp-scan"]
	];
	for (const [result, code, detail, log] of problems) {
		const { notifications, logs } = createHelper({ arpScan: () => result });
		await settle();
		assert.deepEqual(notifications[0].payload.error, { code, detail });
		assert.deepEqual(logs, [`error: ${log}`]);
	}
});

test("reports other problems of arp-scan and ping with what went wrong", async () => {
	// Anna by her MAC address, and a NAS by its host name
	const devices = [DEVICES[0], { ipAddress: "nas.fritz.box" }];
	const ping = "ping -c 1 -W 1 nas.fritz.box";
	// execFile throws some errors of a command that cannot start
	const cannotStart = () => {
		throw Object.assign(new Error("spawn EPERM"), { code: "EPERM" });
	};
	const problems = [
		// The first line of the error output, or else of the error
		[{ arpScan: () => exits(ARP_SCAN, 1, "\nERROR: Could not obtain interface IP address and netmask\nioctl: Cannot assign requested address\n") }, "ERROR: Could not obtain interface IP address and netmask"],
		[{ arpScan: () => exits(ARP_SCAN, 1) }, `Command failed: ${ARP_SCAN}`],
		[{ arpScan: () => timedOut(ARP_SCAN) }, "arp-scan did not finish within 30 seconds"],
		[{ arpScan: cannotStart }, "spawn EPERM"],
		[{ ping: () => exits(ping, 2, "ping: nas.fritz.box: Name or service not known\n") }, "ping: nas.fritz.box: Name or service not known"],
		[{ ping: () => notFound("ping") }, "spawn ping ENOENT"],
		[{ ping: () => timedOut(ping) }, "ping nas.fritz.box did not finish within 10 seconds"]
	];
	for (const [failure, detail] of problems) {
		const { notifications, logs } = createHelper({ config: { devices }, arpScan: () => ({ stdout: ANNA_ANSWERS }), ...failure });
		await settle();
		assert.deepEqual(notifications[0].payload.error, { code: "SCAN_FAILED", detail });
		assert.deepEqual(logs, [`error: The network scan failed: ${detail}`]);
		// The scan failed as a whole, so it does not count Anna as online
		assert.deepEqual(lastDevices(notifications)[0], { name: "Anna", online: false, lastSeen: null });
	}
});

test("keeps the devices as they are while the scan fails", async () => {
	let result = { stdout: ANNA_ANSWERS };
	const { clock, timers, notifications } = createHelper({ arpScan: () => result });
	await settle();
	// Anna would be offline by now, but the scan cannot tell
	result = notFound("/usr/sbin/arp-scan");
	clock.now = START + 600 * 1000;
	await scanAgain(timers);
	assert.deepEqual(lastDevices(notifications)[0], { name: "Anna", online: true, lastSeen: START });
	assert.equal(notifications.at(-1).payload.error.code, "ARP_SCAN_NOT_FOUND");
	// The next scan that works brings the devices up to date
	result = { stdout: "" };
	await scanAgain(timers);
	assert.deepEqual(lastDevices(notifications)[0], { name: "Anna", online: false, lastSeen: START });
	assert.equal(notifications.at(-1).payload.error, null);
});

test("logs a problem when it starts or changes, and when the scan works again", async () => {
	const results = [
		notFound("/usr/sbin/arp-scan"),
		notFound("/usr/sbin/arp-scan"),
		exits(ARP_SCAN, 1, "first problem\n"),
		exits(ARP_SCAN, 1, "second problem\n"),
		{ stdout: "" },
		{ stdout: "" }
	];
	const { timers, logs } = createHelper({ arpScan: () => results.shift() });
	await settle();
	while (results.length > 0) {
		await scanAgain(timers);
	}
	assert.deepEqual(logs, [
		"error: arp-scan is not installed at /usr/sbin/arp-scan. Install it with: sudo apt install arp-scan",
		"error: The network scan failed: first problem",
		"error: The network scan failed: second problem",
		"info: The network scan works again"
	]);
});

test("does not scan with an option that is not valid", async () => {
	const invalid = [
		// devices must be a list of devices with either a MAC address, as six
		// pairs of hex digits separated by colons, or an IP address or host name
		[{ devices: { macAddress: "aa:bb:cc:dd:ee:01" } }, "devices"],
		[{ devices: [] }, "devices"],
		[{ devices: [null] }, "devices"],
		[{ devices: [{ name: "Anna" }] }, "devices"],
		[{ devices: [{ macAddress: "aa:bb:cc:dd:ee:01", ipAddress: "192.168.178.21" }] }, "devices"],
		[{ devices: [{ macAddress: "aa:bb:cc:dd:ee" }] }, "devices"],
		[{ devices: [{ macAddress: "aa-bb-cc-dd-ee-01" }] }, "devices"],
		[{ devices: [{ ipAddress: "nas fritz box" }] }, "devices"],
		[{ devices: [{ ipAddress: "" }] }, "devices"],
		// Nothing that ping or arp-scan would take as an option
		[{ devices: [{ ipAddress: "-c" }] }, "devices"],
		[{ network: "-l" }, "network"],
		[{ interface: "-eth0" }, "interface"],
		// An IPv4 address or network in CIDR notation
		[{ network: "192.168.178.0/24 --interface=eth0" }, "network"],
		// One interface name
		[{ interface: "eth0 wlan0" }, "interface"],
		[{ interface: "" }, "interface"],
		[{ interface: ["eth0"] }, "interface"],
		// Seconds, more than 0, and not milliseconds
		[{ updateInterval: 0 }, "updateInterval"],
		[{ updateInterval: "60" }, "updateInterval"],
		[{ updateInterval: 60 * 1000 }, "updateInterval"],
		[{ keepAlive: -300 }, "keepAlive"],
		[{ keepAlive: null }, "keepAlive"],
		[{ keepAlive: 5 * 60 * 1000 }, "keepAlive"]
	];
	for (const [config, option] of invalid) {
		const { helper, commands, timers, notifications, logs } = createHelper({ config });
		await settle();
		helper.socketNotificationReceived("GET_DEVICES");
		assert.deepEqual(notifications.map(({ payload }) => [payload.devices, payload.error.code, payload.error.option]), [[[], "INVALID_OPTION", option]], JSON.stringify(config));
		assert.equal(logs.length, 1);
		assert.ok(logs[0].startsWith(`error: The option ${option} is not valid: `), logs[0]);
		assert.equal(commands.length + timers.size, 0);
	}
});

test("reports the value that is not valid, and for devices the device", () => {
	const devices = [{ macAddress: "aa:bb:cc:dd:ee:01", name: "Anna" }, { macAddress: "aa-bb-cc-dd-ee-02", name: "Ben" }];
	const { helper, notifications, logs } = createHelper({ config: { devices } });
	helper.socketNotificationReceived("GET_DEVICES");
	const detail = "{\"macAddress\":\"aa-bb-cc-dd-ee-02\",\"name\":\"Ben\"}";
	assert.deepEqual(notifications[0].payload.error, { code: "INVALID_OPTION", option: "devices", detail });
	assert.deepEqual(logs, [`error: The option devices is not valid: ${detail}`]);
	assert.deepEqual(createHelper({ config: { updateInterval: "60" } }).logs, ["error: The option updateInterval is not valid: \"60\""]);
});

test("accepts valid options", async () => {
	const valid = [
		{ devices: [{ macAddress: "AA:BB:CC:DD:EE:01" }, { ipAddress: "nas.fritz.box" }, { ipAddress: "192.168.178.10" }] },
		{ network: "192.168.178.0/24" },
		{ network: "192.168.178.10" },
		{ interface: "wlan0" },
		{ interface: "enp0s31f6" },
		{ updateInterval: 30, keepAlive: 0.5 },
		{ updateInterval: 3600, keepAlive: 86400 }
	];
	for (const config of valid) {
		const { notifications } = createHelper({ config });
		await settle();
		assert.equal(notifications[0].payload.error, null, JSON.stringify(config));
	}
});

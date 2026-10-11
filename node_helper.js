/* MagicMirror²
 * Node Helper: MMM-NetworkScanner
 *
 * By Ian Perrin http://ianperrin.com
 * MIT Licensed.
 */

const { execFile } = require("node:child_process");
const NodeHelper = require("node_helper");
const Log = require("logger");

// The options of the scan and their defaults. The node helper reads them from
// config.js only: any device that the ipWhitelist of MagicMirror² lets in can
// send socket notifications to it.
const DEFAULTS = {
	devices: [],
	network: undefined,
	interface: undefined,
	updateInterval: 60,
	keepAlive: 300
};

// The path of arp-scan in Debian and Raspberry Pi OS. With the capability
// cap_net_raw, it scans without sudo, see the README.
const ARP_SCAN = "/usr/sbin/arp-scan";

const MAC_ADDRESS = /^[\da-f]{2}(:[\da-f]{2}){5}$/i;
// An IP address or a host name, which must not look like an option of ping
const HOST = /^[A-Za-z\d.][A-Za-z\d.-]*$/;
// An IPv4 address or network in CIDR notation, e.g. 192.168.178.0/24.
// arp-scan reports numbers out of range itself.
const NETWORK = /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/;
const INTERFACE = /^[A-Za-z0-9][\w.:-]*$/;

// What the log says about the problems of a scan, before their detail
const PROBLEMS = {
	ARP_SCAN_NOT_FOUND: `arp-scan is not installed at ${ARP_SCAN}. Install it with`,
	ARP_SCAN_NO_PERMISSION: "arp-scan is not allowed to scan the network. Allow it with",
	SCAN_FAILED: "The network scan failed"
};

module.exports = NodeHelper.create({
	// getServerModuleConfig() came with MagicMirror² 2.38.0
	requiresVersion: "2.38.0",

	start() {
		this.config = { ...DEFAULTS, ...this.getServerModuleConfig() };
		// No devices to send until the first scan has finished
		this.state = null;
		this.error = null;
		const { option, value } = findInvalidOption(this.config) ?? {};
		if (option) {
			const detail = JSON.stringify(value);
			Log.error(`The option ${option} is not valid: ${detail}`);
			this.state = { devices: [], error: { code: "INVALID_OPTION", option, detail } };
			return;
		}
		this.devices = this.config.devices.map((device) => ({
			// arp-scan prints the MAC addresses in lower case
			macAddress: device.macAddress?.toLowerCase(),
			ipAddress: device.ipAddress,
			name: device.name ?? device.macAddress ?? device.ipAddress,
			icon: device.icon ?? null,
			color: device.color ?? null,
			online: false,
			lastSeen: null
		}));
		this.scan();
	},

	stop() {
		this.stopped = true;
		clearTimeout(this.timer);
	},

	// The module asks for the devices once all modules have started
	socketNotificationReceived(notification) {
		if (notification === "GET_DEVICES" && this.state) {
			this.sendSocketNotification("DEVICES", this.state);
		}
	},

	// Scan the network, send the devices to the module, and scan again
	// updateInterval seconds after the scan has finished. So there is one scan
	// at a time, however many browsers show the mirror.
	async scan() {
		try {
			const found = await this.findAddresses();
			const now = Date.now();
			for (const device of this.devices) {
				if (found.has(device.macAddress ?? device.ipAddress)) {
					device.lastSeen = now;
				}
				// Sleeping phones skip answers, so a device counts as online for
				// keepAlive seconds after it last answered
				device.online = device.lastSeen !== null && now - device.lastSeen < this.config.keepAlive * 1000;
			}
			Log.debug(`These addresses answered: ${[...found].join(", ") || "none"}`);
			if (this.error) {
				Log.info("The network scan works again");
			}
			this.error = null;
		} catch (error) {
			// Keep the devices as they are: a failed scan does not tell who left.
			// execFile() throws some errors of a command that cannot start, e.g.
			// EPERM, instead of passing them to its callback.
			if (!this.stopped) {
				this.setError(Object.hasOwn(PROBLEMS, error.code) ? error : { code: "SCAN_FAILED", detail: error.message });
			}
		}
		// When MagicMirror² stops while a scan runs, report nothing and do not
		// scan again: systemd, for example, stops arp-scan and ping with it
		if (this.stopped) {
			return;
		}
		this.state = {
			// What the module shows of the devices
			devices: this.devices.map(({ name, icon, color, online, lastSeen }) => ({ name, icon, color, online, lastSeen })),
			error: this.error
		};
		this.sendSocketNotification("DEVICES", this.state);
		this.timer = setTimeout(() => this.scan(), this.config.updateInterval * 1000);
	},

	// Log a problem when it starts or changes, not after every scan
	setError({ code, detail }) {
		if (code !== this.error?.code || detail !== this.error?.detail) {
			Log.error(`${PROBLEMS[code]}: ${detail}`);
		}
		this.error = { code, detail };
	},

	// Run arp-scan for the devices with a MAC address and ping the others, all
	// at the same time. Resolves with the addresses that answered. If commands
	// fail, rejects with the problem of arp-scan, or else of the first device
	// whose ping failed, but only when all commands have finished, so that the
	// next scan cannot start while one still runs.
	async findAddresses() {
		const hosts = this.devices.filter((device) => device.ipAddress).map((device) => device.ipAddress);
		const results = await Promise.allSettled([
			this.devices.some((device) => device.macAddress) ? arpScan(this.config) : [],
			...hosts.map((host) => ping(host))
		]);
		const failed = results.find((result) => result.status === "rejected");
		if (failed) {
			throw failed.reason;
		}
		const [macAddresses, ...answers] = results.map((result) => result.value);
		return new Set([...macAddresses, ...hosts.filter((host, index) => answers[index])]);
	}
});

// The first option that is not valid, if any, with its value, or for devices
// the first device that is not valid
function findInvalidOption(config) {
	if (!Array.isArray(config.devices) || config.devices.length === 0) {
		return { option: "devices", value: config.devices };
	}
	const index = config.devices.findIndex((device) => !isValidDevice(device));
	if (index !== -1) {
		return { option: "devices", value: config.devices[index] };
	}
	if (config.network !== undefined && !matches(config.network, NETWORK)) {
		return { option: "network", value: config.network };
	}
	if (config.interface !== undefined && !matches(config.interface, INTERFACE)) {
		return { option: "interface", value: config.interface };
	}
	// In seconds, at most an hour or a day: a larger value is likely in
	// milliseconds, as the default modules of MagicMirror² count
	for (const [option, max] of [["updateInterval", 3600], ["keepAlive", 86400]]) {
		if (!(Number.isFinite(config[option]) && config[option] > 0 && config[option] <= max)) {
			return { option, value: config[option] };
		}
	}
	return null;
}

// A device needs either a MAC address or an IP address or host name
function isValidDevice(device) {
	if (device?.macAddress !== undefined) {
		return device.ipAddress === undefined && matches(device.macAddress, MAC_ADDRESS);
	}
	return matches(device?.ipAddress, HOST);
}

function matches(value, pattern) {
	return typeof value === "string" && pattern.test(value);
}

// Resolves with the MAC addresses that answered arp-scan. Rejects with the
// problem and its detail: arp-scan exits with 1 for every error, so its error
// output tells them apart.
function arpScan({ network, interface: name }) {
	const args = ["--quiet", "--plain", ...(name ? [`--interface=${name}`] : []), network ?? "--localnet"];
	return new Promise((resolve, reject) => {
		execFile(ARP_SCAN, args, { timeout: 30000 }, (error, stdout, stderr) => {
			if (!error) {
				// One line for each host that answered: IP<TAB>MAC, followed by the
				// source MAC address of the frame in brackets if it differs
				resolve(stdout.split("\n").map((line) => line.split(/\s+/)[1]).filter(Boolean));
			} else if (error.code === "ENOENT") {
				reject({ code: "ARP_SCAN_NOT_FOUND", detail: "sudo apt install arp-scan" });
			} else if (/permission|not permitted/i.test(stderr)) {
				reject({ code: "ARP_SCAN_NO_PERMISSION", detail: `sudo setcap cap_net_raw+ep ${ARP_SCAN}` });
			} else if (error.killed) {
				// execFile() stopped it after the timeout
				reject({ code: "SCAN_FAILED", detail: "arp-scan did not finish within 30 seconds" });
			} else {
				reject({ code: "SCAN_FAILED", detail: firstLine(stderr) || firstLine(error.message) });
			}
		});
	});
}

// Resolves with whether the host answered one ping within a second. Rejects
// if ping fails, e.g. if it cannot resolve the host name.
function ping(host) {
	return new Promise((resolve, reject) => {
		execFile("ping", ["-c", "1", "-W", "1", host], { timeout: 10000 }, (error, stdout, stderr) => {
			if (!error) {
				resolve(true);
			} else if (error.code === 1) {
				// No answer
				resolve(false);
			} else if (error.killed) {
				reject({ code: "SCAN_FAILED", detail: `ping ${host} did not finish within 10 seconds` });
			} else {
				// e.g. "ping: nas.fritz.box: Name or service not known"
				reject({ code: "SCAN_FAILED", detail: firstLine(stderr) || firstLine(error.message) });
			}
		});
	});
}

// The first line of a text that is not empty
function firstLine(text) {
	return text.split("\n").map((line) => line.trim()).find(Boolean);
}

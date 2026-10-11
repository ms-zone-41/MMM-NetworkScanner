/* MagicMirror²
 * Node Helper: MMM-NetworkScanner
 *
 * By Ian Perrin http://ianperrin.com
 * MIT Licensed.
 */

const NodeHelper = require("node_helper");
const Log = require("logger");
const ping = require("ping");
const sudo = require("sudo");

// The options of the scan and their defaults. The node helper reads them from
// config.js only: any device that the ipWhitelist of MagicMirror² lets in can
// send socket notifications to it.
const DEFAULTS = {
	devices: [],
	network: undefined,
	updateInterval: 60,
	keepAlive: 300
};

module.exports = NodeHelper.create({
	// getServerModuleConfig() came with MagicMirror² 2.38.0
	requiresVersion: "2.38.0",

	start() {
		this.config = { ...DEFAULTS, ...this.getServerModuleConfig() };
		this.devices = this.config.devices.map((device) => ({
			...device,
			// arp-scan prints the MAC addresses in lower case
			macAddress: device.macAddress?.toLowerCase(),
			name: device.name ?? device.macAddress ?? device.ipAddress,
			online: false,
			lastSeen: null
		}));
		// No devices to send until the first scan has finished
		this.state = null;
		this.scan();
	},

	stop() {
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
		this.state = { devices: this.devices };
		this.sendSocketNotification("DEVICES", this.state);
		this.timer = setTimeout(() => this.scan(), this.config.updateInterval * 1000);
	},

	// Run arp-scan for the devices with a MAC address and ping the others, all
	// at the same time. Resolves with the addresses that answered.
	async findAddresses() {
		const hosts = this.devices.filter((device) => device.ipAddress).map((device) => device.ipAddress);
		const [macAddresses, ...answers] = await Promise.all([
			this.devices.some((device) => device.macAddress) ? arpScan(this.config.network) : [],
			...hosts.map((host) => probe(host))
		]);
		return new Set([...macAddresses, ...hosts.filter((host, index) => answers[index])]);
	}
});

// Resolves with the MAC addresses that answered arp-scan
function arpScan(network) {
	return new Promise((resolve) => {
		const arp = sudo(["arp-scan", "--quiet", "--plain", network ?? "--localnet"]);
		let stdout = "";
		let stderr = "";
		arp.stdout.on("data", (data) => {
			stdout += data;
		});
		arp.stderr.on("data", (data) => {
			stderr += data;
		});
		arp.on("error", (error) => {
			Log.debug(`arp-scan failed: ${error.message}`);
			resolve([]);
		});
		arp.on("close", (code) => {
			if (code !== 0) {
				Log.debug(`arp-scan failed with code ${code}: ${stderr}`);
			}
			// One line for each host that answered: IP<TAB>MAC
			resolve(stdout.split("\n").map((line) => line.split("\t")[1]).filter(Boolean));
		});
	});
}

// Resolves with whether the host answered ping
function probe(host) {
	return new Promise((resolve) => {
		ping.sys.probe(host, (alive) => resolve(alive === true));
	});
}

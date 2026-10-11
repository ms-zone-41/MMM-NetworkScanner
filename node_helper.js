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

module.exports = NodeHelper.create({

	// Override socketNotificationReceived method.
	socketNotificationReceived: function (notification, payload) {
		Log.debug(this.name + " received " + notification);

		if (notification === "CONFIG") {
			this.config = payload;
			return true;
		}

		if (notification === "SCAN_NETWORK") {
			this.scanNetworkMAC();
			this.scanNetworkIP();
			return true;
		}
	},

	scanNetworkMAC: function () {
		Log.debug(this.name + " is performing arp-scan");

		var self = this;
		// Target hosts/network supplied in config or entire localnet
		var arpHosts = this.config.network || "-l";
		var arp = sudo(["arp-scan", "-q", arpHosts]);
		var buffer = "";
		var errstream = "";
		var discoveredMacAddresses = [];

		arp.stdout.on("data", function (data) {
			buffer += data;
		});

		arp.stderr.on("data", function (data) {
			errstream += data;
		});

		arp.on("error", function (err) {
			errstream += err;
		});

		arp.on("close", function (code) {
			if (code !== 0) {
				Log.debug(self.name + " received an error running arp-scan: " + code + " - " + errstream);
			} else {
				// Parse the ARP-SCAN table response
				var rows = buffer.split("\n");
				for (var i = 2; i < rows.length; i++) {
					var cells = rows[i].split("\t").filter(String);
					if (cells && cells[1]) {
						discoveredMacAddresses.push(cells[1].toUpperCase());
					}
				}
			}

			// The configured devices that arp-scan found, in their order
			var discoveredDevices = self.config.devices.filter(function (device) {
				return device.macAddress && discoveredMacAddresses.includes(device.macAddress.toUpperCase());
			});
			discoveredDevices.forEach(function (device) {
				device.online = true;
			});
			Log.debug(self.name + " arp scan addresses: ", discoveredMacAddresses);
			Log.debug(self.name + " arp scan devices: ", discoveredDevices);
			self.sendSocketNotification("MAC_ADDRESSES", discoveredDevices);
			return;
		});
	},

	scanNetworkIP: function () {
		if (!this.config.devices) {
			return;
		}

		Log.debug(this.name + " is performing ip address scan");

		var discoveredDevices = [];
		var self = this;
		this.config.devices.forEach(function (device) {
			Log.debug(self.name + " is checking device: ", device.name);
			if ("ipAddress" in device) {
				Log.debug(self.name + " is pinging ", device.ipAddress);
				ping.sys.probe(device.ipAddress, function (isAlive) {
					device.online = isAlive;
					Log.debug(self.name + " ping result: ", [device.name, device.online]);
					if (device.online) {
						discoveredDevices.push(device);
					}
					self.sendSocketNotification("IP_ADDRESS", device);
				});
			}
		});
	}

});

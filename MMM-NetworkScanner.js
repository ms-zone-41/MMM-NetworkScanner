/* global moment */
/* MagicMirror²
 * Module: MMM-NetworkScanner
 *
 * By Ian Perrin http://ianperrin.com
 * MIT Licensed.
 */

Module.register("MMM-NetworkScanner", {

	// The options of the display. The node helper reads the options of the
	// scan from config.js itself.
	defaults: {
		showOffline: true,
		showLastSeen: false,

		residents: [], // names of devices
		occupiedCMD: null, // { notification, payload }
		vacantCMD: null,

		colored: false, // show devices colorcoded with color defined in devices [] //
		coloredSymbolOnly: false, // show symbol only in color //
		showLastSeenWhenOffline: false, // show last seen only when offline //

		// sjj: show table as device rows or as device columns
		showDeviceColumns: false,
		coloredState: false
	},

	// The node helper reads its options with getServerModuleConfig()
	requiresVersion: "2.38.0",

	start() {
		Log.info(`Starting module: ${this.name}`);

		// The devices from the node helper, and the problem of the last scan
		this.devices = null;
		this.error = null;
		// Whether a resident is at home, unknown until the first devices arrive
		this.anyoneHome = null;

		moment.locale(config.language);
	},

	// Subclass getStyles method.
	getStyles: function () {
		return ["MMM-NetworkScanner.css", "font-awesome.css"];
	},

	// Subclass getScripts method.
	getScripts: function () {
		return ["moment.js"];
	},

	getTranslations() {
		return {
			en: "translations/en.json",
			de: "translations/de.json"
		};
	},

	// Ask for the devices once all modules have started: MagicMirror² does not
	// deliver the notifications that a module sends before, e.g. occupiedCMD
	notificationReceived(notification) {
		if (notification === "ALL_MODULES_STARTED") {
			this.sendSocketNotification("GET_DEVICES");
		}
	},

	// The node helper sends the devices after each scan
	socketNotificationReceived(notification, payload) {
		if (notification === "DEVICES") {
			this.devices = payload.devices;
			this.error = payload.error;
			this.validateDevices();
			// While the scan fails, the devices show the last scan that worked,
			// which does not tell who came or left since
			if (!this.error && this.config.residents.length > 0) {
				this.updateResidents();
			}
			this.updateDom();
		}
	},

	// Send occupiedCMD when the first resident comes home and vacantCMD when the
	// last one leaves, and one of them when the first devices arrive
	updateResidents() {
		const anyoneHome = this.devices.some((device) => device.online && this.config.residents.includes(device.name));
		if (anyoneHome !== this.anyoneHome) {
			this.anyoneHome = anyoneHome;
			const command = anyoneHome ? this.config.occupiedCMD : this.config.vacantCMD;
			if (command) {
				this.sendNotification(command.notification, command.payload);
			}
		}
	},

	// Override dom generator.
	getDom: function () {
		var self = this;

		var wrapper = document.createElement("div");
		wrapper.classList.add("small");

		// Display a loading message
		if (!this.devices) {
			wrapper.innerHTML = this.translate("LOADING");
			return wrapper;
		}

		if (this.error) {
			wrapper.appendChild(this.getWarning());
		}

		// Display device status
		var deviceTable = document.createElement("table");
		deviceTable.classList.add("deviceTable", "small");
		if (this.error) {
			deviceTable.classList.add("ns-stale");
		}

		// sjj: Show devices in columns
		// generate header row and device state row

		var headerRow = document.createElement("tr");
		headerRow.classList.add("headerRow", "dimmed");
		var devStateRow = document.createElement("tr");
		devStateRow.classList.add("devStateRow", "dimmed");

		this.devices.forEach(function (device) {
			if (device.online || self.config.showOffline) {
				// device row
				var deviceRow = document.createElement("tr");
				var deviceOnline = (device.online ? "bright" : "dimmed");
				deviceRow.classList.add("deviceRow", deviceOnline);

				// Icon

				var deviceCell = document.createElement("td");
				deviceCell.classList.add("deviceCell");
				var icon = document.createElement("i");
				icon.classList.add("fa", "fa-fw", "fa-" + device.icon);

				if (self.config.colored) {
					icon.style.cssText = "color: " + device.color;
				}

				if (self.config.colored && !self.config.coloredSymbolOnly && device.lastSeen) {
					deviceCell.style.cssText = "color: " + device.color;
				}

				deviceCell.appendChild(icon);
				deviceCell.innerHTML += device.name;

				deviceRow.appendChild(deviceCell);

				// When last seen
				if ((self.config.showLastSeen && device.lastSeen && !self.config.showLastSeenWhenOffline)
					|| (self.config.showLastSeen && !device.lastSeen && self.config.showLastSeenWhenOffline)) {
					var dateCell = document.createElement("td");
					dateCell.classList.add("dateCell", "dimmed", "light");
					if (device.lastSeen) {
						dateCell.innerHTML = moment(device.lastSeen).fromNow();
					}
					deviceRow.appendChild(dateCell);
				}

				// sjj: Append a new row if showDeviceColumns and showInNewRow are both true

				if (self.config.showDeviceColumns && device.showInNewRow) {
					// append the previously processed devices to the table
					deviceTable.appendChild(headerRow);
					deviceTable.appendChild(devStateRow);

					// generate new line contents
					headerRow = document.createElement("tr");
					headerRow.classList.add("headerRow", "dimmed");
					devStateRow = document.createElement("tr");
					devStateRow.classList.add("devStateRow", "dimmed");
				}

				// sjj: fill also header and devState row
				// header row
				var headerDevCell = document.createElement("td");
				headerDevCell.classList.add("headerDevCell");
				headerDevCell.innerHTML += device.name;

				headerRow.appendChild(headerDevCell);

				// device state row
				var devStateCell = document.createElement("td");
				devStateCell.classList.add("devStateCell");

				// color online / offline
				if (self.config.coloredState) {
					if (device.online) {
						icon.style.cssText = "color: " + device.colorStateOnline;
					} else {
						icon.style.cssText = "color: " + device.colorStateOffline;
					};
				}

				devStateCell.appendChild(icon);

				devStateRow.appendChild(devStateCell);

				// sjj: show as Device rows or as Device columns
				if (!self.config.showDeviceColumns) {
					deviceTable.appendChild(deviceRow);
				}
			}
		});

		// sjj: show as Device rows or as Device columns
		if (self.config.showDeviceColumns) {
			deviceTable.appendChild(headerRow);
			deviceTable.appendChild(devStateRow);
		}

		if (deviceTable.hasChildNodes()) {
			wrapper.appendChild(deviceTable);
		} else if (!this.error) {
			// Display no devices online message
			wrapper.innerHTML = this.translate("NO_DEVICES_ONLINE");
		}

		return wrapper;
	},

	// The problem of the last scan, and below it its detail from the node
	// helper: the command that solves it, what went wrong, or the value that is
	// not valid
	getWarning() {
		const warning = document.createElement("div");
		warning.className = "ns-warning";
		const icon = document.createElement("i");
		icon.className = "fa-solid fa-triangle-exclamation";
		warning.append(icon, this.translate(this.error.code, this.error));
		if (this.error.detail) {
			const detail = document.createElement("code");
			detail.textContent = this.error.detail;
			warning.append(detail);
		}
		return warning;
	},

	// Add the defaults of the keys that only the display uses
	validateDevices: function () {
		this.devices.forEach(function (device) {
			if (!Object.hasOwn(device, "icon")) {
				device.icon = "question";
			}
			if (!Object.hasOwn(device, "color")) {
				device.color = "#ffffff";
			}
			// sjj: coloredState
			if (!Object.hasOwn(device, "colorStateOnline")) {
				device.colorStateOnline = "#ffffff";
			}
			if (!Object.hasOwn(device, "colorStateOffline")) {
				device.colorStateOffline = "#ffffff";
			}
			// sjj show device in a new rox id mode is show in rows
			if (!Object.hasOwn(device, "showInNewRow")) {
				device.showInNewRow = false;
			}
		});
	}

});

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
		showLastSeen: false, // true, false or "offline"
		columns: 1, // devices per row
		residents: [], // names of devices
		occupiedCMD: null, // { notification, payload }
		vacantCMD: null
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
	},

	getStyles() {
		return ["font-awesome.css", "MMM-NetworkScanner.css"];
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

	// The problem of the scan, if there is one, and the devices
	getDom() {
		const wrapper = document.createElement("div");
		wrapper.className = "small";

		if (!this.devices) {
			wrapper.classList.add("dimmed");
			wrapper.textContent = this.translate("LOADING");
			return wrapper;
		}

		if (this.error) {
			wrapper.append(this.getWarning());
		}

		const devices = this.devices.filter((device) => device.online || this.config.showOffline);
		// A warning replaces NO_DEVICES_ONLINE, e.g. for an option that is not
		// valid, which comes without devices
		if (devices.length > 0) {
			wrapper.append(this.getTable(devices));
		} else if (!this.error) {
			wrapper.classList.add("dimmed");
			wrapper.append(this.translate("NO_DEVICES_ONLINE"));
		}
		return wrapper;
	},

	// The devices, in rows of the number of columns
	getTable(devices) {
		const table = document.createElement("table");
		// While the scan fails, the devices are those of the last scan that
		// worked. The class ns-stale lets custom.css style them.
		if (this.error) {
			table.className = "ns-stale";
		}
		let row;
		devices.forEach((device, index) => {
			// columns: 0 shows a list, like columns: 1
			if (index % Math.max(1, this.config.columns) === 0) {
				row = document.createElement("tr");
				table.append(row);
			}
			row.append(this.getNameCell(device));
			if (this.config.showLastSeen) {
				row.append(...this.getLastSeenCells(device));
			}
		});
		return table;
	},

	// The name of a device, after its icon in its color if it has one: bright
	// while the device is online, dimmed while it is offline or the scan fails,
	// as the last scan that worked does not tell who is online now. The classes
	// ns-online and ns-offline let custom.css style the devices.
	getNameCell(device) {
		const name = document.createElement("td");
		const bright = device.online && !this.error;
		name.className = `ns-name ${device.online ? "ns-online" : "ns-offline"} ${bright ? "bright" : "dimmed"}`;
		if (device.icon) {
			const icon = document.createElement("i");
			icon.className = `fa-solid fa-fw fa-${device.icon}`;
			if (device.color) {
				icon.style.color = device.color;
			}
			name.append(icon);
		}
		name.append(device.name);
		return name;
	},

	// The time since a device last answered, in a cell for the value and one
	// for the unit, e.g. "5" and "m". With showLastSeen "offline", the cells of
	// the devices that are online stay empty, so that the columns line up.
	getLastSeenCells(device) {
		const [value, unit] = this.config.showLastSeen === "offline" && device.online ? ["", ""] : this.formatLastSeen(device.lastSeen);
		const valueCell = document.createElement("td");
		valueCell.className = "ns-time-value dimmed light";
		valueCell.textContent = value;
		const unitCell = document.createElement("td");
		unitCell.className = "ns-time-unit dimmed light";
		unitCell.textContent = unit;
		return [valueCell, unitCell];
	},

	// The time since lastSeen as a number and a unit: minutes in the first
	// hour, then hours up to 100 hours, then days. The units are m, h and d in
	// every language, so that they stay short.
	formatLastSeen(lastSeen) {
		if (lastSeen === null) {
			return ["-", ""];
		}
		// lastSeen is from the clock of the server, which may be ahead of the
		// clock of the browser
		const minutes = Math.max(0, Math.floor((Date.now() - lastSeen) / 60000));
		const hours = Math.floor(minutes / 60);
		if (minutes < 60) {
			return [String(minutes), "m"];
		}
		if (hours < 100) {
			return [String(hours), "h"];
		}
		return [String(Math.floor(hours / 24)), "d"];
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
	}

});

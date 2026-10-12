# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The `color` of a device colors its icon only while the device is online and the scan works. Otherwise the icon is dimmed like the name
- A device that was never seen shows an en dash (–) instead of a hyphen (-)

### Fixed

- While the scan fails, the devices faded to half their brightness, so the dimmed names and times were hard to read. All devices are now dimmed, like those that are offline
- A long message widened its region, e.g. the left column into the center one, and stretched the other modules in it. It now wraps at the width of the region

## [2.0.0] - 2026-10-11

A rewrite, now maintained at [ms-zone-41/MMM-NetworkScanner](https://github.com/ms-zone-41/MMM-NetworkScanner). The configuration changes, see [Upgrading from version 1](README.md#upgrading-from-version-1).

### Added

- Messages on the mirror that say why the module cannot scan, e.g. with the command that solves the problem
- The option `interface`, for a mirror on more than one network
- The times the devices were last seen survive a restart of MagicMirror²
- English and German translations

### Changed

- Requires MagicMirror² 2.38.0 or newer
- arp-scan runs without sudo, with the capability `cap_net_raw`, see the README
- The module has no dependencies anymore
- The module scans once for all browsers that show the mirror, instead of once for each browser
- A failed scan, e.g. because ping cannot resolve a host name, keeps the devices as they were and shows a message, instead of showing the devices as offline
- `columns` replaces `showDeviceColumns` and the `showInNewRow` of the devices
- The `color` of a device colors its icon. The classes `ns-online` and `ns-offline` replace the other color options
- The time since a device was last seen is short, e.g. `5 m`, `2 h` or `4 d`. `showLastSeen: "offline"` replaces `showLastSeenWhenOffline`
- Only solid Font Awesome icons show: brand icons and outline icons whose names end in `-o` no longer do. A device without an icon shows none instead of a question mark
- `updateInterval` is 60 seconds by default instead of 20, and `keepAlive` 300 seconds instead of 180
- The module also sends `occupiedCMD` when it starts and a resident is at home

### Removed

- `showUnknown`, `sort`, `debug`, the `showOffline` of each device and `network: "-l"`
- `scripts/arps2mm.sh`: the README shows how to find the MAC addresses

### Fixed

- The node helper stopped scanning after a restart of MagicMirror² ([ianperrin/MMM-NetworkScanner#57](https://github.com/ianperrin/MMM-NetworkScanner/issues/57))
- `keepAlive` only worked with `showOffline` ([ianperrin/MMM-NetworkScanner#50](https://github.com/ianperrin/MMM-NetworkScanner/issues/50))
- Devices that answered through some Wi-Fi repeaters were never found
- Names that looked like HTML showed wrongly, e.g. `Ben <Phone>` as `Ben`

### Security

- Any device that could connect to MagicMirror² could send the node helper options, which it passed to arp-scan, run as root. The node helper now reads its options from `config/config.js` only

## 1.0.0 and earlier

Released by Ian Perrin and in the forks of spitzlbergerj and nsprawling, without a changelog.

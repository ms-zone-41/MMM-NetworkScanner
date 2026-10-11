import { defineConfig } from "eslint/config";
import globals from "globals";
import js from "@eslint/js";
import { configs as packageJsonConfigs } from "eslint-plugin-package-json";
import stylistic from "@stylistic/eslint-plugin";

export default defineConfig([
	{
		files: ["**/*.js", "**/*.mjs"],
		extends: [
			js.configs.recommended,
			// The code style of MagicMirror
			stylistic.configs.customize({ indent: "tab", quotes: "double", semi: true, commaDangle: "never", braceStyle: "1tbs", arrowParens: true })
		]
	},
	{
		// Runs in the browser of the mirror, with the globals of MagicMirror
		files: ["MMM-NetworkScanner.js"],
		languageOptions: {
			sourceType: "script",
			globals: {
				...globals.browser,
				Log: "readonly",
				Module: "readonly"
			}
		}
	},
	{
		files: ["node_helper.js", "tests/**/*.js"],
		languageOptions: {
			sourceType: "commonjs",
			globals: globals.node
		}
	},
	packageJsonConfigs.recommended,
	{
		// MagicMirror loads the module from its directory; it is not published
		// as an npm package
		files: ["package.json"],
		rules: {
			"package-json/require-exports": "off",
			"package-json/require-files": "off",
			"package-json/require-sideEffects": "off"
		}
	}
]);

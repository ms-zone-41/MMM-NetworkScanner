import { defineConfig } from "eslint/config";
import globals from "globals";
import js from "@eslint/js";
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
	}
]);

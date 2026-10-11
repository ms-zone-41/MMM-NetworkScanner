import { defineConfig } from "eslint/config";
import globals from "globals";
import js from "@eslint/js";

export default defineConfig([
	{
		files: ["**/*.js", "**/*.mjs"],
		extends: [js.configs.recommended]
	},
	{
		// Runs in the browser of the mirror, with the globals of MagicMirror
		files: ["MMM-NetworkScanner.js"],
		languageOptions: {
			sourceType: "script",
			globals: {
				...globals.browser,
				Log: "readonly",
				Module: "readonly",
				config: "readonly"
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

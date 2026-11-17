// The engine gives a module no way to read its own manifest, so the version is written here too.
// scripts/check-version.mjs fails CI when it differs from .claude-plugin/plugin.json.
export const VERSION = '0.4.4'

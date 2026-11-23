import { mkdir, symlink, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";

// Never attach this fixture to a real profile or copy credentials/config from it.
const [directory, portText = "18475"] = process.argv.slice(2);
if (!directory || !/^[1-9][0-9]{0,4}$/.test(portText) || +portText > 65535) {
	throw new Error("usage: bun test/fixtures/launch.ts <NEW private fixture directory> [loopback-port]");
}
if (Bun.semver.order(Bun.version, "1.4.4") < 0) {
	throw new Error("Use Bun 1.4.4+ for the fixture; DEBUG.md includes repo-local setup for older installations.");
}
const executable = Bun.which("omp");
if (!executable) throw new Error("Stock omp 19.1.0 must be on PATH");
const root = resolve(directory);
await mkdir(root, { mode: 0o700 }); // EEXIST is intentional: don't reuse an old mailbox/profile.
const home = join(root, "home");
const config = join(home, ".away-fixture");
const agent = join(config, "profiles", "away-fixture", "agent");
const installed = join(agent, "extensions", "omp-away");
const cwd = join(root, "work");
const mail = join(root, "mail");
await Promise.all([mkdir(join(agent, "extensions"), { recursive: true }), mkdir(cwd), mkdir(mail)]);
await symlink(resolve(import.meta.dir, "../.."), installed, process.platform === "win32" ? "junction" : "dir");
await writeFile(join(agent, "config.yml"), [
	"collab:", `  relayUrl: ws://127.0.0.1:${portText}`, "  autoStart: control", "  displayName: Fixture",
	"ask:", "  timeout: 0", "startup:", "  setupWizard: false", "  checkUpdate: false",
	"marketplace:", "  autoUpdate: false", "modelRoles:", "  default: away-fixture/scripted", "  smol: away-fixture/scripted", "",
].join("\n"));
const env: Record<string, string> = {};
for (const key of ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TERM", "COLORTERM", "TERM_PROGRAM"]) {
	if (process.env[key]) env[key] = process.env[key]!;
}
Object.assign(env, {
	PATH: dirname(process.execPath) + delimiter + env.PATH,
	HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
	XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"),
	PI_CONFIG_DIR: ".away-fixture", PI_NO_TITLE: "1", OMP_AWAY_FIXTURE_MAIL: mail,
});
console.log(`Test-only mailbox: ${mail}`);
// Explicit-only discovery still resolves the installed package's omp.extensions manifest.
const child = Bun.spawn([executable, "--profile", "away-fixture", "--no-extensions", "-e", installed,
	"-e", join(import.meta.dir, "provider.ts"), "--tools", "ask", "--model", "away-fixture/scripted"],
	{ env, cwd, stdio: ["inherit", "inherit", "inherit"] });
process.exitCode = await child.exited;

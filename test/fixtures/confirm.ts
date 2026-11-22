import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const [directory, ordinal] = process.argv.slice(2);
if (!directory || !ordinal || !/^[1-9][0-9]*$/.test(ordinal)) {
	throw new Error("usage: bun test/fixtures/confirm.ts <fixture directory> <ask number>");
}
const mail = join(resolve(directory), "mail");
const { requestId } = JSON.parse(await readFile(join(mail, `ask-${ordinal}.json`), "utf8"));
if (typeof requestId !== "string" || !/^[0-9a-f-]{36}$/.test(requestId)) throw new Error("Invalid fixture offer");
const receipt = crypto.randomUUID();
const result = Bun.file(join(mail, `receipt-${receipt}`));
await mkdir(join(mail, `confirm-${requestId}-${receipt}`));
const deadline = Date.now() + 30_000;
while (!(await result.exists()) && Date.now() < deadline) await Bun.sleep(100);
if (!(await result.exists())) throw new Error("No delivery receipt in 30s; inspect the TUI. No Ask was cancelled by this deadline.");
console.log(await result.text());

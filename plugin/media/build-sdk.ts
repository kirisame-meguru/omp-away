// Release preparation, not runtime. From plugin/: bun media/build-sdk.ts
import { isBuiltin } from 'node:module';
import { join } from 'node:path';

const version = '19.1.0';
const root = join(import.meta.dir, '..');
const licenses: string[] = [];
for (const name of ['pi-coding-agent', 'pi-ai', 'pi-catalog', 'pi-utils', 'pi-natives']) {
	const dir = join(root, 'node_modules', '@oh-my-pi', name);
	const manifest = await Bun.file(join(dir, 'package.json')).json();
	if (manifest.name !== `@oh-my-pi/${name}` || manifest.version !== version) throw Error(`Expected ${name}@${version}`);
	const license = (await Bun.file(join(dir, 'LICENSE')).text()).trim().replaceAll('\r\n', '\n');
	if (!licenses.includes(license)) licenses.push(license);
}
// The 19.1 packaged host exposes these exact keys in its virtual module registry. Do not
// use --external '@oh-my-pi/*': the coding-agent and pi-ai root wildcards aren't expanded.
// Leave native bindings and authStorage/OAuth helpers on the host's own module instances.
const external = ['@oh-my-pi/pi-ai', '@oh-my-pi/pi-natives', '@oh-my-pi/pi-utils',
	// The named ./utils/* and ./wire/* exports (unlike the anonymous ./* fallback)
	// are included in the stock binary. Reuse its proxy policy and version cache.
	'@oh-my-pi/pi-ai/utils/proxy', '@oh-my-pi/pi-catalog/wire/codex', '@oh-my-pi/pi-catalog/wire/codex-version'];
const result = await Bun.build({
	entrypoints: [join(import.meta.dir, 'sdk-entry.ts')], target: 'bun', format: 'esm', root, metafile: true,
	plugins: [{ name: 'stock-omp-host', setup(build) {
		build.onResolve({ filter: /^@oh-my-pi\// }, ({ path }) => external.includes(path) ? { path, external: true } : undefined);
		build.onResolve({ filter: /^\.\/protocol(?:\.ts)?$/ }, ({ importer }) =>
			importer.replaceAll('\\', '/').endsWith('/src/live/transport.ts')
				? { path: join(root, 'src', 'media', 'protocol.ts') } : undefined);
	} }],
});
if (!result.success) throw new AggregateError(result.logs, 'Unable to package the pinned live SDK');
if (result.outputs.length !== 1) throw Error('Expected a single JavaScript SDK module, without native assets');
if (!result.metafile) throw Error('Missing SDK build input inventory');
for (const path of Object.keys(result.metafile.inputs)) {
	const file = path.replaceAll('\\', '/');
	if (file.includes('node_modules/') && !file.slice(file.lastIndexOf('node_modules/')).startsWith('node_modules/@oh-my-pi/pi-coding-agent/src/')) {
		throw Error(`Unexpected bundled SDK dependency: ${path}`);
	}
}
const output = await result.outputs[0].text();
const references = new Bun.Transpiler({loader:'js'}).scanImports(output);
for (const ref of references) {
	if (!isBuiltin(ref.path) && !external.includes(ref.path)) throw Error(`Unsupported stock-host import: ${ref.path}`);
}
const header = `/* Generated with bun media/build-sdk.ts from omp ${version}. Do not hand edit.\n${licenses.join('\n\n')}\n*/\n`;
const bytes = Buffer.byteLength(header) + result.outputs[0].size;
if (bytes > 128 * 1024) throw Error(`Unexpected SDK bundle growth: ${bytes} bytes`);
await Bun.write(join(root, 'src', 'media', 'live-sdk.generated.mjs'), header + output);
console.log(`Packaged stock omp ${version} live SDK: ${bytes} bytes`);

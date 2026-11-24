import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const licenses=new Set<string>();
for(const name of ['pi-coding-agent','pi-ai','pi-catalog','pi-utils','pi-natives']) {
	const directory=join(root,'node_modules/@oh-my-pi',name);
	const manifest=await Bun.file(join(directory,'package.json')).json();
	if(manifest.version!=='19.1.0') throw Error(`Expected ${name}@19.1.0`);
	licenses.add((await Bun.file(join(directory,'LICENSE')).text()).trim().replaceAll('\r\n','\n'));
}
const result=await Bun.build({
	entrypoints:[join(root,'tools/native-live.ts')],target:'bun',format:'esm',minify:false,
	external:['@oh-my-pi/pi-utils','@oh-my-pi/pi-ai','@oh-my-pi/pi-coding-agent/config/registry'],
	plugins:[{name:'native-bindings',setup(build){
		build.onResolve({filter:/(^|\/)registry$/},args=>args.path.startsWith('.') && args.importer.includes('pi-coding-agent') ? {path:'registry',namespace:'away-registry'}:undefined);
		build.onLoad({filter:/.*/,namespace:'away-registry'},()=>({
			loader:'js',contents:"import { lookup, register as nativeRegister } from '@oh-my-pi/pi-coding-agent/config/registry'; export const register = definition => lookup(definition.id) ?? nativeRegister(definition);",
		}));
		build.onResolve({filter:/\/session\/messages$/},()=>({path:'@oh-my-pi/pi-coding-agent',external:true}));
		build.onResolve({filter:/^@oh-my-pi\/pi-natives$/},()=>({path:'@oh-my-pi/pi-natives',external:true}));
	}}],
});
if(!result.success) throw new AggregateError(result.logs,'Native live bundle failed');
let source=await result.outputs[0].text();
source=source.replaceAll(root.replaceAll('\\','/'),'').replaceAll(root,'');
await Bun.write(join(root,'src/media/native-live.generated.mjs'),'/* Generated from omp 19.1.0 by tools/build-native-live.ts.\n'+[...licenses].join('\n\n')+'\n*/\n'+source);
console.log('Native live SDK bundle written');

import { randomBytes } from "node:crypto";

/** Local-only widget; commands refer to this specific comparison, not the most recent dialog. */
export class Enrollment {
	#pending?: {code:string; finish(accept:boolean):void};
	constructor(private readonly show:(text:string|undefined, comparison?:{emoji:string;code:string})=>void) {}
	get comparisonCode(): string | undefined { return this.#pending?.code }
	compare(emoji:string):Promise<boolean> {
		if (this.#pending) return Promise.resolve(false);
		const {promise,resolve}=Promise.withResolvers<boolean>();
		const code=randomBytes(6).toString("hex");
		const finish=(accept:boolean)=>{
			clearTimeout(timer); this.#pending=undefined; resolve(accept); this.show(undefined);
		};
		const timer=setTimeout(()=>finish(false),120_000);
		this.#pending={code,finish};
		try {this.show(`Compare all 12 on the phone: ${emoji}\nMatch: /away approve ${code}    Mismatch: /away deny ${code}`, {emoji,code})}
		catch {finish(false)}
		return promise;
	}
	decide(accept:boolean,code:string):boolean {
		if (!this.#pending || this.#pending.code!==code) return false;
		this.#pending.finish(accept); return true;
	}
	cancel() {this.#pending?.finish(false)}
}

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type Language = 'en' | 'ru';
export function isLanguage(value: unknown): value is Language { return value === 'en' || value === 'ru'; }

/** The handset owns its locale. The last authenticated choice also localizes desktop Away UI. */
export class LanguageStore {
	readonly #file: string;
	readonly #devices = new Map<string, Language>();
	#language: Language = 'en';
	#saveRequested = false;
	#writes: Promise<void> = Promise.resolve();
	constructor(stateDir: string) { this.#file = path.join(stateDir, 'language.json'); }
	async load(): Promise<void> {
		try {
			const file = Bun.file(this.#file);
			if (file.size > 64) throw Error('invalid-language-preference');
			const value: unknown = await file.json();
			if (!isLanguage(value)) throw Error('invalid-language-preference');
			this.#language = value;
			this.#saveRequested = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
	}
	get(device?: string): Language { return device ? this.#devices.get(device) ?? this.#language : this.#language; }
	/** Missing locale on a legacy handset must not override the conversation's language. */
	selected(device: string): Language | undefined { return this.#devices.get(device); }
	flush(): Promise<void> { return this.#writes; }
	set(device: string, language: Language): Promise<void> {
		this.#devices.set(device, language);
		if (this.#language === language && this.#saveRequested) return this.#writes;
		this.#language = language;
		this.#saveRequested = true;
		const write = this.#writes.catch(() => {}).then(async () => {
			const temporary = `${this.#file}.${crypto.randomUUID()}.tmp`;
			try {
				await fs.writeFile(temporary, JSON.stringify(language), { mode: 0o600 });
				await fs.rename(temporary, this.#file);
			} finally { await fs.rm(temporary, { force: true }); }
		});
		this.#writes = write;
		void write.catch(() => { if (this.#writes === write) this.#saveRequested = false; });
		return write;
	}
}

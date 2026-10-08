/** Pairing preferences: who drives by default, how much help, and when Pair checks in.
 * A preference is never edit authority: a model slice needs its own confirmed, bounded handoff. */
import wire from "../protocol/v1.schema.json" with { type: "json" };

export const DRIVERS = { human: "You drive", model: "The model drives slices you confirm" } as const;
export const HELP = { hints: "Hints", examples: "Examples, one next step at a time", solution: "Solution" } as const;
export const CHECKPOINTS = { each_step: "After each step", after_slice: "After a slice" } as const;
export type Settings = { driver: keyof typeof DRIVERS; assistance: keyof typeof HELP; checkpoint: keyof typeof CHECKPOINTS };

export const PRESETS: Record<string, Settings> = {
	"Guide me": { driver: "human", assistance: "hints", checkpoint: "each_step" },
	"Build together": { driver: "human", assistance: "examples", checkpoint: "each_step" },
	"Drive and review": { driver: "model", assistance: "solution", checkpoint: "after_slice" },
};
export const GUIDE_ME = PRESETS["Guide me"];

export const describe = (settings: Settings) =>
	`${settings.driver === "human" ? "you drive" : "model drives confirmed slices"} · ${settings.assistance} · `
	+ (settings.checkpoint === "each_step" ? "check in each step" : "review after a slice");

export const presetOf = (settings: Settings) =>
	Object.keys(PRESETS).find((name) => describe(PRESETS[name]) === describe(settings));

const is = (labels: object, value: unknown) => typeof value === "string" && Object.hasOwn(labels, value);
/** Confirmed settings from a session entry. Anything missing or malformed is unconfirmed, so Guide me applies. */
export const readSettings = (value: any): Settings | undefined =>
	value && is(DRIVERS, value.driver) && is(HELP, value.assistance) && is(CHECKPOINTS, value.checkpoint)
		? { driver: value.driver, assistance: value.assistance, checkpoint: value.checkpoint } : undefined;

const PATH = new RegExp(wire.$defs.annotateRequest.properties.path.pattern);
const HOME = ".pi/pi-pair";
/** The exact files a model slice may change: project-relative, never Pair's own files, and at least one.
 * ponytail: lexical check only, and paths with spaces are not expressible; task 3 resolves real paths and symlinks. */
export function parseTargets(text: string): string[] {
	const targets = [...new Set(text.split(/[\s,]+/).filter(Boolean))];
	if (!targets.length) throw new Error("Name at least one file the model may change.");
	const bad = targets.find((path) => !PATH.test(path) || path === HOME || path.startsWith(`${HOME}/`));
	if (bad) throw new Error(`${bad} is not a project file the model may change.`);
	return targets;
}

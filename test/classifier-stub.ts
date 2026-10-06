import { decision, TRIAL_SCHEMA, type ClassifierFactory } from "../src/classifier.ts";

/** Offline workflow tests never import the native runtime or load a model. */
export function classifierStub(choices: Record<string, string> = {}): ClassifierFactory {
	return async () => ({
		classify: async (_text, schema = TRIAL_SCHEMA) => {
			const labels = Object.keys(schema.labels);
			const choice = choices[schema.name] ?? labels[0];
			return { ...decision(labels.map((label) => label === choice ? 10 : 0), labels), tokens: 1, ms: 0 };
		},
		dispose: async () => {},
	});
}
export const readyClassifier = classifierStub();

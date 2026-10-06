import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import pair from "../../src/index.ts";
import { readyClassifier } from "../classifier-stub.ts";

/** Real Pi/Emacs protocol tests with no classifier files, native runtime, or network. */
export default function (pi: ExtensionAPI) { pair(pi, readyClassifier); }

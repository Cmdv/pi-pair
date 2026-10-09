import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import pair from "../../src/index.ts";

/** Real Pi/Emacs protocol tests with no network. */
export default function (pi: ExtensionAPI) { pair(pi); }

// The `loom` CLI's front door to THIS app: `pnpm doctor` loads it (`--config`), and `pnpm ls` /
// `pnpm logs` could discover it. `src/config.ts` exports the `buildApp()` factory (so tests can
// pick memory storage); the CLI needs the composed `LoomApp` as the default export.
// The CLI sets LOOM_NO_AUTOSTART while importing, so loading this never runs the flow.
import { buildApp } from "./src/config";

export default buildApp({ storage: { kind: "sqlite", dir: ".data" } });

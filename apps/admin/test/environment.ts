import { builtinEnvironments, type Environment } from "vitest/environments";

// React Router uses Node's Request in tests. Keep its matching AbortSignal
// instead of mixing the Node fetch implementation with jsdom's signal.
const dom = builtinEnvironments.jsdom;
export default {
  ...dom,
  name: "admin-dom",
  async setup(global, options) {
    const controller = global.AbortController;
    const signal = global.AbortSignal;
    const environment = await dom.setup(global, options);
    global.AbortController = controller;
    global.AbortSignal = signal;
    return environment;
  },
} satisfies Environment;

/* global module */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-leadcatch-to-quickbook",
      comment: "LeadCatch bot must not import from QuickBook bot",
      severity: "error",
      from: {
        path: "^apps/server/src/bots/leadcatch",
      },
      to: {
        path: "^apps/server/src/bots/quickbook",
      },
    },
    {
      name: "no-quickbook-to-leadcatch",
      comment: "QuickBook bot must not import from LeadCatch bot",
      severity: "error",
      from: {
        path: "^apps/server/src/bots/quickbook",
      },
      to: {
        path: "^apps/server/src/bots/leadcatch",
      },
    },
    {
      name: "no-admin-to-server",
      comment: "Admin frontend must not import backend server code directly",
      severity: "error",
      from: {
        path: "^apps/admin",
      },
      to: {
        path: "^apps/server",
      },
    },
    {
      name: "no-circular",
      comment: "Circular dependencies are forbidden",
      severity: "error",
      from: {},
      to: {
        circular: true,
      },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: "./tsconfig.base.json",
    },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
      extensions: [".ts", ".tsx", ".js", ".jsx"],
    },
  },
};

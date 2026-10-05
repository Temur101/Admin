import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_DIR = join(process.cwd(), "apps/server/src");
const ALLOWED_ADAPTERS_DIR = join(SRC_DIR, "adapters");

interface Violation {
  file: string;
  line: number;
  reason: string;
  code: string;
}

const FORBIDDEN_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  {
    regex: /\bfake[A-Z0-9_]\w*\s*=/i,
    reason: "Strict Anti-Mock Policy: Fake data variables (fakeLeads, fakeUsers, etc.) are strictly forbidden.",
  },
  {
    regex: /\bmock[A-Z0-9_]\w*\s*=/i,
    reason: "Strict Anti-Mock Policy: Mocks are forbidden in business logic. Mocks can only live in adapters/ behind interface.",
  },
  {
    regex: /setTimeout\s*\(\s*(?:async\s*)?\(\s*\)\s*=>.*(?:resolve|db|database|lead|booking)/is,
    reason: "Strict Anti-Mock Policy: setTimeout database/API simulation is forbidden.",
  },
  {
    regex: /\/\/\s*TODO:\s*(?:допишите|реализуйте|implement)/i,
    reason: "Code Standards: Incomplete TODO placeholders are forbidden.",
  },
];

function scanDirectory(dir: string, violations: Violation[]) {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      scanDirectory(fullPath, violations);
      continue;
    }

    if (!fullPath.endsWith(".ts") && !fullPath.endsWith(".tsx")) {
      continue;
    }

    const isAdapter = fullPath.startsWith(ALLOWED_ADAPTERS_DIR);
    const content = readFileSync(fullPath, "utf-8");
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i] ?? "";
      for (const rule of FORBIDDEN_PATTERNS) {
        if (isAdapter && rule.reason.includes("Mocks can only live in adapters")) {
          continue;
        }

        if (rule.regex.test(lineText)) {
          violations.push({
            file: relative(process.cwd(), fullPath),
            line: i + 1,
            reason: rule.reason,
            code: lineText.trim(),
          });
        }
      }
    }
  }
}

const violations: Violation[] = [];
scanDirectory(SRC_DIR, violations);

if (violations.length > 0) {
  console.error("\n❌ STRICT ANTI-MOCK & CODE INTEGRITY VIOLATIONS FOUND:");
  for (const v of violations) {
    console.error(`  - ${v.file}:${v.line} -> ${v.reason}`);
    console.error(`    Code: ${v.code}`);
  }
  process.exit(1);
} else {
  console.log("✅ Anti-Mock & Code Integrity check passed: 0 violations.");
}

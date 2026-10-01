const fs = require("fs");

const source = fs.readFileSync("scripts/main.js", "utf8")
  .replace("const CREATURE_INDEX_TIMEOUT_MS = 3000;", "const CREATURE_INDEX_TIMEOUT_MS = 50;");
const instrumented = source.replace(
  /\}\)\(\);\s*$/,
  "globalThis.__xpToolTest = { loadCreatureCandidates }; })();"
);

if (instrumented === source) throw new Error("Could not expose loader test seam");

globalThis.foundry = { appv1: { api: { Dialog: class {} } }, utils: { getProperty: () => 0, deepClone: value => value } };
globalThis.Hooks = { once() {}, on() {} };
globalThis.game = {
  i18n: { lang: "en" },
  packs: {
    filter(predicate) {
      return [{ documentName: "Actor", getIndex: () => new Promise(() => {}) }].filter(predicate);
    }
  }
};

new Function(instrumented)();

(async () => {
  const verdict = await Promise.race([
    globalThis.__xpToolTest.loadCreatureCandidates().then(() => "settled"),
    new Promise(resolve => setTimeout(() => resolve("timeout"), 500))
  ]);
  if (verdict !== "settled") {
    console.error("FAIL: creature candidate loading can remain pending forever");
    process.exitCode = 1;
    return;
  }
  console.log("PASS: creature candidate loading settles when one pack stalls");
})();

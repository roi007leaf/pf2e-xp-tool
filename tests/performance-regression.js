const fs = require("fs");
const { performance } = require("perf_hooks");

const source = fs.readFileSync("scripts/main.js", "utf8");
const instrumented = source.replace(
  /\}\)\(\);\s*$/,
  "globalThis.__xpPerfTest = { buildAdjustPlans, buildCompositePlans, buildFillPlans }; })();"
);
if (instrumented === source) throw new Error("Could not expose performance test seam");

globalThis.foundry = { appv1: { api: { Dialog: class {} } }, utils: { deepClone: value => value } };
globalThis.Hooks = { once() {}, on() {} };
globalThis.game = { pf2e: { gm: { calculateXP() { return {}; } } } };
new Function(instrumented)();

const adjustmentOptions = [];
for (let npcIdx = 0; npcIdx < 18; npcIdx++) {
  adjustmentOptions.push({ npcIdx, npcName: `NPC ${npcIdx}`, toAdj: "weak", deltaXP: -10 });
  adjustmentOptions.push({ npcIdx, npcName: `NPC ${npcIdx}`, toAdj: "elite", deltaXP: 20 });
}
const removalOptions = [
  { level: 6, delta: 3, xp: 120, maxCount: 1 },
  { level: 4, delta: 1, xp: 60, maxCount: 1 },
  { level: 3, delta: 0, xp: 40, maxCount: 2 },
  { level: 2, delta: -1, xp: 30, maxCount: 1 },
  { level: 1, delta: -2, xp: 20, maxCount: 2 },
  { level: 0, delta: -3, xp: 15, maxCount: 11 }
];

const start = performance.now();
const fills = globalThis.__xpPerfTest.buildFillPlans(395, removalOptions);
const afterFills = performance.now();
const adjustmentPlans = globalThis.__xpPerfTest.buildAdjustPlans(-395, adjustmentOptions, 5, 8);
const afterAdjust = performance.now();
globalThis.__xpPerfTest.buildCompositePlans(-395, adjustmentOptions, fills, false, 4, 8);
const afterComposite = performance.now();

const timings = {
  fill: Math.round(afterFills - start),
  adjust: Math.round(afterAdjust - afterFills),
  composite: Math.round(afterComposite - afterAdjust),
  total: Math.round(afterComposite - start)
};
for (const plan of [...adjustmentPlans.exact, ...adjustmentPlans.near]) {
  const npcIds = plan.picked.map(option => option.npcIdx);
  if (new Set(npcIds).size !== npcIds.length) {
    throw new Error("Optimized adjustment plan changes one enemy more than once");
  }
}
console.log(JSON.stringify(timings));
if (timings.total > 250) throw new Error(`18-enemy plan generation too slow: ${timings.total}ms`);
console.log("PASS: 18-enemy plan generation remains responsive");

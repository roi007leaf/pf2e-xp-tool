const fs = require("fs");

const source = fs.readFileSync("scripts/main.js", "utf8");
const instrumented = source.replace(
  /\}\)\(\);\s*$/,
  "globalThis.__xpDifficultyTest = { encounterBudgetsForParty, calculateXP }; })();"
);
if (instrumented === source) throw new Error("Could not expose difficulty-budget test seam");

globalThis.foundry = { appv1: { api: { Dialog: class {} } }, utils: { deepClone: value => value } };
globalThis.Hooks = { once() {}, on() {} };
globalThis.game = {
  pf2e: {
    gm: {
      calculateXP() {
        return { encounterBudgets: { trivial: 50, low: 75, moderate: 100, severe: 150, extreme: 200 } };
      }
    }
  }
};

new Function(instrumented)();

const five = globalThis.__xpDifficultyTest.encounterBudgetsForParty(5);
const expected = { trivial: 50, low: 80, moderate: 100, severe: 150, extreme: 200 };
for (const [difficulty, budget] of Object.entries(expected)) {
  if (five[difficulty] !== budget) {
    throw new Error(`Expected five-player ${difficulty} budget ${budget}; received ${five[difficulty]}`);
  }
}

const wrapped = globalThis.__xpDifficultyTest.calculateXP(3, 5, [0, 1, 3], [], false);
if (wrapped.encounterBudgets.low !== 80) {
  throw new Error(`Foundry proportional Low budget leaked through wrapper: ${wrapped.encounterBudgets.low}`);
}

const four = globalThis.__xpDifficultyTest.encounterBudgetsForParty(4);
if (four.low !== 60 || four.moderate !== 80) {
  throw new Error(`Four-player base budgets changed: ${JSON.stringify(four)}`);
}

console.log("PASS: difficulty budgets use GM Core character adjustments");

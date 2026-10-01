const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync("scripts/main.js", "utf8");
const instrumented = source
  .replace("    showXPTool({", "    globalThis.__captureTool({")
  .replace(/\}\)\(\);\s*$/, "globalThis.__emptyEncounterTest = { openFromSelection, renderNpcSection }; })();");
assert.notEqual(instrumented, source);

const dialogs = [];
globalThis.foundry = { appv1: { api: { Dialog: class {
  constructor(data) { this.data = data; dialogs.push(this); }
  render() { return this; }
} } } };
globalThis.Hooks = { once() {}, on() {} };
globalThis.game = { user: { isGM: true }, i18n: { localize: key => key, format: key => key } };
globalThis.ui = { notifications: { error() { throw new Error("Selection should not be required"); }, warn() {} } };
globalThis.localStorage = { getItem() { return null; }, setItem() {} };
globalThis.canvas = { tokens: { controlled: [] } };
let opened;
globalThis.__captureTool = state => { opened = state; };
new Function(instrumented)();

function confirmParty() {
  dialogs.at(-1).data.buttons.yes.callback({ querySelector(selector) {
    return { value: selector.includes("party-size") ? "4" : "5" };
  } });
}

globalThis.__emptyEncounterTest.openFromSelection();
assert.equal(dialogs.length, 1);
confirmParty();
assert.equal(opened.targetMode, "moderate");
assert.deepEqual(opened.npcs, []);
assert.deepEqual(opened.hazards, []);
const previewHtml = globalThis.__emptyEncounterTest.renderNpcSection({
  npcs: [], hazards: [], previewEntities: [
    { action: "add", kind: "creature", name: "Book Beast", level: 6, xp: 60, count: 1, uuid: "test.book-beast" },
    { action: "add", kind: "creature", name: "Curseling", level: 2, xp: 20, count: 2, uuid: "test.curseling" },
  ],
});
assert.match(previewHtml, /Book Beast/);
assert.match(previewHtml, /Curseling/);
assert.match(previewHtml, /data-creature-uuid="test\.book-beast"/);
assert.doesNotMatch(previewHtml, /No opposition or hazard token selected/);

canvas.tokens.controlled = [{ actor: { id: "enemy", name: "Enemy", alliance: "opposition", type: "npc", level: 5 } }];
globalThis.__emptyEncounterTest.openFromSelection();
confirmParty();
assert.equal(opened.targetMode, "baseline");
assert.equal(opened.npcs.length, 1);

console.log("PASS: tool opens without selected enemies and starts empty encounters at Moderate");

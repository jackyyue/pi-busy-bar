/**
 * 实时周期性验证：让扩展按真实定时器跑 6 秒（60 帧），
 * 逐帧采样渲染结果，断言"每 12 帧回到同一画面"，
 * 并统计一个周期内到底有几种不同画面。
 */

import { fileURLToPath, pathToFileURL } from "node:url";

const EXT = fileURLToPath(new URL("./pi-busy-bar.ts", import.meta.url));
const PI_TUI = pathToFileURL(
	"C:/nvm/v22.22.0/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js",
).href;
const JITI = pathToFileURL(
	"C:/nvm/v22.22.0/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs",
).href;

const { visibleWidth } = await import(PI_TUI);
const { createJiti } = await import(JITI);
const factory = (await createJiti(import.meta.url).import(EXT)).default;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const handlers = new Map();
const pi = {
	on(e, h) {
		if (!handlers.has(e)) handlers.set(e, []);
		handlers.get(e).push(h);
	},
	registerCommand() {},
};
let component = null;
let renderRequests = 0;
const theme = { name: "dark", getColorMode: () => "truecolor" };
const ctx = {
	mode: "tui",
	hasUI: true,
	isIdle: () => false,
	ui: {
		theme,
		notify() {},
		setWidget(_key, content) {
			component = content === undefined ? null : content({ requestRender: () => renderRequests++ }, theme);
		},
	},
};

factory(pi);
for (const h of handlers.get("agent_start") || []) await h({}, ctx);

const FRAME_MS = 100;
const CYCLE = 12;
const SAMPLES = 60;
const samples = [];
const started = Date.now();
for (let i = 0; i < SAMPLES; i++) {
	samples.push(component.render(80)[0]);
	await sleep(FRAME_MS);
}
const elapsed = Date.now() - started;

for (const h of handlers.get("agent_settled") || []) await h({}, ctx);

const widthsOk = samples.every((s) => visibleWidth(s) === 80);
const periodic = samples.every((s, i) => (i < CYCLE ? true : s === samples[i - CYCLE]));
const perCycle = new Set(samples.slice(0, CYCLE)).size;
const distinctTotal = new Set(samples).size;
const requestsOk = renderRequests >= SAMPLES - 2;

console.log(`采样 ${SAMPLES} 帧，耗时 ${elapsed}ms（预期约 ${SAMPLES * FRAME_MS}ms）`);
console.log(`- 每帧宽度都等于 80: ${widthsOk}`);
console.log(`- 每 12 帧回到同一画面: ${periodic}`);
console.log(`- 一个周期内有 ${perCycle} 种不同画面（理论上限 12）`);
console.log(`- 6 秒内共出现 ${distinctTotal} 种画面`);
console.log(`- 定时器请求重绘次数 ${renderRequests}，与帧数匹配: ${requestsOk}`);

const failed = !widthsOk || !periodic || !requestsOk || perCycle < 10;
console.log(failed ? "\n结论：失败" : "\n结论：全部通过");
process.exit(failed ? 1 : 0);

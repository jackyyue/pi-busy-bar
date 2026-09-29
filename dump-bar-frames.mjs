/**
 * 生成 pi-busy-bar 的观感样张。
 *
 * 用扩展真实组件（jiti 加载）在真彩/256 色、深色/浅色主题下渲染，
 * 把字形密度视图落成文本，方便核对"渐变形状"是否符合预期。
 * 颜色本身只能在终端里看，这里只留密度形状。
 */

import { writeFileSync } from "node:fs";
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
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

function makeHarness(themeName, colorMode) {
	const handlers = new Map();
	const pi = {
		on(e, h) {
			if (!handlers.has(e)) handlers.set(e, []);
			handlers.get(e).push(h);
		},
		registerCommand() {},
	};
	let component = null;
	const theme = { name: themeName, getColorMode: () => colorMode };
	const ctx = {
		mode: "tui",
		hasUI: true,
		isIdle: () => false,
		ui: {
			theme,
			notify() {},
			setWidget(_key, content) {
				if (content === undefined) {
					component = null;
					return;
				}
				component = content({ requestRender() {} }, theme);
			},
		},
	};
	return {
		pi,
		ctx,
		render: (w) => component.render(w)[0],
		async fire(e) {
			for (const h of handlers.get(e) || []) await h({}, ctx);
		},
	};
}

async function capture(themeName, colorMode, width, frames) {
	const h = makeHarness(themeName, colorMode);
	factory(h.pi);
	await h.fire("agent_start");
	const out = [];
	for (let i = 0; i < frames; i++) {
		out.push({ i, raw: h.render(width), plain: stripAnsi(h.render(width)) });
		await sleep(100);
	}
	await h.fire("agent_settled");
	return out;
}

const lines = [];
lines.push("# pi-busy-bar 观感样张（字形密度视图；颜色只能在终端里看）");
lines.push("# 生成方式：加载真实扩展组件，按真实定时器逐帧采样");
lines.push("");

const dark = await capture("dark", "truecolor", 80, 12);
lines.push("## 深色主题 / 真彩，宽度 80，12 帧 = 一个完整周期（100ms/帧）");
for (const f of dark) lines.push(`帧${String(f.i).padStart(2, "0")} |${f.plain}|`);
lines.push("");
lines.push("宽度连续性检查（样张内逐帧核对，末列位置代表终端右边界）");
const widthsOk = dark.every((f) => visibleWidth(f.raw) === 80);
lines.push(`- 12 帧渲染宽度均等于 80: ${widthsOk}`);
lines.push("");

lines.push("## 宽度自适应（同一相位 0，只取第 1 帧的形状按不同宽度截取）");
const hw = makeHarness("dark", "truecolor");
factory(hw.pi);
await hw.fire("agent_start");
for (const w of [10, 20, 40, 60]) {
	const raw = hw.render(w);
	lines.push(`宽${String(w).padStart(2)} |${stripAnsi(raw)}|  visibleWidth=${visibleWidth(raw)}`);
}
await hw.fire("agent_settled");
lines.push("");

const c256 = await capture("dark", "256color", 60, 3);
lines.push("## 256 色降级（宽度 60，前 3 帧）");
for (const f of c256) {
	const usesIndexed = /\x1b\[38;5;\d+m/.test(f.raw);
	const usesTrue = /\x1b\[38;2;/.test(f.raw);
	lines.push(`帧${f.i} 用256色码=${usesIndexed} 用真彩色码=${usesTrue}`);
}
lines.push("");

const light = await capture("light", "truecolor", 60, 3);
lines.push("## 浅色主题自动反相（宽度 60，前 3 帧）");
for (const f of light) {
	const grays = [...f.raw.matchAll(/\x1b\[38;2;(\d+);/g)].map((m) => Number(m[1]));
	lines.push(`帧${f.i} 灰度范围 ${Math.min(...grays)}~${Math.max(...grays)}`);
}
lines.push("");
lines.push("## 边界：宽度 1 与 2（不能崩、不能超宽）");
const hb = makeHarness("dark", "truecolor");
factory(hb.pi);
await hb.fire("agent_start");
for (const w of [1, 2, 0, -3]) {
	const raw = hb.render(w);
	lines.push(`宽${String(w).padStart(2)} → 明文长度 ${stripAnsi(raw).length}，visibleWidth ${visibleWidth(raw)}`);
}
await hb.fire("agent_settled");

writeFileSync("D:/05p/pi-busy-bar/frames.txt", lines.join("\n") + "\n", "utf8");
console.log(`样张已写入 D:/05p/pi-busy-bar/frames.txt，共 ${lines.length} 行`);
console.log(`12 帧宽度校验: ${widthsOk ? "通过" : "失败"}`);

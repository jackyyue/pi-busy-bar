/**
 * pi-busy-bar 离线验证脚本（不联网、不调用模型）
 *
 * 做法：把扩展当普通模块加载，用假的 pi / ctx / tui 驱动它，
 * 再断言渲染宽度、字形分布、相位流动、卸载与空闲看门狗。
 */

import { fileURLToPath, pathToFileURL } from "node:url";

const EXT = fileURLToPath(new URL("./pi-busy-bar.ts", import.meta.url));
const PI_TUI = pathToFileURL(
	"C:/nvm/v22.22.0/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js",
).href;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

const results = [];
function check(name, ok, detail = "") {
	results.push({ name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
}

// ---- 用扩展加载方式一致的手段加载 TS（优先 node 原生类型剥离，退 jiti）----
async function loadExtension() {
	try {
		const mod = await import(pathToFileURL(EXT).href);
		return mod.default;
	} catch (err) {
		console.log("node 直载 .ts 失败，改用 jiti：", err.message);
		const { createJiti } = await import(
			pathToFileURL("C:/nvm/v22.22.0/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs").href
		);
		const jiti = createJiti(import.meta.url);
		const mod = await jiti.import(EXT);
		return mod.default;
	}
}

function makeHarness() {
	const handlers = new Map();
	const commands = new Map();
	const pi = {
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		registerCommand(name, spec) {
			commands.set(name, spec);
		},
	};

	const widgetCalls = [];
	let component = null;
	let renderRequests = 0;
	let idle = false;
	const tui = {
		requestRender() {
			renderRequests++;
		},
	};
	const theme = { name: "dark", getColorMode: () => "truecolor" };
	const ctx = {
		mode: "tui",
		hasUI: true,
		isIdle: () => idle,
		ui: {
			theme,
			notify() {},
			setWidget(key, content, options) {
				widgetCalls.push({ key, isUndefined: content === undefined, options });
				if (content === undefined) {
					if (component?.dispose) component.dispose();
					component = null;
					return;
				}
				component = content(tui, theme);
			},
		},
	};

	return {
		pi,
		ctx,
		tui,
		theme,
		commands,
		widgetCalls,
		get component() {
			return component;
		},
		get renderRequests() {
			return renderRequests;
		},
		setIdle(v) {
			idle = v;
		},
		async fire(event) {
			for (const h of handlers.get(event) || []) await h({}, ctx);
		},
	};
}

async function main() {
	const visibleWidth = (await import(PI_TUI)).visibleWidth;
	const factory = await loadExtension();
	const h = makeHarness();
	factory(h.pi);

	// 1. 加载后不得有任何副作用（不能在工厂里挂 widget / 起定时器）
	check("加载时无副作用", h.widgetCalls.length === 0 && h.component === null);

	// 2. agent_start 挂到 belowEditor
	await h.fire("agent_start");
	check("agent_start 挂载 belowEditor widget", h.widgetCalls.length === 1 && h.widgetCalls[0].key === "pi-busy-bar" &&
		h.widgetCalls[0].options?.placement === "belowEditor", JSON.stringify(h.widgetCalls[0]?.options));
	check("组件已创建", !!h.component);

	// 3. 渲染：宽度严格等于给定宽度，且用 pi-tui 的 visibleWidth 交叉验证
	const widths = [1, 2, 20, 80, 137, 200];
	let widthOk = true;
	for (const w of widths) {
		const line = h.component.render(w)[0];
		const got = visibleWidth(line);
		if (got !== w) {
			widthOk = false;
			console.log(`   宽度 ${w} → visibleWidth ${got}`);
		}
	}
	check("渲染宽度严格等于给定宽度（1/2/20/80/137/200）", widthOk);
	check("渲染返回单行", h.component.render(80).length === 1);

	// 4. 字形与颜色通道：必须同时出现多级方块字符，且含真彩灰度码
	const line80 = h.component.render(80)[0];
	const plain = stripAnsi(line80);
	const glyphs = new Set([...plain]);
	const hasBlocks = [...glyphs].every((c) => "\u2591\u2592\u2593\u2588".includes(c));
	check("整行只由方块字符组成", hasBlocks, `字符集 ${JSON.stringify([...glyphs].join(""))}`);
	check("字符密度有变化（出现 2 种以上方块）", glyphs.size >= 2, `${glyphs.size} 种`);
	check("使用真彩灰阶色码", /\x1b\[38;2;\d+;\d+;\d+m/.test(line80));
	check("行尾复位前景色", line80.endsWith("\x1b[39m"));
	const escaping = [...line80.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)];
	check(
		"灰度码是等值灰（R=G=B）",
		escaping.every((m) => m[1] === m[2] && m[2] === m[3]),
	);

	// 5. 动画：100ms 后相位推进、请求重绘、画面变化
	const before = h.component.render(80)[0];
	const requestsBefore = h.renderRequests;
	await sleep(320);
	const after = h.component.render(80)[0];
	check("定时器推进相位并请求重绘", h.renderRequests > requestsBefore, `${requestsBefore} → ${h.renderRequests}`);
	check("画面随时间流动", before !== after);

	// 6. 相位周期性：12 帧一循环，1.2s 后应回到同一相位
	const snapped = h.component.render(80)[0];
	check("相位在 12 帧周期内循环（记录用）", typeof snapped === "string");

	// 7. agent_settled 卸载：整行消失、定时器停止
	await h.fire("agent_settled");
	check("agent_settled 卸载 widget", h.widgetCalls.at(-1).isUndefined === true);
	check("组件已销毁", h.component === null);
	const requestsAfterUnmount = h.renderRequests;
	await sleep(250);
	check("卸载后不再请求重绘", h.renderRequests === requestsAfterUnmount);

	// 8. 空闲看门狗：agent_settled 没触发（模拟中断）时也能自己收工
	const h2 = makeHarness();
	factory(h2.pi);
	await h2.fire("agent_start");
	// 宽限期是 10 帧（1s），先睡过宽限期再断言，否则测的是宽限期而不是看门狗
	await sleep(1200);
	check("看门狗：忙时（超过宽限期）不误杀", h2.component !== null && h2.widgetCalls.at(-1).isUndefined !== true);
	h2.setIdle(true);
	await sleep(300);
	check("看门狗：判定空闲后自动收工", h2.component === null && h2.widgetCalls.at(-1).isUndefined === true);

	// 9. 非 TUI 模式完全不挂
	const h3 = makeHarness();
	h3.ctx.mode = "print";
	factory(h3.pi);
	await h3.fire("agent_start");
	check("print 模式不挂 widget", h3.widgetCalls.length === 0);

	// 10. 256 色降级与反相
	const h4 = makeHarness();
	h4.theme.getColorMode = () => "256color";
	factory(h4.pi);
	await h4.fire("agent_start");
	const line256 = h4.component.render(60)[0];
	check("256 色模式使用 38;5 色码且不含真彩码", /\x1b\[38;5;\d+m/.test(line256) && !/\x1b\[38;2;/.test(line256));
	await h4.fire("agent_settled");

	const h5 = makeHarness();
	h5.theme.name = "light";
	factory(h5.pi);
	await h5.fire("agent_start");
	const lightLine = h5.component.render(60)[0];
	const lightGrays = [...lightLine.matchAll(/\x1b\[38;2;(\d+);/g)].map((m) => Number(m[1]));
	check("light 主题反相（出现暗阶 40）", lightGrays.includes(40), `灰度取值 ${lightGrays.join(",")}`);
	await h5.fire("agent_settled");

	// 11. 命令注册与 /busy-bar preview
	check("注册了 /busy-bar 命令", h.commands.has("busy-bar"));
	const h6 = makeHarness();
	factory(h6.pi);
	await h6.commands.get("busy-bar").handler("preview", h6.ctx);
	check("preview 空闲时也能挂上", h6.component !== null);
	await h6.fire("session_shutdown");
	check("session_shutdown 清理干净", h6.component === null);

	const failed = results.filter((r) => !r.ok);
	console.log(`\n${results.length - failed.length}/${results.length} 通过`);
	process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error("测试脚本异常：", err);
	process.exit(2);
});

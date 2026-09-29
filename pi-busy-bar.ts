/**
 * pi Busy Bar — 底部方块亮度渐变长条
 *
 * 任务执行期间（agent_start）在编辑器下方显示一行满宽的方块渐变长条并持续流动，
 * 任务结束后（agent_settled）整行消失。设计详见 D:\05p\pi-busy-bar\方案.md。
 *
 * 不依赖任何 npm 包：只用 ctx.ui.setWidget 的组件通道 + 自绘 ANSI 色码，
 * 所以不需要 import @earendil-works/pi-tui（用户扩展目录不保证能解析到它）。
 *
 * 命令：
 *   /busy-bar           显示当前状态
 *   /busy-bar preview   空闲时也强制演示 3 秒（用于调参）
 *   /busy-bar invert    强制反相（亮底终端）
 *   /busy-bar reset     恢复自动判断
 */

const WIDGET_KEY = "pi-busy-bar";

/** 帧间隔（毫秒）。调大 = 更省重绘、更不容易留残影。 */
const FRAME_MS = 100;
/** 一个完整流动周期包含的帧数。 */
const FRAMES_PER_CYCLE = 12;
/** 同屏亮带数量。 */
const BANDS = 2;
/** 亮度量化级数。 */
const LEVELS = 8;

/** 每级对应的字形，与灰度同步单调递增。 */
const GLYPHS = ["\u2591", "\u2591", "\u2592", "\u2592", "\u2593", "\u2593", "\u2588", "\u2588"];
/** 每级对应的真彩灰度值。 */
const GRAY_RGB = [40, 62, 88, 118, 150, 186, 222, 255];
/** 每级对应的 256 色索引。 */
const GRAY_256 = [232, 235, 238, 241, 245, 249, 252, 255];

const RESET_FG = "\x1b[39m";

/** 启动后多少帧内不做空闲看门狗判定，避开 agent_start 与运行标志之间的时序差。 */
const WATCHDOG_GRACE_FRAMES = 10;
/** 连续多少帧观测到空闲才收工，防抖。 */
const WATCHDOG_IDLE_FRAMES = 2;
/** /busy-bar preview 的演示时长。 */
const PREVIEW_MS = 3000;

function detectTrueColor(theme: any): boolean {
	try {
		if (theme && typeof theme.getColorMode === "function") {
			return theme.getColorMode() !== "256color";
		}
	} catch {
		// 探测失败时按方案决策 5A 假定真彩（Windows Terminal）。
	}
	return true;
}

function detectInvert(theme: any, override: boolean | null): boolean {
	if (override !== null) return override;
	const name = theme && typeof theme.name === "string" ? theme.name : "";
	return /light/i.test(name);
}

function colorFor(level: number, trueColor: boolean, invert: boolean): string {
	const i = invert ? LEVELS - 1 - level : level;
	if (trueColor) {
		const v = GRAY_RGB[i];
		return `\x1b[38;2;${v};${v};${v}m`;
	}
	return `\x1b[38;5;${GRAY_256[i]}m`;
}

/** 生成一整行：宽度严格等于 width，逐格同色段合并输出，行尾复位前景色。 */
function buildLine(width: number, phase: number, trueColor: boolean, invert: boolean): string {
	if (!Number.isFinite(width) || width <= 0) return "";
	let line = "";
	let runLevel = -1;
	let runGlyphs = "";
	for (let x = 0; x < width; x++) {
		const u = width > 1 ? x / (width - 1) : 0;
		const wave = 0.5 + 0.5 * Math.cos(2 * Math.PI * (BANDS * u - phase / FRAMES_PER_CYCLE));
		const level = Math.round(wave * wave * (LEVELS - 1));
		if (level !== runLevel) {
			if (runLevel >= 0) line += colorFor(runLevel, trueColor, invert) + runGlyphs;
			runLevel = level;
			runGlyphs = "";
		}
		runGlyphs += GLYPHS[level];
	}
	if (runLevel >= 0) line += colorFor(runLevel, trueColor, invert) + runGlyphs;
	return line + RESET_FG;
}

export default function (pi: any) {
	let timer: ReturnType<typeof setInterval> | null = null;
	let previewTimer: ReturnType<typeof setTimeout> | null = null;
	let requestRender: (() => void) | null = null;
	let phase = 0;
	let tickCount = 0;
	let idleFrames = 0;
	let busy = false;
	let previewing = false;
	let invertOverride: boolean | null = null;
	let activeCtx: any = null;

	function isTui(ctx: any): boolean {
		return !!ctx && ctx.mode === "tui" && !!ctx.ui && typeof ctx.ui.setWidget === "function";
	}

	function startTimer(): void {
		if (timer !== null) return;
		timer = setInterval(onTick, FRAME_MS);
		// unref：不让动画计时器独自拖住进程退出。
		if (timer && typeof (timer as any).unref === "function") (timer as any).unref();
	}

	function stopTimer(): void {
		if (timer === null) return;
		clearInterval(timer);
		timer = null;
	}

	function stopPreview(): void {
		if (previewTimer === null) return;
		clearTimeout(previewTimer);
		previewTimer = null;
		previewing = false;
	}

	function mount(ctx: any): void {
		if (!isTui(ctx)) return;
		activeCtx = ctx;
		try {
			ctx.ui.setWidget(
				WIDGET_KEY,
				(tui: any, theme: any) => {
					requestRender = tui && typeof tui.requestRender === "function" ? () => tui.requestRender() : null;
					let trueColor = detectTrueColor(theme);
					let invert = detectInvert(theme, invertOverride);
					return {
						render(width: number): string[] {
							return [buildLine(width, phase, trueColor, invert)];
						},
						invalidate(): void {
							// 主题切换后重建颜色判定，避免留下旧的 ANSI 色码。
							trueColor = detectTrueColor(theme);
							invert = detectInvert(theme, invertOverride);
						},
						dispose(): void {
							requestRender = null;
						},
					};
				},
				{ placement: "belowEditor" },
			);
		} catch (err) {
			// 老版本 pi 可能没有 setWidget：静默降级，不影响会话。
			activeCtx = null;
			requestRender = null;
			console.warn("[pi-busy-bar] setWidget 失败：", err instanceof Error ? err.message : String(err));
		}
	}

	function unmount(ctx: any): void {
		stopTimer();
		stopPreview();
		busy = false;
		phase = 0;
		tickCount = 0;
		idleFrames = 0;
		requestRender = null;
		const target = isTui(ctx) ? ctx : isTui(activeCtx) ? activeCtx : null;
		activeCtx = null;
		if (!target) return;
		try {
			target.ui.setWidget(WIDGET_KEY, undefined);
		} catch {
			// 卸载失败不影响会话，兜底交给 session_shutdown。
		}
	}

	function start(ctx: any): void {
		if (!isTui(ctx)) return;
		stopTimer();
		busy = true;
		phase = 0;
		tickCount = 0;
		idleFrames = 0;
		mount(ctx);
		startTimer();
	}

	function onTick(): void {
		phase = (phase + 1) % FRAMES_PER_CYCLE;
		tickCount += 1;
		if (requestRender) requestRender();
		if (previewing) return;
		// 空闲看门狗：万一 agent_settled 未触发（中断、异常路径），靠它兜底收工。
		if (tickCount <= WATCHDOG_GRACE_FRAMES) return;
		if (!activeCtx || typeof activeCtx.isIdle !== "function") return;
		let idle = false;
		try {
			idle = !!activeCtx.isIdle();
		} catch {
			idle = false;
		}
		idleFrames = idle ? idleFrames + 1 : 0;
		if (idleFrames >= WATCHDOG_IDLE_FRAMES) unmount(activeCtx);
	}

	function describe(): string {
		return `pi-busy-bar：${busy ? "运行中" : "空闲"}，相位 ${phase}/${FRAMES_PER_CYCLE}，${
			invertOverride === null ? "自动配色" : invertOverride ? "强制反相" : "强制正相"
		}`;
	}

	pi.on("session_start", async (_event: unknown, ctx: any) => {
		unmount(ctx);
	});

	pi.on("agent_start", async (_event: unknown, ctx: any) => {
		start(ctx);
	});

	pi.on("agent_settled", async (_event: unknown, ctx: any) => {
		unmount(ctx);
	});

	pi.on("session_shutdown", async (_event: unknown, ctx: any) => {
		unmount(ctx);
	});

	pi.registerCommand("busy-bar", {
		description: "查看/调整底部忙碌长条：status、preview、invert、reset",
		handler: async (args: string, ctx: any) => {
			const arg = String(args || "").trim().toLowerCase();
			if (arg === "invert" || arg === "reset") {
				invertOverride = arg === "invert" ? true : null;
				if (busy) mount(ctx); // 重建组件以应用新配色
			} else if (arg === "preview") {
				if (!isTui(ctx)) {
					ctx.ui?.notify?.("busy-bar：当前模式没有 TUI", "info");
					return;
				}
				stopPreview();
				previewing = true;
				start(ctx);
				previewTimer = setTimeout(() => {
					previewing = false;
					previewTimer = null;
					unmount(ctx);
				}, PREVIEW_MS);
				if (previewTimer && typeof (previewTimer as any).unref === "function") (previewTimer as any).unref();
			} else if (arg !== "") {
				ctx.ui?.notify?.("用法：/busy-bar [preview|invert|reset]", "error");
				return;
			}
			ctx.ui?.notify?.(describe(), "info");
		},
	});
}
